CREATE TYPE shift_status AS ENUM ('draft', 'published', 'offered', 'assigned', 'cancelled');
CREATE TYPE shift_offer_status AS ENUM ('sent', 'accepted', 'declined', 'expired');

CREATE TABLE locations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL
);
CREATE INDEX locations_tenant_idx ON locations (tenant_id);

CREATE TABLE employees (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  hourly_rate_cents integer NOT NULL,
  weekly_hours integer NOT NULL
);
CREATE INDEX employees_tenant_idx ON employees (tenant_id);

CREATE TABLE employee_qualifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  code text NOT NULL
);
CREATE INDEX employee_qualifications_employee_idx ON employee_qualifications (employee_id);

CREATE TABLE employee_availability (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  weekday integer NOT NULL,
  start_minute integer NOT NULL,
  end_minute integer NOT NULL
);
CREATE INDEX employee_availability_employee_idx ON employee_availability (employee_id);

CREATE TABLE shifts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  role_name text NOT NULL,
  required_qualification_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  hourly_rate_cents integer NOT NULL,
  status shift_status NOT NULL DEFAULT 'draft',
  assigned_employee_id uuid,
  baseline_cost_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shifts_tenant_idx ON shifts (tenant_id);
CREATE INDEX shifts_assigned_idx ON shifts (assigned_employee_id);

CREATE TABLE shift_offers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  status shift_offer_status NOT NULL DEFAULT 'sent',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shift_offers_shift_employee_unique ON shift_offers (shift_id, employee_id);
CREATE INDEX shift_offers_shift_idx ON shift_offers (shift_id);

CREATE TABLE swap_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  requesting_employee_id uuid NOT NULL,
  target_employee_id uuid,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX swap_requests_shift_idx ON swap_requests (shift_id);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, key)
);
