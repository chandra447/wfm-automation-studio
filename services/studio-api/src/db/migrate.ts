/**
 * Applies the SQL migrations in drizzle/ in lexical order, recording each one
 * so a rerun is a no-op. Plain SQL keeps the schema reviewable in a diff.
 *
 *   bun src/db/migrate.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { SQL } from 'bun';

const databaseUrl = process.env.STUDIO_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/studio';
const migrationsDir = new URL('../../drizzle/', import.meta.url);

const sql = new SQL(databaseUrl, { max: 1 });

await sql`
  CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

const applied: Array<{ name: string }> = await sql`SELECT name FROM _migrations`;
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

await sql.close();
process.stdout.write('studio migrations up to date\n');
