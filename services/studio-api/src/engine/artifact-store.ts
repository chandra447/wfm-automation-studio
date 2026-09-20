import { and, desc, eq } from 'drizzle-orm';
import type { Artifact, ArtifactDetail } from '@wfm/contracts';
import { artifacts } from '../db/schema.ts';
import type { RunDb } from './run-store.ts';

/**
 * Run artifacts: documents a run rendered from its own data. Reads are tenant
 * scoped, and a run's artifacts are listed in the order they were produced.
 */

export interface InsertArtifactInput {
  tenantId: string;
  runId: string;
  nodeId: string;
  name: string;
  format: 'markdown' | 'json';
  content: string;
}

function toArtifact(row: typeof artifacts.$inferSelect): Artifact {
  return {
    artifactId: row.artifactId,
    runId: row.runId,
    nodeId: row.nodeId,
    name: row.name,
    format: row.format,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertArtifact(db: RunDb, input: InsertArtifactInput): Promise<Artifact> {
  const [row] = await db
    .insert(artifacts)
    .values({
      artifactId: crypto.randomUUID(),
      tenantId: input.tenantId,
      runId: input.runId,
      nodeId: input.nodeId,
      name: input.name,
      format: input.format,
      content: input.content,
    })
    .returning();
  if (row === undefined) throw new Error('artifact insert returned no row');
  return toArtifact(row);
}

export async function listArtifactsForRun(db: RunDb, tenantId: string, runId: string): Promise<Artifact[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.tenantId, tenantId), eq(artifacts.runId, runId)))
    .orderBy(desc(artifacts.createdAt));
  return rows.map(toArtifact);
}

export async function getArtifact(
  db: RunDb,
  tenantId: string,
  artifactId: string,
): Promise<ArtifactDetail | null> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.tenantId, tenantId), eq(artifacts.artifactId, artifactId)))
    .limit(1);
  if (row === undefined) return null;
  return {
    ...toArtifact(row),
    content: row.content,
    contentType: row.format === 'markdown' ? 'text/markdown' : 'application/json',
  };
}
