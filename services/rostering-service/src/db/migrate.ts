import { readdir, readFile } from 'node:fs/promises';
import { SQL } from 'bun';

/**
 * Applies the SQL migrations in drizzle/ in lexical order, recording each one
 * so a rerun is a no-op. Plain SQL keeps the schema reviewable in a diff.
 *
 *   bun src/db/migrate.ts
 */
export async function applyMigrations(databaseUrl: string): Promise<void> {
  const migrationsDir = new URL('../../drizzle/', import.meta.url);
  const sql = new SQL(databaseUrl, { max: 1 });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = await sql<Array<{ name: string }>>`SELECT name FROM _migrations`;
    const done = new Set(applied.map((row) => row.name));

    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const contents = await readFile(new URL(file, migrationsDir), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      process.stdout.write(`applied ${file}\n`);
    }
  } finally {
    await sql.close({ timeout: 5 });
  }
}

if (import.meta.main) {
  await applyMigrations(process.env.ROSTERING_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/rostering');
  process.stdout.write('rostering migrations up to date\n');
}
