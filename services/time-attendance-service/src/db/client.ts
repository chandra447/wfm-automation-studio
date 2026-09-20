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
  const db = drizzle(sql, { schema });
  /**
   * drizzle replaces the json/jsonb serializers with pass-throughs because it
   * stringifies json itself; the outbox's raw template inserts pass plain
   * objects, so the default JSON serializers go back.
   */
  sql.options.serializers[114] = (value: unknown) => JSON.stringify(value);
  sql.options.serializers[3802] = (value: unknown) => JSON.stringify(value);
  return { sql, db };
}
