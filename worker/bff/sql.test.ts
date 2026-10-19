import test from 'node:test';
import assert from 'node:assert/strict';
import { statements } from './sql';

test('SQLite scanning preserves quoted semicolons, escaped quotes, and comments', () => {
  const sql = `-- create; table\nCREATE TABLE notes(id TEXT, body TEXT);\nINSERT INTO notes VALUES('1','it''s a ; test'); /* ; */`;
  assert.equal(statements(sql, true).length, 2);
  assert.equal(statements(`SELECT ';', "semi;colon", 'it''s fine'; -- end`).length, 1);
  assert.equal(statements('/* ; */ SELECT 1;').length, 1);
});
test('SQL management reserves metadata and rejects unsupported schema escape hatches', () => {
  for (const sql of ['PRAGMA writable_schema=ON', 'ATTACH DATABASE \'other\' AS other', 'BEGIN', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END', 'CREATE VIRTUAL TABLE x USING fts5(body)', 'CREATE VIEW x AS SELECT 1']) {
    assert.throws(() => statements(sql, true), Error, sql);
  }
  for (const name of ['_bff_migrations', 'sqlite_schema', '_cf_KV']) for (const quote of ['', '"', "'", '`', '[']) {
    const quoted = quote + name + (quote === '[' ? ']' : quote);
    assert.throws(() => statements(`DROP TABLE ${quoted}`, true), /reserved_sql_name/);
    assert.throws(() => statements(`SELECT * FROM ${quoted}`), /reserved_sql_name/);
  }
  assert.throws(() => statements('SELECT 1; DELETE FROM notes'), /invalid_statement_count/);
  assert.throws(() => statements('CREATE TABLE x(id TEXT)'), /use_migration/);
  assert.throws(() => statements('SELECT /* unclosed'), /invalid_sql/);
  assert.throws(() => statements("SELECT 'unclosed"), /invalid_sql/);
});
