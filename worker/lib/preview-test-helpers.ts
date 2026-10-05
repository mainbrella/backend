import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function previewDatabase(sqlite: DatabaseSync): D1Database {
  sqlite.exec(readFileSync(new URL('../../preview-migrations/001_preview_routes.sql', import.meta.url), 'utf8'));
  return { prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind(...args: unknown[]) { values = args; return this; },
      first<T>() { return (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null; },
      run() { const result = sqlite.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  } } as unknown as D1Database;
}
