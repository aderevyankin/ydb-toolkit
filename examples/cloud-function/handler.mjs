import {YdbClient} from '@aderevyankin/ydb-toolkit';

let pending = null;
function client() {
  pending ??= YdbClient.connect({connectionString: process.env.YDB_CONNECTION_STRING})
    .catch(error => {pending = null; throw error;});
  return pending;
}

export async function handler() {
  const db = await client();
  const {resultSets} = await db.execute('SELECT 1 AS ok;', {}, {mode: 'read', hedge: false, timeoutMs: 3000});
  return {statusCode: 200, body: JSON.stringify(resultSets)};
}
