import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await mkdtemp(path.join(os.tmpdir(), 'ydb-toolkit-pack-'));
const run = (file, args, cwd = directory) => execFileSync(file, args, {cwd, encoding: 'utf8', timeout: 120000});
const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], process.cwd()))[0];
assert(packed.files.some(file => file.path === 'dist/index.d.ts'));
assert(!packed.files.some(file => /(?:node_modules|\.env|AGENTS\.md)/.test(file.path)));
await writeFile(path.join(directory, 'package.json'), JSON.stringify({type: 'module', private: true}));
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(directory, packed.filename)]);
await writeFile(path.join(directory, 'smoke.mjs'), `import assert from 'node:assert/strict';
import {YdbClient, ydb} from '@andmider/ydb-toolkit';
import {connect, runMigrations, rollbackMigration} from '@andmider/ydb-toolkit/migrations';
import {generateTypes} from '@andmider/ydb-toolkit/schema';
import {AnonymousCredentialsProvider} from '@ydbjs/auth/anonymous';
const options = {connectionString: 'grpc://localhost:2140/local', driverOptions: {credentialsProvider: new AnonymousCredentialsProvider()}};
const client = await YdbClient.connect(options);
try {
  const {resultSets} = await client.execute('SELECT $id AS id', {$id: ydb.required.uint64(18446744073709551615n)}, {mode: 'read', hedge: false});
  assert.equal(resultSets[0][0].id, 18446744073709551615n);
} finally {await client.close();}
const db = await connect(options);
try {
  await runMigrations(db, './migrations');
  assert.deepEqual(await runMigrations(db, './migrations'), []);
  await generateTypes(db, {out: './types.ts', registry: './tables.mjs'});
  await rollbackMigration(db, './migrations');
} finally {await db.close();}
`);
const cli = path.join(directory, 'node_modules/@andmider/ydb-toolkit/dist/cli.js');
assert.match(run(process.execPath, [cli, '--help']), /migrate/);
run(process.execPath, [cli, 'create', 'create_items', '--dir', 'migrations']);
run(process.execPath, ['smoke.mjs']);
assert.match(await readFile(path.join(directory, 'types.ts'), 'utf8'), /interface Items/);
await writeFile(path.join(directory, 'consumer.ts'), `import {YdbClient, ydb} from '@andmider/ydb-toolkit';
import {generateTypes} from '@andmider/ydb-toolkit/schema';
import {connect, createTable} from '@andmider/ydb-toolkit/migrations';
declare const client: YdbClient;
client.execute('SELECT $id', {$id: ydb.required.int64(9007199254740993n)}, {mode: 'read'});
// @ts-expect-error Writes must not accept hedge options.
client.execute('UPSERT', {}, {mode: 'write', hedge: {delayMs: 1}});
void connect; void createTable; void generateTypes;
`);
run(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
  '--module', 'nodenext', '--target', 'es2023', '--lib', 'es2023,esnext.disposable', 'consumer.ts', 'types.ts']);
await writeFile(path.join(directory, 'handler.mjs'), await readFile('examples/cloud-function/handler.mjs', 'utf8'));
const esbuild = path.resolve('node_modules/esbuild/bin/esbuild');
run(esbuild, ['handler.mjs', '--bundle', '--platform=node', '--format=cjs', '--outfile=handler.cjs', '--log-level=error']);
assert.equal(run(process.execPath, ['-e', "process.stdout.write(typeof require('./handler.cjs').handler)"]), 'function');
process.stdout.write(`Tarball installed and DB smoke passed in ${directory}\n`);
