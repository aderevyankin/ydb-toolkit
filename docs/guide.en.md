# Guide

[Русский](guide.md) · **English** · [README](../README.en.md)

## Connection and authentication

```ts
const db = await YdbClient.connect({
  connectionString: process.env.YDB_CONNECTION_STRING ?? '',
  logger: (level, event, details) => appLogger[level]({event, ...details}),
});
```

Pass `grpc://host:port/database` or `grpcs://host:port/database` explicitly. The library
does not select application environments, `yc` profiles, or secrets. `driverOptions`
are forwarded to the official Driver: custom credentials providers, TLS, discovery.
Defaults: discovery disabled, ready timeout 10 seconds. See [history](history.en.md)
for the rationale; these are not universal recommendations for every cluster.

The default `EnvironCredentialsProvider` from the pinned `@ydbjs/auth` detects:

1. `YDB_ANONYMOUS_CREDENTIALS=1`: anonymous.
2. `YDB_METADATA_CREDENTIALS=1`: metadata service.
3. `YDB_ACCESS_TOKEN_CREDENTIALS`: access token.
4. `YDB_STATIC_CREDENTIALS_USER` and the SDK's accompanying settings: static credentials.
5. No settings: anonymous, **not metadata**.

For Cloud Functions, set `YDB_METADATA_CREDENTIALS=1` and grant the service account
database permissions. The toolkit does not load service account keys through the old
v5 environment variable. Supply the relevant official SDK provider through `driverOptions`
for other methods. Do not put secrets in command arguments or git.

The SDK reads TLS environment settings, including `YDB_SSL_ROOT_CERTIFICATES_FILE`,
`NODE_EXTRA_CA_CERTS`, inline certificates, and client certificate/key settings.
Additional CA roots are merged with `tls.rootCertificates`; CA file errors are not swallowed.
This **extends trust** rather than creating an isolated trust store. TLS options can enable
TLS even with a `grpc://` URL: do not inherit cloud certificates in a local environment.
The local example explicitly supplies anonymous credentials and bypasses automatic auth/TLS environment detection.

Use one client per process/container; `connect()` is not a singleton. On shutdown,
`await db.close()` cancels client operations, disposes the query pool, unsubscribes
diagnostics, and closes the driver. Repeated close is safe. A Cloud Function should
reuse the client between warm invocations instead of closing it after every request.

## Queries

```ts
await db.execute('UPSERT INTO items (id) VALUES ($id)', {
  $id: ydb.required.uint64(42n),
}); // Default: write, no hedge, no idempotent retry.

const result = await db.execute('SELECT * FROM items WHERE id = $id', {
  $id: ydb.required.uint64(42n),
}, {mode: 'read', label: 'items.byId', timeoutMs: 9000, hedge: false});
```

`resultSets` contains SDK row sets with bigint precision intact. Choose an explicit
bigint-to-JSON policy in your application: `JSON.stringify` cannot serialize bigint by default.
The toolkit does not claim static result typing for arbitrary SQL.

Bind parameters separately; never interpolate user values into YQL. Manual `DECLARE`
statements are unnecessary: Query SDK adds them from parameter types. `label` is a
diagnostic label, not a prepared query cache key. Reusing it with different query text
logs `QUERY_KEY_TEXT_MISMATCH` without blocking execution.

`mode: 'read'` enables SDK idempotent retries and hedging. It is the caller's guarantee
that the query has no side effects; the toolkit does not parse SQL to prove safety.
Default budgets: 8 seconds for writes, 9 seconds for reads. `signal` cancels the operation;
timeouts cancel the RPC, not just the JavaScript wait.

### Hedging

Explicit reads hedge by default: after 1 second a SQL copy is launched with a
`/* hedge */` prefix. Disable with `hedge: false` or configure `hedge: {delayMs: 1000}`.
The delay must be positive and shorter than `timeoutMs`; the hedge receives the remaining budget.

