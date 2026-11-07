# ydb-toolkit

**Русский** · [English](README.en.md)

Инструменты для работы с YDB поверх официального JavaScript SDK: выполнение запросов,
миграции, генерация TypeScript-типов и диагностика.

Пакет дополняет [`@ydbjs`](https://github.com/ydb-platform/ydb-js-sdk), а не заменяет SDK.
Это не ORM и не общий слой для разных СУБД. Независимый проект, не официальный продукт YDB/Yandex.

## Что входит

| Точка входа | Возможности |
| --- | --- |
| `@aderevyankin/ydb-toolkit` | `YdbClient`, типизированные параметры, отмена/таймауты, hedge чтений, Table API, диагностика |
| `@aderevyankin/ydb-toolkit/migrations` | подключение утилит, DDL-хелперы, создание/применение/откат миграций |
| `@aderevyankin/ydb-toolkit/schema` | генерация TypeScript-типов и реестра таблиц из схемы YDB |
| `ydb-toolkit` | CLI `create`, `migrate`, `rollback`, `types` |

Int64/Uint64 остаются `bigint`, nullable — `T | null`. Пакет не преобразует результаты в
доменные модели и не выводит безопасность повторов из названия запроса.

## Установка

Пакет пока **не опубликован в npm**. Соберите tarball из этого репозитория:

```sh
git clone https://github.com/aderevyankin/ydb-toolkit.git
cd ydb-toolkit
npm ci --ignore-scripts
npm pack
```

В потребляющем проекте:

```sh
npm install /path/to/aderevyankin-ydb-toolkit-0.1.0.tgz
```

Для сборки и основных тестов используется Node.js 22+. Проверенные runtime и границы
проверок перечислены в [руководстве](docs/guide.md#совместимость).

## Первый запрос

```ts
import {YdbClient, ydb} from '@aderevyankin/ydb-toolkit';

const db = await YdbClient.connect({
  connectionString: 'grpc://localhost:2140/local',
});
try {
  const {resultSets} = await db.execute(
    'SELECT $id AS id',
    {$id: ydb.required.uint64(18446744073709551615n)},
    {mode: 'read', hedge: false},
  );
  // resultSets[0]: [{id: 18446744073709551615n}]
} finally {
  await db.close();
}
```

Перед локальным запуском уберите облачные auth/TLS-переменные из окружения.
Готовый пример [`examples/local`](examples/local/) передаёт anonymous provider явно.
Для managed YDB настройте авторизацию по [руководству](docs/guide.md#подключение-и-авторизация).

## Локальная проверка

Из корня репозитория; Docker должен быть запущен:

```sh
npm run db:up
node examples/local/query.mjs
npm test
npm run test:local
npm run test:pack
npm run db:stop
```

Стенд использует отдельный compose project, volume и loopback-порты **2140 / 8769**.
`test:pack` устанавливает собранный пакет в чистый временный проект и проверяет запрос,
миграцию, генерацию типов и загрузку CJS-бандла примера Cloud Function.

## Документация

- [API, авторизация, CLI, ограничения и совместимость](docs/guide.md)
- [Причины обходных решений и история патча SDK v5](docs/history.md)
- [Что и откуда перенесено](docs/origins.md)
- [Cloud Functions example](examples/cloud-function/handler.mjs)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Ограничения

- Hedge запускает дополнительное чтение и может увеличить RU. Это не лечение всех зависаний сервера.
- `mode: 'read'` — обязательство вызывающего кода: передавать туда запрос с побочными эффектами нельзя.
- Миграции запускаются одним процессом; DDL не атомарен, автоматической блокировки/checksum нет.
- `dropNotNull` требует остановки записей и резервной копии; это не online-миграция.
- Ограничения Table API зависят от версии сервера; проверены на local-ydb `26.1.1.22`.
- JSON и неподдержанные типы генерируются как `unknown`.

## Разработка

```sh
npm run type-check
npm test
npm run test:local
npm run test:pack
```

Тесты БД пишут только в отдельную локальную базу примера. CI не использует облачные секреты.
Правила для агентов — [`AGENTS.md`](AGENTS.md). Лицензия оригинального кода — [MIT](LICENSE);
лицензия исторического кода SDK сохранена отдельно.
