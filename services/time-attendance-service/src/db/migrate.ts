import postgres from 'postgres';
import { ensureOutboxTable } from '@wfm/outbox';

/**
 * Idempotent bootstrap: runs at deploy time (db:migrate) and again on boot so a
 * fresh environment only ever needs one command.
 */
const ddl = `
  CREATE TABLE IF NOT EXISTS employees (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    hourly_rate_cents integer NOT NULL,
    award_rule_code text
  );
  CREATE INDEX IF NOT EXISTS employees_tenant_idx ON employees (tenant_id);

  CREATE TABLE IF NOT EXISTS award_rules (
    tenant_id uuid NOT NULL,
    rule_code text NOT NULL,
    name text NOT NULL,
    max_ordinary_minutes_per_day integer NOT NULL,
    overtime_multiplier numeric(6,3) NOT NULL,
    break_required_after_minutes integer NOT NULL,
    unpaid_break_minutes integer NOT NULL,
    minimum_rest_hours_between_shifts numeric(5,2) NOT NULL,
    effective_from timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, rule_code)
  );

  CREATE TABLE IF NOT EXISTS timesheets (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    employee_name text NOT NULL,
    shift_id uuid,
    period_start timestamptz NOT NULL,
    period_end timestamptz,
    status text NOT NULL,
    worked_minutes integer NOT NULL DEFAULT 0,
    ordinary_minutes integer NOT NULL DEFAULT 0,
    overtime_minutes integer NOT NULL DEFAULT 0,
    paid_minutes integer NOT NULL DEFAULT 0,
    total_pay_cents integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS timesheets_tenant_idx ON timesheets (tenant_id);
  CREATE INDEX IF NOT EXISTS timesheets_employee_shift_idx ON timesheets (employee_id, shift_id);

  CREATE TABLE IF NOT EXISTS breaks (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    timesheet_id uuid NOT NULL REFERENCES timesheets (id),
    type text NOT NULL,
    started_at timestamptz,
    ended_at timestamptz,
    minutes integer NOT NULL,
    recorded_by text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS breaks_timesheet_idx ON breaks (timesheet_id);

  CREATE TABLE IF NOT EXISTS pay_lines (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    timesheet_id uuid NOT NULL REFERENCES timesheets (id),
    pay_type_code text NOT NULL,
    description text NOT NULL,
    minutes integer NOT NULL,
    rate_cents integer NOT NULL,
    multiplier numeric(6,3) NOT NULL,
    amount_cents integer NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pay_lines_timesheet_idx ON pay_lines (timesheet_id);

  CREATE TABLE IF NOT EXISTS exceptions (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    timesheet_id uuid NOT NULL REFERENCES timesheets (id),
    type text NOT NULL,
    award_rule_code text NOT NULL,
    detail text NOT NULL,
    overtime_minutes integer NOT NULL DEFAULT 0,
    estimated_pay_impact_cents integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'open',
    detected_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS exceptions_timesheet_idx ON exceptions (timesheet_id);
  CREATE INDEX IF NOT EXISTS exceptions_status_idx ON exceptions (status);

  CREATE TABLE IF NOT EXISTS adjustments (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    timesheet_id uuid NOT NULL REFERENCES timesheets (id),
    unpaid_break_minutes_delta integer NOT NULL,
    overtime_minutes_delta integer NOT NULL,
    pay_impact_cents integer NOT NULL,
    approved_by text NOT NULL,
    reason text NOT NULL,
    idempotency_key text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS adjustments_timesheet_idx ON adjustments (timesheet_id);

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    response text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idempotency_key)
  );
`;

export async function migrate(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(ddl);
    await ensureOutboxTable(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
