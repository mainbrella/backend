import { BffError, checksum, migrationInput } from './contracts';
import { ProjectDatabase } from './database';
import { statements } from './sql';

export async function migrate(db: ProjectDatabase, input: ReturnType<typeof migrationInput.parse>) {
  const sql = statements(input.sql, true);
  const hash = await checksum(input.sql);
  const existing = async () => (await db.query([{ sql: 'SELECT * FROM _bff_migrations WHERE sequence=? OR name=?', params: [input.sequence, input.name] }]))[0].results;
  const check = (rows: Record<string, unknown>[]) => {
    if (!rows.length) return false;
    if (rows.length !== 1 || rows[0].sequence !== input.sequence || rows[0].name !== input.name || rows[0].checksum !== hash) throw new BffError('migration_conflict', 409);
    return true;
  };
  if (check(await existing())) return { applied: false, checksum: hash };
  try {
    // CHECK(sequence > 0) aborts the *whole batch* on a stale/out-of-order
    // sequence. The ledger insert and all DDL/backfills share one D1 transaction.
    await db.query([
      { sql: `INSERT INTO _bff_migrations (sequence,name,checksum,sql,applied_at)
        SELECT CASE WHEN COALESCE(MAX(sequence),0)+1=? THEN ? ELSE 0 END,?,?,?,? FROM _bff_migrations`,
        params: [input.sequence, input.sequence, input.name, hash, input.sql, new Date().toISOString()] },
      ...sql.map(statement => ({ sql: statement })),
    ]);
  } catch (error) {
    if (check(await existing())) return { applied: false, checksum: hash };
    const [latest] = await db.query([{ sql: 'SELECT COALESCE(MAX(sequence),0) AS sequence FROM _bff_migrations' }]);
    if (input.sequence !== Number(latest.results[0].sequence) + 1) throw new BffError('migration_out_of_order', 409);
    throw error;
  }
  return { applied: true, checksum: hash };
}

