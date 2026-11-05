import {createTable, dropTable} from '@aderevyankin/ydb-toolkit/migrations';

export async function up(db) {
  if ((await db.listTables()).includes('items')) {return;}
  await createTable(db, 'items', [
    {name: 'id', type: 'UINT64', comment: 'Item primary key'},
    {name: 'title', type: 'OPTIONAL_UTF8', comment: 'Optional item title'},
    {name: 'metadata', type: 'OPTIONAL_JSON_DOCUMENT', comment: 'Application metadata'},
  ], ['id']);
}

export async function down(db) {
  await dropTable(db, 'items');
}
