import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export interface Database {
  sql: postgres.Sql;
  db: PostgresJsDatabase<typeof schema>;
}

/**
 * The transaction-scoped client handed to drizzle and the outbox enqueue.
 * postgres' own typings make TransactionSql not assignable to Sql even though
 * it is one; the boundary is pinned once in withTransaction, not per call site.
 */
export type Tx = postgres.Sql;

/** A drizzle handle plus the raw postgres client pinned to one transaction. */
export interface ScopedTx {
  db: PostgresJsDatabase<typeof schema>;
  raw: postgres.Sql;
}

export function createDatabase(url: string): Database {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}
