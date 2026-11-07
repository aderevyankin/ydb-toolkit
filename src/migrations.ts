import {mkdir, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {anyUnpack} from "@bufbuild/protobuf/wkt";
import {StatusIds_StatusCode, type Operation} from "@ydbjs/api/operation";
import {Entry_Type, ListDirectoryResultSchema, SchemeServiceDefinition} from "@ydbjs/api/scheme";
import {CreateSessionResultSchema, DescribeTableResultSchema, TableServiceDefinition} from "@ydbjs/api/table";
import {Type_PrimitiveTypeId as P} from "@ydbjs/api/value";
import {query} from "@ydbjs/query";
import {openDriver, type ConnectionOptions} from "./connection.js";

function payload(response: {operation?: Operation}) {
  const operation = response.operation;
  if (!operation || operation.status !== StatusIds_StatusCode.SUCCESS || !operation.result) {
    throw new Error(`YDB operation failed: ${operation?.status ?? "missing"} ${JSON.stringify(operation?.issues ?? [])}`);
  }
  return operation.result;
}

export async function connect(options: ConnectionOptions) {
  const driver = await openDriver(options);
  const sql = query(driver);
  const table = driver.createClient(TableServiceDefinition);
  const scheme = driver.createClient(SchemeServiceDefinition);
  let closing: Promise<void> | null = null;
  return {
    sql,
    async describeTable(name: string) {
      identifier(name);
      const session = anyUnpack(payload(await table.createSession({}, {signal: AbortSignal.timeout(10000)})), CreateSessionResultSchema);
      if (!session?.sessionId) {throw new Error("Missing Table API session");}
      try {
        const result = anyUnpack(payload(await table.describeTable({sessionId: session.sessionId, path: `${driver.database}/${name}`},
          {signal: AbortSignal.timeout(10000)})), DescribeTableResultSchema);
        if (!result) {throw new Error("Missing table description");}
        return result;
      } finally {
        const result = await table.deleteSession({sessionId: session.sessionId}, {signal: AbortSignal.timeout(10000)});
        if (result.operation?.status !== StatusIds_StatusCode.SUCCESS) {throw new Error("Could not delete Table API session");}
      }
    },
    async listTables(): Promise<string[]> {
      const result = anyUnpack(payload(await scheme.listDirectory({path: driver.database}, {signal: AbortSignal.timeout(10000)})), ListDirectoryResultSchema);
      if (!result) {throw new Error("Missing directory listing");}
      return result.children.filter(entry => entry.type === Entry_Type.TABLE).map(entry => entry.name).sort();
    },
    close(): Promise<void> {
      closing ??= Promise.resolve(sql[Symbol.asyncDispose]()).finally(() => driver.close());
      return closing;
    },
  };
}

export type MigrationDb = Awaited<ReturnType<typeof connect>>;
type Description = Awaited<ReturnType<MigrationDb["describeTable"]>>;
export const hasIndex = (description: Description, name: string): boolean => description.indexes.some(index => index.name === name);
export const hasColumn = (description: Description, name: string): boolean => description.columns.some(column => column.name === name);

export function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {throw new Error(`Unsupported YDB identifier: ${name}`);}
  return `\`${name}\``;
}

export const YdbDataTypes = {
  UTF8: "Utf8", TIMESTAMP: "Timestamp", INT32: "Int32", INT64: "Int64", UINT32: "Uint32", UINT64: "Uint64",
  BOOL: "Bool", DOUBLE: "Double", FLOAT: "Float", DATE: "Date", DATETIME: "Datetime", JSON: "Json", JSON_DOCUMENT: "JsonDocument",
} as const;
export type DataType = keyof typeof YdbDataTypes;
export interface ColumnDefinition {name: string; type: DataType | `OPTIONAL_${DataType}`; comment: string}

