# Руководство

**Русский** · [English](guide.en.md) · [README](../README.md)

## Подключение и авторизация

```ts
const db = await YdbClient.connect({
  connectionString: process.env.YDB_CONNECTION_STRING ?? '',
  logger: (level, event, details) => appLogger[level]({event, ...details}),
});
```

`connectionString` разбирает официальный SDK: поддерживаются путь
`grpc(s)://host:port/database` и параметр `grpc(s)://host:port/?database=/database`.
Передаётся явно: библиотека не выбирает стенд, профиль `yc` или секреты приложения.
`driverOptions` передаются официальному `Driver`: можно задать собственный credentials
provider, TLS и discovery. По умолчанию discovery отключён, ready timeout — 10 секунд.
Причины — [история](history.md); это не универсальная рекомендация для всех кластеров.

По умолчанию используется `EnvironCredentialsProvider` закреплённой версии `@ydbjs/auth`:

1. `YDB_ANONYMOUS_CREDENTIALS=1` — anonymous.
2. `YDB_METADATA_CREDENTIALS=1` — metadata service.
3. `YDB_ACCESS_TOKEN_CREDENTIALS` — access token.
4. `YDB_STATIC_CREDENTIALS_USER` и соответствующая конфигурация SDK — static credentials.
5. Без настроек — anonymous, **не metadata**.

На Cloud Functions задайте `YDB_METADATA_CREDENTIALS=1` и права сервисного аккаунта на базу.
Ключ сервисного аккаунта автоматически из старой v5-переменной пакет не загружает:
для других методов используйте соответствующий provider официального SDK через `driverOptions`.
Секреты не передавайте в argv и не сохраняйте в git.

TLS-настройки окружения читает SDK, включая `YDB_SSL_ROOT_CERTIFICATES_FILE`,
`NODE_EXTRA_CA_CERTS`, строковые сертификаты и client certificate/key. Дополнительный
CA объединяется с `tls.rootCertificates`. Ошибка чтения CA не скрывается.
Переданный CA **расширяет доверие** системных корней, а не создаёт изолированный trust store.
TLS-опции могут включить TLS даже для `grpc://`: не наследуйте облачные сертификаты в локальном стенде.
В локальном примере explicit anonymous provider исключает автоматическое чтение auth/TLS окружения.

Создавайте один клиент на процесс/контейнер; `connect()` не является singleton.
При завершении вызывайте `await db.close()`: отменяются операции клиента, освобождается
query pool, удаляется diagnostics-подписка и закрывается driver. Повторный `close()` допустим.
Во время обычного запроса Cloud Function клиент не закрывают: он переиспользуется в тёплом контейнере.

## Запросы

```ts
await db.execute('UPSERT INTO items (id) VALUES ($id)', {
  $id: ydb.required.uint64(42n),
}); // По умолчанию write: без hedge и без idempotent retry.

const result = await db.execute('SELECT * FROM items WHERE id = $id', {
  $id: ydb.required.uint64(42n),
}, {mode: 'read', label: 'items.byId', timeoutMs: 9000, hedge: false});
```

`resultSets` — массив наборов строк SDK, без потери bigint. Для передачи JSON по HTTP
выберите преобразование bigint в своём приложении; `JSON.stringify` не сериализует его автоматически.
Пакет не обещает статическую типизацию произвольного SQL-результата.

Параметры передаются отдельно; не интерполируйте пользовательские значения в текст YQL.
`DECLARE` вручную не нужен: его добавляет Query SDK по типу параметра.
`label` — диагностическая метка. Пакет не хранит реестр меток и текстов запросов.

`mode: 'read'` разрешает SDK idempotent retry и hedge. Ответственность за отсутствие
побочных эффектов лежит на вызывающем коде; пакет не разбирает SQL для доказательства безопасности.
По умолчанию запись имеет бюджет 8 с, чтение — 9 с. `signal` отменяет операцию;
таймаут отменяет RPC, а не только ожидание JavaScript Promise.

### Hedge

У явного чтения hedge включён по умолчанию: через 1 с запускается SQL-копия с префиксом
`/* hedge */`. Отключение — `hedge: false`; настройка — `hedge: {delayMs: 1000}`.
Задержка должна быть положительной и меньше `timeoutMs`; у копии остаётся остаток бюджета.

Побеждает первый успешный результат, после чего вызывается отмена проигравшей попытки. Если основная
упала до запуска копии — ошибка сразу наружу. После запуска копии ждём её результат;
если упали обе — возвращаем ошибку основной. Промах резервного ключа не подменяет исходную ошибку.
Два чтения не являются одной snapshot-транзакцией.
В экспортированном `raceWithHedge` функция `cancel()` синхронная;
её исключение не скрывает успешный результат победителя.

## Параметры и типы

`ydb.required` и `ydb.optional`: `utf8`, `int32`, `int64`, `uint32`, `uint64`,
`double`, `bool`, `timestamp`, `json`, `jsonDocument`.

