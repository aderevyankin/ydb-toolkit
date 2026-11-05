# Workarounds and history

[Русский](history.md) · **English** · [README](../README.en.md)

Preserved engineering experience, not a promise to fix every YDB failure. Historical
observations concern the original application and specific versions; this package is
verified independently. Support correspondence, user data, resource IDs and secrets were not copied.

## Why @ydbjs v6

The old v5 integration used prepareQuery, query_id, custom session-error classification
and Promise timeouts. A timeout without RPC cancellation could leave an operation
running and cause SessionBusy on reuse. Query Service v6 sends parameterized text without
a separate prepare RPC. The SDK provides cancellation/deadlines and idempotent retry,
so the old retry/prepared services are intentionally not part of the current runtime.

## Compile cache and hedging

Plans can be evicted from the shared node-local server cache. Storing query_id on the
client does not make it durable across nodes or cure server compilation queues.
Switching to keep-in-cache text queries alone did not remove delays in the original
project; the toolkit therefore adds no client-side prepared cache.

A SQL hedge changes query text with `/* hedge */` rather than relying on the same
compilation. This only partially mitigates stalls and does not guarantee a different
node or queue. ReadTable hedging bypasses SQL compilation, not every other source of
latency, and adds RU usage. Never hedge writes. If both attempts fail, return the primary
error so a derived-key mismatch does not hide the SQL failure.

## Table API and indexes

ReadRows/BulkUpsert use the SDK's low-level TableService. On local server 26.1.1.22,
ReadRows rejects secondary-indexed tables and BulkUpsert rejects synchronously indexed
tables; package integration tests reproduce this. Verify other versions independently.
Historical upstream context: [ydb#53313](https://github.com/ydb-platform/ydb/pull/53313).
ReadTable is a complete-primary-key bounded read, not a general replacement scan.
Internal indexImplTable access is intentionally excluded as an unstable contract.

## Discovery

The original serverless application disabled discovery to use its configured endpoint
without ListEndpoints and extra connections to discovered nodes. This is a preserved
default, not a proven cure for compilation stalls. Other clusters can enable
`driverOptions['ydb.sdk.enable_discovery']` and verify routing/TLS themselves.

## TLS and authentication

During the v5-to-v6 migration, passing an additional CA replaced trusted system roots
in the TLS context and broke verification of a publicly signed endpoint. The fix merges
system roots with the additional CA. Runtime and tooling now use this consistently;
the original application configured them differently.

Without auth settings, the v6 environment provider chooses anonymous rather than the
old metadata default. Cloud Functions require explicit metadata auth. TLS options can
enable TLS even for grpc://; local tests supply an anonymous provider explicitly.

## Nullable column recreation

The original managed environment did not produce the expected schema after ALTER COLUMN
DROP NOT NULL. The preserved workaround uses `<column>_tmp`, intermediate schema checks
and resumable steps. It is not atomic and requires paused writes. This does not claim
the native ALTER is broken on all current servers; check support on your version first.

## Archived v5 patch

[`archive/ydb-sdk+5.11.1.patch`](../archive/ydb-sdk+5.11.1.patch) is preserved verbatim
from source git blob `25d8a1e79fd5070c038f9135697b6a42a3fd0dcc`.

The actual diff removes the SDK's ESM tree and changes CJS certs.json. Its old explanatory
text also mentioned package exports changes, but **this patch has no such diff**.
A later legacy boilerplate variant differs; the original archive is not silently rewritten.

The patch addressed v5 packaging/bundling, not prepare/session failures. A later source
experiment did not confirm that the patch was needed for final esbuild bundle size.
Do not apply it to v6 or interpret historical certificate changes as advice to disable
TLS verification. No patch-package/postinstall is used, and the archive is not in the
npm tarball. SDK source in the diff retains its [upstream license](../archive/LICENSE.ydb-sdk).

## Upgrade checklist

- Cancel the losing RPC, not only its Promise.
- Keep writes free of idempotent retry/hedging.
- Verify complete PK order, projection and expect semantics for Table API.
- Test extra CA roots, anonymous/metadata auth and discovery on your environment.
- Check tracing:ydb:query.execute, protobuf unpacking and RU trailers.
- Compare bigint, JSON, null and date values with generated types.
- Test partial migration failure, retry, rollback and pool closure without forceExit.
