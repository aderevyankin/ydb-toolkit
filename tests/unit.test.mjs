import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import {create} from '@bufbuild/protobuf';
import {toJs} from '@ydbjs/value';
import {TypeSchema, Type_PrimitiveTypeId as P} from '@ydbjs/api/value';
import {raceWithHedge, TypedValues, Types, ydb, YdbClient} from '../dist/index.js';
import {createMigration, identifier, validateTableSchema, runMigrations, rollbackMigration, dropNotNull} from '../dist/migrations.js';
import {typescriptType, generateTypes} from '../dist/schema.js';

test('64-bit parameters retain boundaries and reject already imprecise numbers', () => {
  for (const value of [-(1n << 63n), (1n << 63n) - 1n, 9007199254740993n]) {
    assert.equal(toJs(ydb.required.int64(value)), value);
  }
  assert.equal(toJs(ydb.required.uint64((1n << 64n) - 1n)), (1n << 64n) - 1n);
  for (const value of [Number.MAX_SAFE_INTEGER + 1, NaN, 1.1, '123']) {
    assert.throws(() => TypedValues.int64(value));
  }
  assert.throws(() => TypedValues.uint64(-1n));
  assert.throws(() => TypedValues.uint64(1n << 64n));
  assert.throws(() => TypedValues.int64(1n << 63n));
});

test('required/optional values preserve false, zero, empty text, JSON, dates and null', () => {
  const date = new Date('2026-01-02T03:04:05Z');
  const values = {utf8: '', int32: 0, int64: 0n, uint32: 0, uint64: 0n,
    double: 0, bool: false, timestamp: date, json: {a: [1, null]}, jsonDocument: {ok: true}};
  for (const [name, value] of Object.entries(values)) {
    assert.deepEqual(toJs(ydb.required[name](value)), value);
    assert.deepEqual(toJs(ydb.optional[name](value)), value);
    assert.equal(toJs(ydb.optional[name](null)), null);
    assert.equal(toJs(ydb.optional[name]()), null);
    assert.throws(() => ydb.required[name](null), /missing/);
    assert.throws(() => ydb.required[name](), /missing/);
  }
});

test('List/Struct supports nested values and rejects empty lists/missing required fields', () => {
  const type = Types.struct({id: Types.UINT64, note: Types.optional(Types.UTF8), nested: Types.list(Types.INT64)});
  const input = [{id: 9007199254740993n, note: null, nested: [1n, 2n]}];
  assert.deepEqual(toJs(TypedValues.list(type, input)), input);
  assert.throws(() => TypedValues.list(Types.UTF8, []), /Empty/);
  assert.throws(() => TypedValues.list(type, [{note: null, nested: [1n]}]), /Missing/);
  assert.throws(() => TypedValues.list(type, [{id: 1n, nested: []}]), /Empty/);
  assert.throws(() => TypedValues.list(Types.UTF8, [null]), /missing/);
  assert.throws(() => ydb.required.json(() => {}), /serialized/);
});

test('hedge skips fast primary', async () => {
  let launches = 0;
  const result = await raceWithHedge(() => {launches++; return {promise: Promise.resolve(1), cancel() {}};}, 10);
  await sleep(20);
  assert.equal(result.value, 1); assert.equal(result.hedged, false); assert.equal(launches, 1);
});

test('unknown List/Struct inputs are validated without scalar coercion', () => {
  const invalid = [
    [Types.BOOL, 'false'], [Types.UTF8, 42], [Types.DOUBLE, '1.5'],
    [Types.INT32, '1'], [Types.INT32, 1.5], [Types.INT32, 2147483648],
    [Types.UINT32, -1], [Types.UINT32, 4294967296],
    [Types.TIMESTAMP, '2026-01-01'], [Types.TIMESTAMP, new Date('invalid')],
    [Types.JSON, {ok: true}], [Types.JSON, '{invalid}'], [Types.JSON_DOCUMENT, 'invalid'],
    [Types.optional(Types.BOOL), 'false'],
  ];
  for (const [type, value] of invalid) {assert.throws(() => TypedValues.list(type, [value]));}
  assert.throws(() => TypedValues.list(Types.struct({enabled: Types.BOOL}), [{enabled: 'false'}]), /boolean/);
  assert.deepEqual(toJs(TypedValues.list(Types.BOOL, [false, true])), [false, true]);
  assert.deepEqual(toJs(TypedValues.list(Types.INT32, [-2147483648, 2147483647])), [-2147483648, 2147483647]);
  assert.deepEqual(toJs(TypedValues.list(Types.UINT32, [0, 4294967295])), [0, 4294967295]);
  assert.deepEqual(toJs(TypedValues.list(Types.JSON, ['{"ok":true}'])), [{ok: true}]);
});