- required отклоняет отсутствующее значение; optional сохраняет тип даже для null.
- Int64/Uint64 принимают `bigint` или безопасный целый `number`; диапазон проверяется.
- JSON-хелперы принимают JS-значение, `TypedValues.json/jsonDocument` — JSON-строку.
- timestamp принимает `Date`.
- `TypedValues.list(Types.struct({...}), rows)` создаёт List/Struct-параметр.
- Неизвестные значения List/Struct проверяются до отправки; строка `"false"` не принимается как Bool.
- Пустой List отклоняется, в том числе вложенный: SDK выводит тип из первого элемента.
- `Types.optional`, `Types.list`, `Types.struct` создают составные типы.
- `isPreconditionFailed(error)` проверяет код `PRECONDITION_FAILED`, не текст сообщения.

Прямые фабрики SDK остаются доступны из самого `@ydbjs/value` для остальных типов.

## Table API

```ts
const keyRead = {
  table: 'items', key: {id: ydb.required.uint64(42n)}, columns: ['id', 'title'],
};
await db.readRow(keyRead, {hedge: false});
await db.execute('SELECT id, title FROM items WHERE id = $id', {
  $id: ydb.required.uint64(42n),
}, {mode: 'read', hedge: {keyRead}});
await db.bulkUpsert('items', {id: ydb.required.uint64(42n), title: ydb.optional.utf8('Example')});
```

- `readRow` использует ReadRows, возвращает `{resultSets: [rows]}`. Отсутствие строки — пустой массив.
- `hedge.keyRead` использует StreamReadTable по диапазону `[K, K]` вместо SQL-копии.
- Указывайте **полный PK в порядке ключевых колонок**, с правильными типами и одинаковой проекцией SQL/Table API.
- `expect(row)` превращает отсутствие/несовпадение выведенного ключа в ошибку попытки.
- `bulkUpsert` принимает **одну строку**, без автоматического retry или hedge.
- На проверенном сервере ReadRows отклоняет таблицы со вторичными индексами,
  BulkUpsert — с синхронными индексами. Универсальной совместимости всех версий сервера нет.
- ReadTable может стоить заметно больше RU, чем точечный SQL/ReadRows. Перед включением
  сверьте актуальный тариф/метрики своего стенда; старые измерения не являются тарифной гарантией.
- Поддерживаются простые имена таблиц, без вложенных путей; запросы к внутренним indexImplTable не реализованы.

## Миграции и CLI

```sh
npx ydb-toolkit create create_items --dir database/migrations
npx ydb-toolkit migrate --dir database/migrations
npx ydb-toolkit rollback --dir database/migrations
npx ydb-toolkit types --out src/db/generated.ts --registry database/tables.mjs
```

CLI использует `YDB_CONNECTION_STRING` и официальные auth/TLS-переменные.
Для локальной anonymous-проверки очистите cloud/TLS окружение; затем:

```sh
YDB_CONNECTION_STRING=grpc://localhost:2140/local YDB_ANONYMOUS_CREDENTIALS=1 \
  npx ydb-toolkit migrate --dir examples/local/migrations
```

Файлы `.js`, `.mjs`, `.cjs` применяются по сортировке имени. Создатель использует
timestamp с миллисекундами и `.mjs`, не зависит от `type` потребляющего проекта.
Контракт — `export async function up(db)` / `down(db)`. Пример —
[`001_create_items.mjs`](../examples/local/migrations/001_create_items.mjs).
`db.sql` — официальный QueryClient, включая tagged templates и транзакции для DML.
Реестр `schema_migrations` сохраняет имя только после успешного `up`.
Rollback выбирает последнее применённое имя по сортировке, выполняет `down`, затем удаляет запись.

**Один процесс миграций за раз.** Нет distributed lock/checksum. DDL не транзакционен:
при сбое часть изменений уже могла примениться, а весь `up` будет вызван заново.
Пишите возобновляемые миграции и проверяйте схему; исправленный применённый файл
не будет автоматически выполнен повторно. Rollback — ваш код, не автоматическое восстановление данных.
Для больших DML используйте явный бюджет `.timeout(...)` у `db.sql`.

DDL-хелперы: `createTable`, `dropTable`, `addColumn(s)`, `dropColumn(s)`,
`addIndex`, `dropIndex`, `hasColumn`, `hasIndex`, `dropNotNull`.
`YdbDataTypes` перечисляет поддерживаемые типы; `OPTIONAL_` означает nullable.
Комментарий колонки обязателен для описания миграции, но не сохраняется в схеме YDB.
Автоматической подстановки default value нет. Имена DDL — простые идентификаторы,
а не произвольный пользовательский ввод. Возможность создания unique index зависит от сервера.
`registerTable(registry, table, schema)` и `validateTableSchema(registry, table, columns)`
работают с переданным реестром, не с таблицами исходного приложения.

### dropNotNull

