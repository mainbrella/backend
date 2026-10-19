import { BffError, LIMITS } from './contracts';

// A deliberately small SQLite surface, not a general-purpose SQL parser. Quoted
// text and comments are scanned before splitting so semicolons inside values work.
// Triggers, views, PRAGMA, transactions and virtual tables are outside v0.0.1.
export function statements(source: string, migration = false): string[] {
  if (new TextEncoder().encode(source).length > LIMITS.sqlBytes) throw new BffError('sql_too_large', 413);
  const result: string[] = [];
  let start = 0, position = 0, tokens: string[] = [];
  const finish = (end: number) => {
    if (!tokens.length) return;
    const head = tokens.slice(0, 3).join(' ').toUpperCase();
    const data = /^(SELECT|INSERT|UPDATE|DELETE)\b/.test(head);
    const ddl = /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE|DROP TABLE|DROP INDEX)\b/.test(head);
    if (!(data || migration && ddl)) throw new BffError(migration ? 'unsupported_migration' : 'use_migration_for_schema_changes');
    result.push(source.slice(start, end).trim());
    tokens = [];
  };
  while (position < source.length) {
    const char = source[position], next = source[position + 1];
    if (/\s/.test(char)) { position++; continue; }
    if (char === '-' && next === '-') {
      position = source.indexOf('\n', position + 2);
      if (position < 0) { position = source.length; break; }
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', position + 2);
      if (end < 0) throw new BffError('invalid_sql');
      position = end + 2; continue;
    }
    if (char === ';') { finish(position); start = ++position; continue; }
    let token = '';
    if (['"', "'", '`', '['].includes(char)) {
      const close = char === '[' ? ']' : char;
      position++;
      let closed = false;
      while (position < source.length) {
        if (source[position] === close) {
          if (close !== ']' && source[position + 1] === close) { token += close; position += 2; continue; }
          position++; closed = true; break;
        }
        token += source[position++];
      }
      if (!closed) throw new BffError('invalid_sql');
    } else if (/[a-zA-Z_]/.test(char)) {
      const begin = position++;
      while (position < source.length && /[a-zA-Z0-9_$]/.test(source[position])) position++;
      token = source.slice(begin, position);
    } else { position++; continue; }
    // SQLite accepts string literals as identifiers in some DDL positions, so
    // reserve these names even when single-quoted. No customer can edit a ledger.
    if (/^(?:_bff_|sqlite_|_cf_)/i.test(token)) throw new BffError('reserved_sql_name');
    tokens.push(token);
  }
  finish(position);
  if (!result.length || result.length > (migration ? LIMITS.migrationStatements : 1)) throw new BffError('invalid_statement_count');
  return result;
}

export function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(value) || /^(sqlite_)/i.test(value)) throw new BffError('invalid_identifier');
  return `"${value}"`;
}
