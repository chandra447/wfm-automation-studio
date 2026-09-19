import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.ROSTERING_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/rostering',
  },
});
