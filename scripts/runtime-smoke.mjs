import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AnonymousCredentialsProvider} from '@ydbjs/auth/anonymous';
import {YdbClient, ydb} from '@aderevyankin/ydb-toolkit';
import {connect, createTable, dropTable} from '@aderevyankin/ydb-toolkit/migrations';
import {generateTypes} from '@aderevyankin/ydb-toolkit/schema';

const runtime = process.versions.bun ? 'bun' : process.versions.deno ? 'deno' : 'node';
const table = `toolkit_runtime_${runtime}`;
const options = {connectionString: 'grpc://localhost:2140/local', driverOptions: {credentialsProvider: new AnonymousCredentialsProvider()}};
const db = await connect(options);
const client = await YdbClient.connect(options);
try {
  if ((await db.listTables()).includes(table)) {await dropTable(db, table);}
  await createTable(db, table, [
    {name: 'id', type: 'UINT64', comment: 'Synthetic key'},
    {name: 'metadata', type: 'OPTIONAL_JSON_DOCUMENT', comment: 'Optional JSON'},
  ], ['id']);
  const id = ydb.required.uint64(18446744073709551615n);
  await client.bulkUpsert(table, {id, metadata: ydb.optional.jsonDocument({ok: true})});
  const expected = {id: 18446744073709551615n, metadata: {ok: true}};
  const sql = await client.execute(`SELECT * FROM ${table} WHERE id = $id`, {$id: id}, {mode: 'read', hedge: false});
  assert.deepEqual(sql.resultSets[0][0], expected);
  const key = {table, key: {id}, columns: ['id', 'metadata']};
  assert.deepEqual((await client.readRow(key, {hedge: false})).resultSets[0][0], expected);
  const start = client.startAttempt;
  let cancelled = false;
  client.startAttempt = () => ({promise: new Promise(() => {}), cancel() {cancelled = true;}, node: {nodeId: null}, usage: {ru: null}});
  try {
    assert.deepEqual((await client.execute(`SELECT * FROM ${table}`, {}, {mode: 'read', hedge: {delayMs: 5, keyRead: key}})).resultSets[0][0], expected);
    assert(cancelled);
  } finally {client.startAttempt = start;}
  await assert.rejects(client.execute('SELECT 1', {}, {signal: AbortSignal.abort()}));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ydb-toolkit-runtime-'));
  await generateTypes(db, {out: path.join(dir, 'types.ts')});
  assert.match(await readFile(path.join(dir, 'types.ts'), 'utf8'), /bigint/);
} finally {
  await client.close();
  await dropTable(db, table);
  await db.close();
}
process.stdout.write(`${runtime}: SQL, Table API, hedge, cancellation, schema and close passed\n`);
