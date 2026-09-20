-- Provider settings, model call accounting, and run artifacts.
-- Mirrors services/studio-api/src/db/schema.ts; keep the two in step.

-- One row per tenant. A customer-supplied key is stored encrypted with
-- LLM_CONFIG_SECRET and is never returned by the API, only its last four
-- characters so an operator can tell which key is in use.
CREATE TABLE IF NOT EXISTS llm_provider_settings (
  tenant_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('platform', 'openai-compatible', 'anthropic', 'none')),
  base_url text,
  model text,
  api_key_ciphertext text,
  api_key_last4 text,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per model call. Tokens come from the provider's own usage report, so
-- the dashboard total is auditable back to the call that produced it.
CREATE TABLE IF NOT EXISTS llm_calls (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  node_id text NOT NULL,
  provider_kind text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_calls_run_idx ON llm_calls (run_id);
CREATE INDEX IF NOT EXISTS llm_calls_tenant_idx ON llm_calls (tenant_id);

-- A document a run produced from its own data, rendered from a template.
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  node_id text NOT NULL,
  name text NOT NULL,
  format text NOT NULL CHECK (format IN ('markdown', 'json')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts (run_id);
