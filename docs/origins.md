# Происхождение и границы переноса

**Русский** · [English](origins.en.md) · [README](../README.md)

Инструментарий выделен из Climb Lab Backend до его перехода с YDB на PostgreSQL.
Это самостоятельная библиотека, а не копия backend. Частная история git исходного
приложения не публикуется; переносимый код и объяснения сохранены здесь отдельно.

| Источник | Здесь |
| --- | --- |
| `cloud_function/src/db/db.service.ts` | `src/client.ts`, `src/connection.ts`, `src/hedge.ts` |
| `cloud_function/src/db/ydb-compat.ts`, `ydb-param-helpers.ts` | `src/values.ts` |
| `database/tools/migration-utils.js`, `database/tools/migrations/` | `src/migrations.ts`, `src/cli.ts` |
| `database/tools/schema/generate-types.js` | `src/schema.ts` |
| unit/db и db-key-read tests | `tests/unit.test.mjs`, `tests/local.test.mjs`; доменные данные заменены синтетическими |
| Docker/local scripts | `examples/local/`, отдельные порты и volume |
| build и cold-start flow Cloud Functions | `examples/cloud-function/handler.mjs`, CJS smoke |
| database-layer/tooling/local-stand docs, исследования SDK и compile stalls | `docs/guide.md`, `docs/history.md` |
| исторический patch v5 | `archive/`, побайтовая копия и лицензия upstream |

## Что намеренно изменено

- Конфигурация и logger передаются извне; нет импорта утилит/алиасов Climb Lab.
- Нет глобального singleton; потребитель владеет lifecycle. Закрываются query pool и driver.
- Чтение задаётся явно, не определяется префиксом QueryKey.
- Убрано доменное преобразование bigint → number; generated types используют bigint/null/unknown.
- Пути миграций, generated types и реестра задаёт потребитель.
- Runtime и tooling используют одно правило TLS; ошибку чтения CA не маскируем.
- Генератор не пытается угадывать единственное число имени таблицы.

## Что осталось приложению

Репозитории, QueryKey, enum, DTO, generated types конкретной схемы, 21 историческая миграция,
IAM и секреты, выбор стенда, production-данные, инфраструктура и деплой. Пакет не заменяет
их адаптерами и не переключает Climb Lab на новую зависимость.

Исторические миграции Climb Lab не прогонялись через этот пакет: он не заявлен как
drop-in replacement его старых локальных imports. Проверяются независимые миграции примера.
Переезд на PostgreSQL, очистка YDB-кода и облачные проверки — отдельные операции.