The first successful result wins and cancels the loser. Primary failure before hedge
launch propagates immediately. After launch the other attempt can still succeed;
if both fail, the primary error is returned. A derived-key mismatch must not hide the
original failure. Two reads do not share a snapshot transaction.

## Parameters and types

Both `ydb.required` and `ydb.optional` provide `utf8`, `int32`, `int64`, `uint32`,
`uint64`, `double`, `bool`, `timestamp`, `json`, `jsonDocument`.

- required rejects missing values; optional retains its YDB type for nulls.
- Int64/Uint64 accept bigint or safe integer numbers, with range checking.
- JSON helpers accept JS values; `TypedValues.json/jsonDocument` accept JSON text.
- timestamp accepts a Date.
- `TypedValues.list(Types.struct({...}), rows)` builds List/Struct parameters.
- Empty lists, including nested ones, are rejected because the SDK infers their type from the first item.
- `Types.optional`, `Types.list`, `Types.struct` build composite types.
- `isPreconditionFailed(error)` tests the SDK status code, not an error message.

Use the official `@ydbjs/value` factories directly for other types.

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

- `readRow` uses ReadRows, returning `{resultSets: [rows]}`. A missing row is an empty array.
- `hedge.keyRead` replaces the SQL hedge with StreamReadTable over `[K, K]`.
- Supply the **complete primary key in key-column order**, with matching types and SQL/Table projections.
- `expect(row)` turns a missing/mismatched derived key into an attempt error.
- `bulkUpsert` accepts **one row**, without automatic retry or hedging.
- On the tested server, ReadRows rejects secondary-indexed tables and BulkUpsert
  rejects synchronously indexed tables. Other server versions may differ.
- ReadTable may consume substantially more RU than point SQL/ReadRows. Check current
  pricing and your own metrics; historical measurements are not pricing guarantees.
- Simple table names only, no nested paths or internal indexImplTable access.

## Migrations and CLI

```sh
npx ydb-toolkit create create_items --dir database/migrations
npx ydb-toolkit migrate --dir database/migrations
npx ydb-toolkit rollback --dir database/migrations
npx ydb-toolkit types --out src/db/generated.ts --registry database/tables.mjs
```

The CLI reads `YDB_CONNECTION_STRING` and official auth/TLS environment variables.
For local anonymous access, clear inherited cloud/TLS settings first, then run:

```sh
YDB_CONNECTION_STRING=grpc://localhost:2140/local YDB_ANONYMOUS_CREDENTIALS=1 \
  npx ydb-toolkit migrate --dir examples/local/migrations
```

`.js`, `.mjs`, `.cjs` migrations are sorted by filename. New migrations use a millisecond
timestamp and `.mjs` regardless of the consuming project's `type`. The contract is
`export async function up(db)` / `down(db)`; see the [example](../examples/local/migrations/001_create_items.mjs).
`db.sql` is the official QueryClient, including tagged templates and DML transactions.
`schema_migrations` records a filename only after `up` succeeds. Rollback chooses the last
applied filename in lexical order, runs `down`, then removes its ledger entry.

**One migration process at a time.** No distributed lock or checksum enforcement.
DDL is not transactional: a failed `up` may already have changed the schema, and the
whole `up` is invoked again. Write resumable migrations and inspect schema state.
Editing an applied file does not reapply it. Rollback is application code, not automatic
data recovery. Give large DML operations an explicit `.timeout(...)` on `db.sql`.

DDL helpers: `createTable`, `dropTable`, `addColumn(s)`, `dropColumn(s)`, `addIndex`,
`dropIndex`, `hasColumn`, `hasIndex`, `dropNotNull`. Supported types are in `YdbDataTypes`;
the `OPTIONAL_` prefix means nullable. A column comment is required for migration readability
but not stored in YDB. No automatic default value handling. DDL names are simple
identifiers, not arbitrary user input. Unique index support depends on the server.
`registerTable(registry, table, schema)` and `validateTableSchema(registry, table, columns)`
use a caller-owned registry, not the original application's tables.

### dropNotNull

