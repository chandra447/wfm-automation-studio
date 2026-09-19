-- Studio schema: workflow versions, runs, approvals, dedupe ledger, audit.
-- Mirrors services/studio-api/src/db/schema.ts; keep the two in step.

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  draft_version_number integer NOT NULL DEFAULT 1,
  published_version_number integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflows_tenant_idx ON workflows (tenant_id);

CREATE TABLE IF NOT EXISTS workflow_versions (
  version_id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  version_number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  definition jsonb NOT NULL,
  layout jsonb NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_versions_unique ON workflow_versions (workflow_id, version_number);
CREATE INDEX IF NOT EXISTS workflow_versions_tenant_idx ON workflow_versions (tenant_id);

CREATE TABLE IF NOT EXISTS runs (
  run_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  workflow_name text NOT NULL,
  trigger_event_id uuid NOT NULL,
  trigger_event_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled')),
  correlation_id uuid NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  actions_executed integer NOT NULL DEFAULT 0,
  summary text,
  error text
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_workflow_event_unique ON runs (workflow_id, trigger_event_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
CREATE INDEX IF NOT EXISTS runs_tenant_idx ON runs (tenant_id);

CREATE TABLE IF NOT EXISTS run_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL,
  seq integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  node_id text,
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  data jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS run_events_seq_unique ON run_events (run_id, seq);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  node_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),
  subject text NOT NULL,
  requested_from_role text NOT NULL,
  escalate_to text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  pay_impact_cents integer NOT NULL DEFAULT 0,
  proposal jsonb NOT NULL,
  decided_by text,
  decision_reason text,
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status);
CREATE INDEX IF NOT EXISTS approvals_run_idx ON approvals (run_id);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id uuid NOT NULL,
  consumer text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS processed_events_unique ON processed_events (event_id, consumer);

CREATE TABLE IF NOT EXISTS dead_letters (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  event_type text,
  reason text NOT NULL,
  raw text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid,
  workflow_id uuid,
  node_id text,
  action text NOT NULL,
  actor text NOT NULL,
  detail jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_run_idx ON audit_log (run_id);