test('hedge winner cancels primary and primary winner cancels hedge', async () => {
  for (const hedgeWins of [true, false]) {
    const cancelled = [];
    const result = await raceWithHedge(isHedge => ({
      promise: sleep(isHedge === hedgeWins ? 15 : 40).then(() => isHedge),
      cancel: () => cancelled.push(isHedge),
    }), 2);
    assert.equal(result.winner, hedgeWins ? 'hedge' : 'primary');
    assert.deepEqual(cancelled, [!hedgeWins]);
  }
});

test('primary failure before hedge does not launch duplicate', async () => {
  let launches = 0;
  const failure = new Error('primary');
  await assert.rejects(raceWithHedge(() => {launches++; return {promise: Promise.reject(failure), cancel() {}};}, 20), error => error === failure);
  await sleep(30); assert.equal(launches, 1);
});

test('throwing loser cancellation does not hide success or cause an unhandled rejection', {timeout: 1000}, async () => {
  for (const hedgeWins of [true, false]) {
    const result = await raceWithHedge(isHedge => ({
      promise: sleep(isHedge === hedgeWins ? 15 : 40).then(() => isHedge),
      cancel() {throw new Error('cancel-failed');},
    }), 2);
    assert.equal(result.value, hedgeWins);
    assert.equal(result.winner, hedgeWins ? 'hedge' : 'primary');
  }
});

test('both failures preserve primary error regardless of order', async () => {
  for (const primaryFirst of [true, false]) {
    const primary = new Error('primary');
    await assert.rejects(raceWithHedge(isHedge => ({
      promise: sleep(isHedge === primaryFirst ? 30 : 15).then(() => {throw isHedge ? new Error('hedge') : primary;}), cancel() {},
    }), 2), error => error === primary);
  }
});

test('failed or synchronously throwing hedge still allows primary success', async () => {
  for (const sync of [true, false]) {
    const result = await raceWithHedge(isHedge => {
      if (isHedge && sync) {throw new Error('launch');}
      return {promise: isHedge ? Promise.reject(new Error('hedge')) : sleep(20).then(() => 1), cancel() {}};
    }, 2);
    assert.equal(result.value, 1);
  }
});

test('failed primary after hedge starts allows hedge success', async () => {
  const result = await raceWithHedge(isHedge => ({
    promise: sleep(isHedge ? 25 : 10).then(() => {if (!isHedge) {throw new Error('primary');} return 7;}), cancel() {},
  }), 2);
  assert.equal(result.value, 7);
});

test('schema types follow SDK bigint/null and use unknown for unhandled types', () => {
  const primitive = id => create(TypeSchema, {type: {case: 'typeId', value: id}});
  assert.equal(typescriptType(primitive(P.INT64)), 'bigint');
  assert.equal(typescriptType(primitive(P.UINT64)), 'bigint');
  assert.equal(typescriptType(primitive(P.JSON_DOCUMENT)), 'unknown');
  assert.equal(typescriptType(primitive(P.TIMESTAMP)), 'globalThis.Date');
  assert.equal(typescriptType(create(TypeSchema, {type: {case: 'optionalType', value: {item: primitive(P.UTF8)}}})), '(string) | null');
  assert.equal(typescriptType(create(TypeSchema)), 'unknown');
});

test('DDL identifiers and registry checks reject untrusted identifiers', () => {
  assert.equal(identifier('items_1'), '`items_1`');
  for (const name of ['x` DROP TABLE y', '../items', '', 'a/b']) {assert.throws(() => identifier(name));}
  assert.equal(validateTableSchema({items: {id: 'UTF8'}}, 'items', ['id']), true);
  assert.throws(() => validateTableSchema({}, 'toString', []));
  assert.throws(() => validateTableSchema({items: {}}, 'items', ['toString']));
});

test('createMigration writes a standalone template and validates names', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ydb-toolkit-unit-'));
  const file = await createMigration(dir, 'create_items');
  assert.match(await readFile(file, 'utf8'), /@andmider\/ydb-toolkit\/migrations/);
  assert.equal((await readdir(dir)).length, 1);
  await assert.rejects(createMigration(dir, '../unsafe'));
});

test('migration ledger is only updated after up and supports retry/down', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ydb-toolkit-migration-'));
  await writeFile(path.join(dir, '001_partial.mjs'), `export async function up(db) { db.attempts++; if(db.attempts === 1) throw new Error('partial'); }\nexport async function down(db) { db.rolledBack = true; }`);
  const applied = new Set();
  const db = {attempts: 0, rolledBack: false, listTables: async () => ['schema_migrations'],
    sql: async (text, value) => {
      if (typeof text === 'string') {return [[...[...applied].map(migration_name => ({migration_name}))]];}
      if (text.join('').startsWith('UPSERT')) {applied.add(value);} else {applied.delete(value);}
      return [];
    }};
  await assert.rejects(runMigrations(db, dir), /partial/);
  assert.equal(applied.size, 0);
  assert.deepEqual(await runMigrations(db, dir), ['001_partial.mjs']);
  assert.deepEqual(await runMigrations(db, dir), []);
  assert.equal(await rollbackMigration(db, dir), '001_partial.mjs');
  assert.equal(db.rolledBack, true); assert.equal(applied.size, 0);
});