This workaround recreates a column through `<column>_tmp`: copy, drop source, add nullable
source, copy back, drop temporary column. Schema checks allow resuming after an intermediate failure.
It requires a backup, paused writes, and no unrelated column using the reserved temporary name.
Primary keys and indexed/covered columns are rejected. Resumable does not mean atomic,
safe for concurrent writes, or automatically reversible to NOT NULL.

## Schema generation

```ts
import {connect} from '@aderevyankin/ydb-toolkit/migrations';
import {generateTypes} from '@aderevyankin/ydb-toolkit/schema';
const db = await connect({connectionString});
try {
  await generateTypes(db, {out: 'src/db/generated.ts', registry: 'database/tables.mjs'});
} finally {await db.close();}
```

Reads root-level tables, including `schema_migrations`, without traversing subdirectories.
Interface names are derived from table names without heuristic singularization; collisions
are errors. Field names are quoted. Int64/Uint64 map to bigint; Optional to `T | null`,
not an optional property; JSON to unknown; known dates to Date. Lists, structs and tuples
are handled recursively; unhandled types map to unknown. JSON schema belongs to the application.
The optional registry exports `TableColumns` and `ExistingTables` to the consumer path.
Use `.mjs` unless the consumer already treats `.js` as ESM.

## Diagnostics

Logging is optional. SQL text, parameters, tokens and connection strings are not logged.
Keep personal data out of labels. Logger exceptions do not alter query outcomes.

| Event | Meaning |
| --- | --- |
| `DB_QUERY_TIMEOUT` | attempt timeout/abort; label, duration, available nodeId |
| `DB_QUERY_HEDGE` | winner, hedge kind, node IDs and trailer RU when available |
| `DB_QUERY_STATS` | compile cache miss or SQL ≥ 1 second; compileMs/totalMs |
| `QUERY_KEY_TEXT_MISMATCH` | one label used for different texts |

SQL nodeId comes from `tracing:ydb:query.execute` via AsyncLocalStorage; Table API nodeId
is not inferred. This relies on the pinned SDK's diagnostics API. For deeper inspection
use `.sys/query_stats`, query plans and official SDK tracing. `fromCache=false` alone is not a fault.

## Cloud Functions

The [handler example](../examples/cloud-function/handler.mjs) reuses an initialization promise
and resets it after an initialization error. The application owns resource IDs, IAM roles
and its deployment pipeline.

```sh
npx esbuild examples/cloud-function/handler.mjs --bundle --platform=node --format=cjs --outfile=handler.cjs
```

esbuild is a consumer build tool, not a toolkit runtime dependency. Query budgets must leave
time for initialization, application work and the response within the function deadline.
The CJS bundle test does not deploy or verify a cloud environment.

## Compatibility

The primary build/test target is Node.js 22+. `@ydbjs` versions are pinned in `package.json`;
updates require repeating Table API, TLS and diagnostics checks.

| Runtime / environment | Verification |
| --- | --- |
| Node.js 22.21.1, macOS arm64 | unit, local DB, tarball, CJS bundle |
| Bun 1.4.4, macOS arm64 | SQL, Table API, hedge, cancellation, schema, close smoke |
| Deno 2.9.6, macOS arm64 | SQL, Table API, hedge, cancellation, schema, close smoke |
| local-ydb 26.1.1.22, linux/amd64 in Docker | synthetic integration tests |
| Yandex Cloud Functions / managed YDB | new package not deployed; original application's experience preserved |

This records specific checks, not a promise for every runtime/server version. Run
`scripts/runtime-smoke.mjs` under Bun/Deno to test the entire path to YDB, not just imports.
Browsers and HTTP-only edge environments are not targets: the current SDK needs gRPC and Node-compatible APIs.

From the repository root, after building and starting local YDB:

```sh
bun scripts/runtime-smoke.mjs
deno run --no-check --allow-env --allow-net --allow-read --allow-write --allow-sys scripts/runtime-smoke.mjs
```

Deno verification covers JS execution, not `deno check` of TypeScript declarations.
The complete unit/CLI/tarball suite has only been verified under Node.js.
