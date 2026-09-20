import { and, desc, eq } from 'drizzle-orm';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { z } from 'zod';
import { builderRejectionSchema, type BuilderChatMessage, type BuilderRejection } from '@wfm/workflows';
import * as schema from '../db/schema.ts';

/**
 * The builder conversation, one row per turn. It is stored rather than kept in
 * the browser so a reload, or a different machine, resumes the same thread, and
 * so what the agent was told is auditable next to the graph it produced.
 *
 * The two jsonb columns carry no drizzle type, so a row is read back through
 * the schemas that wrote it: a rejection the applier never produced cannot
 * reach the wire.
 */

export type BuilderDb = BunSQLDatabase<typeof schema>;
export type BuilderMessageRow = typeof schema.builderMessages.$inferSelect;

const appliedSchema = z.array(z.string());
const rejectedSchema = z.array(builderRejectionSchema);

export interface BuilderTurnInput {
  workflowId: string;
  tenantId: string;
  role: BuilderChatMessage['role'];
  content: string;
  /** The model that answered; null on a user turn. */
  model: string | null;
  applied: readonly string[];
  rejected: readonly BuilderRejection[];
}

export class BuilderMessageStore {
  readonly #db: BuilderDb;

  constructor(db: BuilderDb) {
    this.#db = db;
  }

  /** Returns the row it wrote, so the caller sees the id and the time the thread got. */
  async appendTurn(turn: BuilderTurnInput): Promise<BuilderChatMessage> {
    const rows = await this.#db
      .insert(schema.builderMessages)
      .values({
        messageId: crypto.randomUUID(),
        workflowId: turn.workflowId,
        tenantId: turn.tenantId,
        role: turn.role,
        content: turn.content,
        model: turn.model,
        applied: [...turn.applied],
        rejected: [...turn.rejected],
      })
      .returning();
    const row = rows.at(0);
    if (row === undefined) throw new Error('the builder message insert returned no row');
    return messageOf(row);
  }

  /**
   * The most recent `limit` turns, oldest first: the prompt and the panel both
   * read the thread in order, and when a thread outgrows the limit the newest
   * turns are the ones worth keeping.
   */
  async listTurns(workflowId: string, tenantId: string, limit: number): Promise<BuilderChatMessage[]> {
    const rows = await this.#db
      .select()
      .from(schema.builderMessages)
      .where(and(eq(schema.builderMessages.workflowId, workflowId), eq(schema.builderMessages.tenantId, tenantId)))
      .orderBy(desc(schema.builderMessages.createdAt))
      .limit(limit);
    return rows.reverse().map(messageOf);
  }
}

function messageOf(row: BuilderMessageRow): BuilderChatMessage {
  return {
    messageId: row.messageId,
    role: row.role,
    content: row.content,
    at: row.createdAt.toISOString(),
    model: row.model,
    applied: appliedSchema.parse(row.applied ?? []),
    rejected: rejectedSchema.parse(row.rejected ?? []),
  };
}
