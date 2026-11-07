import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AnonymousCredentialsProvider} from '@ydbjs/auth/anonymous';
import {YdbClient, ydb} from '../dist/index.js';
import {connect, runMigrations, rollbackMigration, createTable, addIndex, dropNotNull} from '../dist/migrations.js';
import {generateTypes} from '../dist/schema.js';

const connectionString = 'grpc://localhost:2140/local';
if (new URL(connectionString).hostname !== 'localhost' || new URL(connectionString).port !== '2140') {
  throw new Error('DB tests only support the dedicated localhost:2140 database');
}
const options = {connectionString, driverOptions: {credentialsProvider: new AnonymousCredentialsProvider()}};

test('standalone local YDB integration', {timeout: 120000}, async t => {
  const db = await connect(options);
  const client = await YdbClient.connect(options);
  try {
    await t.test('SDK query-parameter connection URLs work for runtime and tooling', async () => {
      const queryOptions = {...options, connectionString: 'grpc://localhost:2140/?database=/local'};
      const other = await YdbClient.connect(queryOptions);
      try {assert.equal((await other.execute('SELECT 1 AS ok')).resultSets[0][0].ok, 1);}
      finally {await other.close();}
      const tools = await connect(queryOptions);
      try {assert.equal((await tools.sql('SELECT 1 AS ok'))[0][0].ok, 1);}
      finally {await tools.close();}
    });

    await t.test('diagnostic labels do not retain a query-text registry', async () => {
      const events = [];
      const other = await YdbClient.connect({...options, logger: (_level, event) => events.push(event)});
      try {
        for (let i = 0; i < 1000; i++) {
          await assert.rejects(other.execute('SELECT 1', {}, {label: `request-${i}`, timeoutMs: 0}));
        }
        await other.execute('SELECT 1', {}, {label: 'same'});
        await other.execute('SELECT 2', {}, {label: 'same'});
        assert.equal(Object.hasOwn(other, 'labels'), false);
        assert.equal(events.includes('QUERY_KEY_TEXT_MISMATCH'), false);
      } finally {await other.close();}
    });

    for (const table of ['toolkit_rows', 'toolkit_indexed', 'toolkit_nullable', 'items', 'schema_migrations']) {
      if ((await db.listTables()).includes(table)) {await db.sql(`DROP TABLE \`${table}\``);}
    }
    await createTable(db, 'toolkit_rows', [
      {name: 'id', type: 'UTF8', comment: 'Synthetic primary key'},
      {name: 'signed', type: 'INT64', comment: 'Signed boundary'},
      {name: 'unsigned', type: 'UINT64', comment: 'Unsigned boundary'},
      {name: 'metadata', type: 'OPTIONAL_JSON_DOCUMENT', comment: 'JSON value'},
      {name: 'note', type: 'OPTIONAL_UTF8', comment: 'Nullable text'},
      {name: 'created', type: 'TIMESTAMP', comment: 'UTC timestamp'},
    ], ['id']);
    const created = new Date('2026-01-02T03:04:05Z');
    const params = {$id: ydb.required.utf8('test'), $signed: ydb.required.int64(-(1n << 63n)),
      $unsigned: ydb.required.uint64((1n << 64n) - 1n), $metadata: ydb.optional.jsonDocument({ok: true}),
      $note: ydb.optional.utf8(null), $created: ydb.required.timestamp(created)};
    await client.bulkUpsert('toolkit_rows', Object.fromEntries(Object.entries(params).map(([key, value]) => [key.slice(1), value])));
    const sql = 'SELECT * FROM toolkit_rows WHERE id = $id';
    const key = {table: 'toolkit_rows', key: {id: params.$id}, columns: ['id', 'signed', 'unsigned', 'metadata', 'note', 'created']};

    await t.test('SQL, ReadRows and ReadTable retain bigint, JSON, null and dates', async () => {
      const primary = await client.execute(sql, {$id: params.$id}, {mode: 'read', hedge: false});
      const table = await client.readRow(key, {hedge: false});
      assert.deepEqual(table, primary);
      assert.equal(primary.resultSets[0][0].unsigned, (1n << 64n) - 1n);
      assert.equal(primary.resultSets[0][0].signed, -(1n << 63n));
      assert.equal(primary.resultSets[0][0].note, null);
      assert.deepEqual(primary.resultSets[0][0].metadata, {ok: true});
      assert.deepEqual(primary.resultSets[0][0].created, created);
    });

    await t.test('missing PK gives an empty set; expect mismatch is an error', async () => {
      const missing = {...key, key: {id: ydb.required.utf8('absent')}};
      assert.deepEqual((await client.readRow(missing, {hedge: false})).resultSets, [[]]);
      await assert.rejects(client.readRow({...key, expect: () => false}, {hedge: false}), /no matching row/);
    });

    await t.test('ReadTable hedge wins a stalled SQL attempt and cancels it', async () => {
      const start = client.startAttempt;
      let cancelled = false;
      client.startAttempt = () => ({promise: new Promise(() => {}), cancel: () => {cancelled = true;}, node: {nodeId: null}, usage: {ru: null}});
      try {
        const result = await client.execute(sql, {$id: params.$id}, {mode: 'read', hedge: {delayMs: 5, keyRead: key}});
        assert.equal(result.resultSets[0][0].id, 'test');
        assert.equal(result.resultSets[0][0].unsigned, (1n << 64n) - 1n);
        assert.equal(cancelled, true);
      } finally {client.startAttempt = start;}
    });

    await t.test('writes reject hedge options and do not launch duplicates', async () => {
      await assert.rejects(client.execute('SELECT 1', {}, {hedge: {delayMs: 1}}), /only allowed/);
      const logs = [];
      const other = await YdbClient.connect({...options, logger: (...args) => logs.push(args)});
      try {
        await other.execute('UPSERT INTO toolkit_rows (id, signed, unsigned, created) VALUES ($id, $signed, $unsigned, $created)',
          {$id: params.$id, $signed: params.$signed, $unsigned: params.$unsigned, $created: params.$created});
        assert.equal(logs.some(entry => entry[1] === 'DB_QUERY_HEDGE'), false);
      } finally {await other.close();}
    });

    await t.test('abort propagates to Table API and pre-aborted SQL never starts', async () => {
      await assert.rejects(client.execute('SELECT 1', {}, {signal: AbortSignal.abort()}));
      await assert.rejects(client.readRow(key, {signal: AbortSignal.abort()}));
      const original = client.table.readRows;
      let aborted = false;
      client.table.readRows = async (_request, {signal}) => await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {aborted = true; reject(signal.reason);}, {once: true});
      });
      try {
        const controller = new AbortController();
        const result = client.readRow(key, {signal: controller.signal, hedge: false});
        controller.abort();
        await assert.rejects(result);
        assert.equal(aborted, true);
      } finally {client.table.readRows = original;}
    });

    await t.test('Table API rejects indexed tables on the pinned server', async () => {
      await createTable(db, 'toolkit_indexed', [
        {name: 'id', type: 'UTF8', comment: 'Key'}, {name: 'value', type: 'OPTIONAL_UTF8', comment: 'Indexed field'},
      ], ['id']);
      await addIndex(db, 'toolkit_indexed', 'by_value', ['value']);
      await assert.rejects(client.readRow({table: 'toolkit_indexed', key: {id: params.$id}, columns: ['id']}, {hedge: false}));
      await assert.rejects(client.bulkUpsert('toolkit_indexed', {id: params.$id, value: ydb.optional.utf8('x')}));
    });

    await t.test('migration apply/reapply/down and schema outputs work with consumer paths', async () => {
      const migrations = path.resolve('examples/local/migrations');
      assert.deepEqual(await runMigrations(db, migrations), ['001_create_items.mjs']);
      assert.deepEqual(await runMigrations(db, migrations), []);
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ydb-toolkit-local-'));
      await generateTypes(db, {out: path.join(dir, 'types.ts'), registry: path.join(dir, 'tables.mjs')});
      const generated = await readFile(path.join(dir, 'types.ts'), 'utf8');
      assert.match(generated, /"unsigned": bigint/);
      assert.match(generated, /"note": \(string\) \| null/);
      assert.match(generated, /"metadata": \(unknown\) \| null/);
      assert.equal(await rollbackMigration(db, migrations), '001_create_items.mjs');
    });

    await t.test('dropNotNull preserves real data and is re-runnable', async () => {
      await createTable(db, 'toolkit_nullable', [
        {name: 'id', type: 'UTF8', comment: 'Key'}, {name: 'value', type: 'INT64', comment: 'Non-null field'},
      ], ['id']);
      await db.sql`UPSERT INTO toolkit_nullable (id, value) VALUES (${'one'}, ${42n})`;
      await dropNotNull(db, 'toolkit_nullable', 'value', 'INT64');
      await dropNotNull(db, 'toolkit_nullable', 'value', 'INT64');
      const [rows] = await db.sql('SELECT value FROM toolkit_nullable');
      assert.equal(rows[0].value, 42n);
      const info = await db.describeTable('toolkit_nullable');
      assert.equal(info.columns.find(c => c.name === 'value').type.type.case, 'optionalType');
    });
  } finally {
    await client.close();
    await client.close();
    await assert.rejects(client.execute('SELECT 1'));
    await db.close();
    await db.close();
  }
});
