#!/usr/bin/env node
import {parseArgs} from "node:util";
import {connect, createMigration, runMigrations, rollbackMigration} from "./migrations.js";
import {generateTypes} from "./schema.js";

const help = `ydb-toolkit — YDB migrations and schema types

  create <snake_case_name> --dir <migrations>
  migrate --dir <migrations>
  rollback --dir <migrations>
  types --out <generated.ts> [--registry <tables.mjs>]

Connection: YDB_CONNECTION_STRING=grpc(s)://host:port/database
Auth/TLS: official @ydbjs environment variables; see docs/guide.md.
Run only one migration process. DDL and rollback are not atomic.
`;

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    dir: {type: "string"}, out: {type: "string"}, registry: {type: "string"}, help: {type: "boolean", short: "h"},
  }});
  const [command, name] = positionals;
  if (values.help || !command) {process.stdout.write(help); return;}
  if (command === "create") {
    if (!name || !values.dir || positionals.length !== 2) {throw new Error("create requires a name and --dir");}
    process.stdout.write(`${await createMigration(values.dir, name)}\n`);
    return;
  }
  if (!["migrate", "rollback", "types"].includes(command) || positionals.length !== 1) {throw new Error("Unknown command; use --help");}
  if (["migrate", "rollback"].includes(command) && !values.dir) {throw new Error("--dir is required");}
  if (command === "types" && !values.out) {throw new Error("--out is required");}
  const connectionString = process.env.YDB_CONNECTION_STRING;
  if (!connectionString) {throw new Error("YDB_CONNECTION_STRING is required");}
  const db = await connect({connectionString});
  try {
    if (command === "migrate") {process.stdout.write(`${JSON.stringify(await runMigrations(db, values.dir!))}\n`);}
    if (command === "rollback") {process.stdout.write(`${await rollbackMigration(db, values.dir!) ?? "No migrations to roll back"}\n`);}
    if (command === "types") {await generateTypes(db, {out: values.out!, ...(values.registry ? {registry: values.registry} : {})});}
  } finally {await db.close();}
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
