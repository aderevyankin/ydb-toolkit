import {ydb} from '@aderevyankin/ydb-toolkit';
import {openLocal} from './connect.mjs';

const db = await openLocal();
try {
  const {resultSets} = await db.execute('SELECT $id AS id;', {
    $id: ydb.required.uint64(18446744073709551615n),
  }, {mode: 'read', hedge: false});
  process.stdout.write(`${String(resultSets[0][0].id)}\n`);
} finally {
  await db.close();
}