function columnDefinition(column: ColumnDefinition): string {
  if (!column.comment?.trim()) {throw new Error(`Comment required for column ${column.name}`);}
  const optional = column.type.startsWith("OPTIONAL_");
  const type = YdbDataTypes[(optional ? column.type.slice(9) : column.type) as DataType];
  if (!type) {throw new Error(`Unknown data type: ${column.type}`);}
  return `${identifier(column.name)} ${type}${optional ? "" : " NOT NULL"}`;
}

export async function createTable(db: MigrationDb, name: string, columns: ColumnDefinition[], primaryKey: string[]): Promise<void> {
  if (!columns.length || !primaryKey.length || primaryKey.some(key => !columns.some(column => column.name === key))) {
    throw new Error("createTable requires columns and a primary key referencing those columns");
  }
  await db.sql(`CREATE TABLE ${identifier(name)} (${columns.map(columnDefinition).join(", ")}, PRIMARY KEY (${primaryKey.map(identifier).join(", ")}))`);
}
export async function dropTable(db: MigrationDb, name: string): Promise<void> {await db.sql(`DROP TABLE ${identifier(name)}`);}
export async function addColumn(db: MigrationDb, table: string, name: string, type: ColumnDefinition["type"], comment: string): Promise<void> {
  await db.sql(`ALTER TABLE ${identifier(table)} ADD COLUMN ${columnDefinition({name, type, comment})}`);
}
export async function addColumns(db: MigrationDb, table: string, columns: ColumnDefinition[]): Promise<void> {
  for (const column of columns) {await addColumn(db, table, column.name, column.type, column.comment);}
}
export async function dropColumn(db: MigrationDb, table: string, column: string): Promise<void> {
  await db.sql(`ALTER TABLE ${identifier(table)} DROP COLUMN ${identifier(column)}`);
}
export async function dropColumns(db: MigrationDb, table: string, columns: string[]): Promise<void> {
  for (const column of columns) {await dropColumn(db, table, column);}
}
export async function addIndex(db: MigrationDb, table: string, name: string, columns: string[], unique = false): Promise<void> {
  if (!columns.length) {throw new Error("Index requires columns");}
  await db.sql(`ALTER TABLE ${identifier(table)} ADD INDEX ${identifier(name)} GLOBAL ${unique ? "UNIQUE " : ""}ON (${columns.map(identifier).join(", ")})`);
}
export async function dropIndex(db: MigrationDb, table: string, name: string): Promise<void> {
  await db.sql(`ALTER TABLE ${identifier(table)} DROP INDEX ${identifier(name)}`);
}

