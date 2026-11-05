# Working on ydb-toolkit

Standalone ESM toolkit on @ydbjs v6. Russian documentation is primary;
update its English counterpart when changing a documented contract.

- Runtime: `src/client.ts`, `src/values.ts`, `src/hedge.ts`.
- Tooling: `src/migrations.ts`, `src/schema.ts`, `src/cli.ts`.
- Start with `README.md` and `docs/guide.md`; workarounds live in `docs/history.md`.
- Run `npm test`, `npm run type-check`, `npm run test:pack`.
- DB tests: `npm run db:up` then `npm run test:local`. Only the dedicated local example database is allowed.
- Preserve bigint precision and explicit nulls. No `any`, no explicit `undefined` in new source.
- Writes must not gain automatic retry or hedging. Labels are diagnostics, not read classification.
- Preserve cancellation and error handling. Close both the query pool and driver.
- Migrations are single-process, non-atomic DDL. Never imply online safety for `dropNotNull`.
- Keep examples synthetic; credentials and private project documents stay outside git.
- npm publication, deployment and nonlocal DB changes require explicit owner approval.
