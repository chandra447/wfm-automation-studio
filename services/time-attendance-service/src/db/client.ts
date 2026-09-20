import { drizzle, type BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { SQL } from 'bun';
import * as schema from './schema.ts';

export interface Database {
  sql: SQL;
  db: BunSQLDatabase<typeof schema>;
}

/**
 * The transaction-scoped client handed to drizzle and the outbox enqueue.
 * TransactionSQL extends SQL, so the transaction client is assignable here
 * without a cast; the boundary is pinned once in withTransaction, not per call
 * site.
 */
export type Tx = SQL;

/** A drizzle handle plus the raw SQL client pinned to one transaction. */
export interface ScopedTx {
  db: BunSQLDatabase<typeof schema>;
  raw: SQL;
}

export function createDatabase(url: string): Database {
  const sql = new SQL(url, { max: 10 });
  const db = drizzle(sql, { schema });
  return { sql, db };
}