// Requires a maintenance window without concurrent writes; DDL is not transactional.
export async function dropNotNull(db: MigrationDb, tableName: string, columnName: string, dataType: DataType): Promise<void> {
  const table = identifier(tableName), column = identifier(columnName), tmpName = `${columnName}_tmp`, tmp = identifier(tmpName);
  const yqlType = YdbDataTypes[dataType];
  if (!yqlType) {throw new Error(`Unknown data type: ${dataType}`);}
  let info = await db.describeTable(tableName);
  for (const name of [columnName, tmpName]) {
    const field = info.columns.find(c => c.name === name);
    if (!field) {continue;}
    const type = field.type?.type;
    const primitive = type?.case === "optionalType" ? type.value.item?.type : type;
    if (primitive?.case !== "typeId" || primitive.value !== P[dataType]) {
      throw new Error(`Unexpected type of ${name}; refusing to recreate column`);
    }
  }
  if (info.primaryKey.includes(columnName) || info.indexes.some(index => [...index.indexColumns, ...index.dataColumns].includes(columnName))) {
    throw new Error("dropNotNull cannot change a primary key or indexed/covered column");
  }
  const current = () => info.columns.find(c => c.name === columnName) ?? null;
  if (!current() && !hasColumn(info, tmpName)) {throw new Error("Neither source nor temporary column exists");}
  if (current()?.type?.type.case === "optionalType" && !hasColumn(info, tmpName)) {return;}
  if (current() && current()?.type?.type.case !== "optionalType") {
    if (!hasColumn(info, tmpName)) {await db.sql(`ALTER TABLE ${table} ADD COLUMN ${tmp} Optional<${yqlType}>`);}
    await db.sql(`UPDATE ${table} SET ${tmp} = ${column} WHERE ${tmp} IS NULL`);
    await db.sql(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    info = await db.describeTable(tableName);
  }
  if (!current()) {
    await db.sql(`ALTER TABLE ${table} ADD COLUMN ${column} Optional<${yqlType}>`);
    info = await db.describeTable(tableName);
  }
  if (hasColumn(info, tmpName)) {
    await db.sql(`UPDATE ${table} SET ${column} = ${tmp} WHERE ${column} IS NULL`);
    await db.sql(`ALTER TABLE ${table} DROP COLUMN ${tmp}`);
  }
}

export type TableRegistry = Record<string, Record<string, string>>;
export function validateTableSchema(registry: TableRegistry, table: string, columns: string[]): true {
  if (!Object.hasOwn(registry, table)) {throw new Error(`Unknown table: ${table}`);}
  if (columns.some(column => !Object.hasOwn(registry[table], column))) {throw new Error(`Invalid columns for ${table}`);}
  return true;
}
export function registerTable(registry: TableRegistry, table: string, schema: Record<string, string>): void {
  identifier(table);
  Object.defineProperty(registry, table, {value: schema, writable: true, enumerable: true, configurable: true});
}

async function appliedMigrations(db: MigrationDb): Promise<Set<string>> {
  if (!(await db.listTables()).includes("schema_migrations")) {
    await db.sql("CREATE TABLE schema_migrations (migration_name Utf8, PRIMARY KEY (migration_name))");
  }
  const [rows] = await db.sql<[ {migration_name: string} ]>("SELECT migration_name FROM schema_migrations");
  return new Set(rows.map(row => row.migration_name));
}

function migrationPath(directory: string, name: string): string {
  if (path.basename(name) !== name || !/^[A-Za-z0-9_-]+\.(?:m?js|cjs)$/.test(name)) {throw new Error("Invalid migration filename");}
  return path.resolve(directory, name);
}

export async function runMigrations(db: MigrationDb, directory: string): Promise<string[]> {
  const applied = await appliedMigrations(db);
  const files = (await readdir(directory)).filter(file => /\.(?:m?js|cjs)$/.test(file)).sort();
  const completed: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {continue;}
    const migration = await import(pathToFileURL(migrationPath(directory, file)).href);
    if (typeof migration.up !== "function") {throw new Error(`Missing up(db) in ${file}`);}
    await migration.up(db);
    await db.sql`UPSERT INTO schema_migrations (migration_name) VALUES (${file})`;
    completed.push(file);
  }
  return completed;
}

export async function rollbackMigration(db: MigrationDb, directory: string): Promise<string | null> {
  const file = [...await appliedMigrations(db)].sort().at(-1) ?? null;
  if (!file) {return null;}
  const migration = await import(pathToFileURL(migrationPath(directory, file)).href);
  if (typeof migration.down !== "function") {throw new Error(`Missing down(db) in ${file}`);}
  await migration.down(db);
  await db.sql`DELETE FROM schema_migrations WHERE migration_name = ${file}`;
  return file;
}

export async function createMigration(directory: string, name: string): Promise<string> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {throw new Error("Use a lowercase snake_case migration name");}
  await mkdir(directory, {recursive: true});
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const filename = path.resolve(directory, `${stamp}_${name}.mjs`);
  await writeFile(filename, `import {createTable, dropTable} from '@andmider/ydb-toolkit/migrations';\n\nexport async function up(db) {\n  await createTable(db, 'items', [{name: 'id', type: 'UTF8', comment: 'Item key'}], ['id']);\n}\n\nexport async function down(db) {\n  await dropTable(db, 'items');\n}\n`, {flag: "wx"});
  return filename;
}