Workaround пересоздаёт колонку через `<column>_tmp`: копирование → удаление старой →
nullable-колонка → обратное копирование → удаление tmp. Состояние сверяется со схемой,
поэтому повторный запуск продолжает после промежуточного сбоя.
Требуются резервная копия, остановка всех записей и отсутствие посторонней колонки с
зарезервированным именем `<column>_tmp`. PK и индексируемые/покрываемые колонки отклоняются.
Возобновляемость не означает атомарность, online-безопасность или автоматический откат NOT NULL.

## Генерация схемы

```ts
import {connect} from '@aderevyankin/ydb-toolkit/migrations';
import {generateTypes} from '@aderevyankin/ydb-toolkit/schema';
const db = await connect({connectionString});
try {
  await generateTypes(db, {out: 'src/db/generated.ts', registry: 'database/tables.mjs'});
} finally {await db.close();}
```

Читаются таблицы корня базы, включая `schema_migrations`; вложенные директории не обходятся.
Имена интерфейсов образуются из имени таблицы без эвристической сингуляризации.
Коллизия имён — ошибка. Имена полей заключены в кавычки.
Встроенные типы квалифицируются через `globalThis`, массивы используют `T[]`,
поэтому интерфейсы `Date`, `Uint8Array` и `Array` не подменяют типы полей.
Int64/Uint64 → bigint; Optional → `T | null`, поле не опциональное;
JSON → unknown; известные даты → Date; списки/структуры/кортежи разбираются рекурсивно;
необработанные типы → unknown. Уточнение JSON-схемы остаётся приложению.
Реестр содержит `TableColumns` и `ExistingTables` и генерируется по указанному пути.
Для `.js` реестра нужен ESM-проект; `.mjs` работает независимо от `type`.

## Диагностика

Logger необязателен; пакет не печатает SQL, параметры, токены и connection string.
Не включайте персональные данные в `label`. Исключение из logger не меняет исход запроса.

| Событие | Смысл |
| --- | --- |
| `DB_QUERY_TIMEOUT` | timeout/abort попытки; label, время, доступный nodeId |
| `DB_QUERY_HEDGE` | победитель, тип копии, ноды и RU из trailers, если доступны |
| `DB_QUERY_STATS` | промах compile cache или SQL ≥ 1 с; compileMs/totalMs |

nodeId SQL берётся из `tracing:ydb:query.execute` через AsyncLocalStorage;
у Table API nodeId не вычисляется. Это привязка к diagnostics API закреплённого SDK.
Для углублённого анализа используйте `.sys/query_stats`, планы запросов и официальный SDK tracing.
Сам по себе `fromCache=false` не означает неисправность базы.

## Cloud Functions

Пример [`handler.mjs`](../examples/cloud-function/handler.mjs) переиспользует promise клиента;
при ошибке инициализации сбрасывает его, чтобы следующий вызов мог повторить подключение.
Облачные resource IDs, IAM-роли и deploy pipeline задаёт приложение, не библиотека.

```sh
npx esbuild examples/cloud-function/handler.mjs --bundle --platform=node --format=cjs --outfile=handler.cjs
```

esbuild нужен как инструмент сборки потребителя, а не runtime-зависимость toolkit.
Бюджет запроса должен оставлять время на инициализацию/обработку/отправку ответа в пределах
таймаута функции. Деплой и облачная проверка не выполняются тестом CJS-бандла.

## Совместимость

Основной build/test target — Node.js 22+. Зависимости `@ydbjs` закреплены в `package.json`;
обновление требует повторного прогона Table API, TLS и diagnostics.

| Runtime / среда | Проверка |
| --- | --- |
| Node.js 22.21.1, macOS arm64 | unit, local DB, tarball, CJS bundle |
| Bun 1.4.4, macOS arm64 | smoke: SQL, Table API, hedge, отмена, схема, close |
| Deno 2.9.6, macOS arm64 | smoke: SQL, Table API, hedge, отмена, схема, close |
| local-ydb 26.1.1.22, linux/amd64 в Docker | синтетические интеграционные тесты |
| Yandex Cloud Functions / managed YDB | новый пакет в облаке не развёрнут; перенесён опыт исходного приложения |

Это матрица конкретных проверок, не обещание всех версий runtime и серверов.
Для Bun/Deno есть общий `scripts/runtime-smoke.mjs`; тестировать нужно весь путь до YDB,
а не только успешный import. Браузеры и HTTP-only edge runtime не являются целевой средой:
текущий SDK использует gRPC и Node-совместимые API.

Проверка из корня репозитория после сборки и запуска локальной YDB:

```sh
bun scripts/runtime-smoke.mjs
deno run --no-check --allow-env --allow-net --allow-read --allow-write --allow-sys scripts/runtime-smoke.mjs
```

Для Deno проверялось исполнение JS, не `deno check` TypeScript-деклараций.
Полный unit/CLI/tarball-набор пока проверен только под Node.js.
