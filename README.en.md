# ydb-toolkit

[Русский](README.md) · **English**

YDB toolkit built on the official JavaScript SDK: query execution, migrations,
TypeScript type generation, and diagnostics.

An addition to [`@ydbjs`](https://github.com/ydb-platform/ydb-js-sdk), not a replacement
SDK, ORM, or cross-database abstraction. An independent project, not an official YDB/Yandex product.

## Contents

| Entry point | Features |
| --- | --- |
| `@aderevyankin/ydb-toolkit` | `YdbClient`, typed parameters, timeouts/cancellation, read hedging, Table API, diagnostics |
| `@aderevyankin/ydb-toolkit/migrations` | tooling connection, DDL helpers, migration creation/application/rollback |
| `@aderevyankin/ydb-toolkit/schema` | TypeScript types and table registry generated from the database schema |
| `ydb-toolkit` | CLI: `create`, `migrate`, `rollback`, `types` |

Int64/Uint64 remain `bigint`; nullable fields use `T | null`. Results are not mapped
to application models. Query names never determine whether retries are safe.

## Installation

**Not published to npm yet.** Build a tarball from this repository:

```sh
git clone https://github.com/aderevyankin/ydb-toolkit.git
cd ydb-toolkit
npm ci --ignore-scripts
npm pack
```

In your application:

```sh
npm install /path/to/aderevyankin-ydb-toolkit-0.1.0.tgz
```

Builds and the primary test suite use Node.js 22+. See the [compatibility matrix](docs/guide.en.md#compatibility)
for tested runtimes and the scope of those checks.

## First query

```ts
import {YdbClient, ydb} from '@aderevyankin/ydb-toolkit';

const db = await YdbClient.connect({connectionString: 'grpc://localhost:2140/local'});
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

Remove inherited cloud auth/TLS environment variables before running locally.
The [`examples/local`](examples/local/) connection explicitly uses anonymous credentials.
See [authentication](docs/guide.en.md#connection-and-authentication) for managed YDB.

## Local verification

From the repository root, with Docker running:

```sh
npm run db:up
node examples/local/query.mjs
npm test
npm run test:local
npm run test:pack
npm run db:stop
```

The example has its own compose project and volume, bound to loopback ports **2140 / 8769**.
The tarball test installs into a clean temporary project, runs a query, migrations and type
generation, and checks that a CJS-bundled Cloud Function handler can be loaded.

## Documentation

- [API, authentication, CLI, limitations, compatibility](docs/guide.en.md)
- [Workaround rationale and SDK v5 patch history](docs/history.en.md)
- [Extraction inventory and provenance](docs/origins.en.md)
- [Cloud Functions example](examples/cloud-function/handler.mjs)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Limitations

- Hedging adds a read and may increase RU usage. It does not fix every server stall.
- `mode: 'read'` is a caller guarantee: never use it for queries with side effects.
- Migrations require a single process; DDL is not atomic. No migration lock or checksum enforcement.
- `dropNotNull` needs paused writes and a backup; it is not an online migration.
- Table API restrictions depend on the server version; tests target local-ydb `26.1.1.22`.
- JSON and unhandled schema types generate `unknown`, not an invented precise interface.

## Development

```sh
npm run type-check
npm test
npm run test:local
npm run test:pack
```

DB tests only write to the dedicated local example database. CI needs no cloud secrets.
Agent instructions: [`AGENTS.md`](AGENTS.md). Original toolkit code: [MIT](LICENSE).
The archived SDK source retains its upstream license.