test('dropNotNull resumes after intermediate DDL failure without losing the value', async () => {
  const columns = new Map([['id', false], ['value', false]]);
  const row = {value: 42};
  let failOnce = true;
  const db = {
    describeTable: async () => ({primaryKey: ['id'], indexes: [], columns: [...columns].map(([name, nullable]) => ({name, type: {type: nullable
      ? {case: 'optionalType', value: {item: {type: {case: 'typeId', value: P.INT64}}}}
      : {case: 'typeId', value: P.INT64}}}))}),
    sql: async text => {
      if (text.includes('ADD COLUMN `value_tmp`')) {columns.set('value_tmp', true);}
      else if (text.includes('SET `value_tmp`')) {row.value_tmp = row.value;}
      else if (text.includes('DROP COLUMN `value_tmp`')) {columns.delete('value_tmp'); delete row.value_tmp;}
      else if (text.includes('DROP COLUMN `value`')) {columns.delete('value'); delete row.value;}
      else if (text.includes('ADD COLUMN `value`')) {
        if (failOnce) {failOnce = false; throw new Error('interrupted');}
        columns.set('value', true);
      } else if (text.includes('SET `value`')) {row.value = row.value_tmp;}
    },
  };
  await assert.rejects(dropNotNull(db, 'items', 'value', 'INT64'), /interrupted/);
  assert.equal(row.value_tmp, 42);
  await dropNotNull(db, 'items', 'value', 'INT64');
  assert.equal(row.value, 42); assert.equal(columns.get('value'), true); assert.equal(columns.has('value_tmp'), false);
  await dropNotNull(db, 'items', 'value', 'INT64');
  await assert.rejects(dropNotNull(db, 'items', 'id', 'INT64'), /primary key/);
  await assert.rejects(dropNotNull(db, 'items', 'value', 'UTF8'), /Unexpected type/);
});

test('generator writes consumer paths, quoted fields and explicit nullable types', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ydb-toolkit-schema-'));
  const db = {listTables: async () => ['items'], describeTable: async () => ({columns: [
    {name: 'item-id', type: create(TypeSchema, {type: {case: 'typeId', value: P.UINT64}})},
  ]})};
  await generateTypes(db, {out: path.join(dir, 'types.ts'), registry: path.join(dir, 'tables.mjs')});
  assert.match(await readFile(path.join(dir, 'types.ts'), 'utf8'), /"item-id": bigint/);
  assert.match(await readFile(path.join(dir, 'tables.mjs'), 'utf8'), /ExistingTables/);
  await assert.rejects(generateTypes(db, {out: 'same', registry: 'same'}));
});

test('table interfaces cannot shadow built-in date, binary and array types', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ydb-toolkit-types-'));
  const primitive = value => create(TypeSchema, {type: {case: 'typeId', value}});
  const tags = create(TypeSchema, {type: {case: 'listType', value: {item:
    create(TypeSchema, {type: {case: 'optionalType', value: {item: primitive(P.UTF8)}}}),
  }}});
  await generateTypes({listTables: async () => ['array', 'date', 'uint8_array'], describeTable: async () => ({columns: [
    {name: 'at', type: primitive(P.TIMESTAMP)}, {name: 'binary', type: primitive(P.STRING)}, {name: 'tags', type: tags},
  ]})}, {out: path.join(dir, 'types.ts')});
  await writeFile(path.join(dir, 'consumer.ts'), `import type {Array as ArrayRow, Date as DateRow, Uint8Array as BytesRow} from './types.js';\nconst value = {at: new Date(), binary: new Uint8Array([1]), tags: ['x', null]};\nconst rows: [ArrayRow, DateRow, BytesRow] = [value, value, value];\nvoid rows;\n`);
  execFileSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'es2023', path.join(dir, 'consumer.ts')], {encoding: 'utf8'});
});

test('BulkUpsert timeout preserves the failure and reports the supplied label', async () => {
  const events = [];
  const client = Object.create(YdbClient.prototype);
  client.lifetime = new AbortController();
  client.driver = {database: '/local'};
  client.options = {logger: (level, event, details) => events.push({level, event, details})};
  let failure = null;
  client.table = {bulkUpsert: async (_request, {signal}) => await new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {failure = signal.reason; reject(failure);}, {once: true});
  })};
  await Promise.all([
    assert.rejects(client.bulkUpsert('items', {id: ydb.required.utf8('x')}, {timeoutMs: 5, label: 'items.write'}), error => error === failure),
    sleep(20),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'DB_QUERY_TIMEOUT');
  assert.equal(events[0].details.label, 'items.write');
  assert.equal(events[0].details.kind, 'bulkUpsert');
  assert.equal(events[0].details.role, 'single');
});
