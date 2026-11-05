# Provenance and extraction scope

[Русский](origins.md) · **English** · [README](../README.en.md)

Extracted from Climb Lab Backend before its YDB-to-PostgreSQL migration. This is a
standalone library, not a backend copy. The source application's private git history
is not published; portable code and rationale are preserved separately here.

| Source | Destination |
| --- | --- |
| `cloud_function/src/db/db.service.ts` | `src/client.ts`, `src/connection.ts`, `src/hedge.ts` |
| `cloud_function/src/db/ydb-compat.ts`, `ydb-param-helpers.ts` | `src/values.ts` |
| `database/tools/migration-utils.js`, `database/tools/migrations/` | `src/migrations.ts`, `src/cli.ts` |
| `database/tools/schema/generate-types.js` | `src/schema.ts` |
| unit/db and db-key-read tests | `tests/unit.test.mjs`, `tests/local.test.mjs`, synthetic domain-independent tables |
| Docker/local scripts | `examples/local/`, separate ports and volume |
| Cloud Functions build/cold-start flow | `examples/cloud-function/handler.mjs`, CJS smoke |
| database/tooling/local docs and SDK/compile-stall investigations | guide and history docs |
| historical v5 patch | `archive/`, verbatim with upstream license |

## Intentional changes

- Caller-owned configuration/logger; no Climb Lab aliases or utility imports.
- Explicit lifecycle instead of a global singleton; both query pool and driver close.
- Explicit read mode instead of QueryKey prefix classification.
- No domain-specific bigint-to-number conversion; generated types use bigint/null/unknown.
- Consumer-controlled migration, generated types and registry paths.
- Shared runtime/tooling TLS policy without swallowing CA file errors.
- No heuristic table-name singularization.

## Left in the application

Domain repositories, QueryKey, enums, DTOs, application-generated types, 21 historical
migrations, IAM/secrets, environment selection, production data, infrastructure and deployment.
The extraction does not replace those with adapters or make Climb Lab depend on the package.

The original 21 migrations were not run through this package: it is not advertised as
a drop-in replacement for their local imports. Independent example migrations are tested.
PostgreSQL migration, YDB code removal and cloud verification remain separate operations.
