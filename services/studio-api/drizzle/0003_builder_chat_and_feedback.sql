-- Steering feedback on a human decision, and the builder conversation.
-- Mirrors services/studio-api/src/db/schema.ts; keep the two in step.

-- What the approver told the workflow to do, when they said more than yes or
-- no. The engine turns this into the next human message in the run.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS feedback text;

-- One row per builder turn, so the conversation survives a reload and what the
-- agent was told stays next to the graph it produced.
CREATE TABLE IF NOT EXISTS builder_messages (
  message_id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  model text,
  applied jsonb,
  rejected jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_messages_workflow_idx ON builder_messages (workflow_id);
