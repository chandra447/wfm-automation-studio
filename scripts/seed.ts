/**
 * Seeds the demo tenant across all three databases. Idempotent: re-running
 * resets the demo rows rather than duplicating them.
 *
 *   bun run scripts/seed.ts
 */
import { demoWorkflows } from '@wfm/workflows';
import postgres from 'postgres';

const tenantId = process.env.DEMO_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const locationId = '33333333-3333-4333-8333-000000000001';

const employees = [
  {
    id: '44444444-4444-4444-8444-000000000001',
    name: 'Priya Raman',
    email: 'priya.raman@demo.test',
    rate: 6200,
    weeklyHours: 32,
    quals: ['RN', 'AGED_CARE'],
  },
  {
    id: '44444444-4444-4444-8444-000000000002',
    name: 'Aisha Khan',
    email: 'aisha.khan@demo.test',
    rate: 6100,
    weeklyHours: 24,
    quals: ['RN'],
  },
  {
    id: '44444444-4444-4444-8444-000000000003',
    name: 'Marcus Webb',
    email: 'marcus.webb@demo.test',
    rate: 6400,
    weeklyHours: 28,
    quals: ['RN', 'AGED_CARE', 'MEDICATION'],
  },
  {
    id: '44444444-4444-4444-8444-000000000004',
    name: 'Elena Fischer',
    email: 'elena.fischer@demo.test',
    rate: 8100,
    weeklyHours: 38,
    quals: ['RN', 'AGED_CARE'],
  },
  {
    id: '44444444-4444-4444-8444-000000000005',
    name: 'Tom Okafor',
    email: 'tom.okafor@demo.test',
    rate: 4800,
    weeklyHours: 20,
    quals: ['SUPPORT_WORKER'],
  },
] as const;

const cancelledShiftId = '22222222-2222-4222-8222-000000000003';
const completedShiftId = '22222222-2222-4222-8222-000000000005';
const timesheetId = '77777777-7777-4777-8777-000000000001';
const coverageWorkflowId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const payrollWorkflowId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

const rostering = postgres(process.env.ROSTERING_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/rostering', {
  onnotice: () => {},
});
const attendance = postgres(
  process.env.TIME_ATTENDANCE_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/time_attendance',
  { onnotice: () => {} },
);
const studio = postgres(process.env.STUDIO_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/studio', {
  onnotice: () => {},
});

async function seedRostering(): Promise<void> {
  await rostering`DELETE FROM shift_offers WHERE tenant_id = ${tenantId}`;
  await rostering`DELETE FROM shifts WHERE tenant_id = ${tenantId}`;
  await rostering`DELETE FROM employee_availability WHERE tenant_id = ${tenantId}`;
  await rostering`DELETE FROM employee_qualifications WHERE tenant_id = ${tenantId}`;
  await rostering`DELETE FROM employees WHERE tenant_id = ${tenantId}`;
  await rostering`DELETE FROM locations WHERE tenant_id = ${tenantId}`;

  await rostering`
    INSERT INTO locations (id, tenant_id, name, timezone)
    VALUES (${locationId}, ${tenantId}, 'Aurora Aged Care — Kew', 'Australia/Melbourne')
  `;

  for (const employee of employees) {
    await rostering`
      INSERT INTO employees (id, tenant_id, name, email, hourly_rate_cents, weekly_hours)
      VALUES (${employee.id}, ${tenantId}, ${employee.name}, ${employee.email}, ${employee.rate}, ${employee.weeklyHours})
    `;
    for (const code of employee.quals) {
      await rostering`
        INSERT INTO employee_qualifications (id, tenant_id, employee_id, code)
        VALUES (${crypto.randomUUID()}, ${tenantId}, ${employee.id}, ${code})
      `;
    }
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      await rostering`
        INSERT INTO employee_availability (id, tenant_id, employee_id, weekday, start_minute, end_minute)
        VALUES (${crypto.randomUUID()}, ${tenantId}, ${employee.id}, ${weekday}, 0, 1440)
      `;
    }
  }

  // The shift the coverage-rescue scenario cancels: tonight, RN + aged care,
  // currently covered by Priya at the baseline rate.
  await rostering`
    INSERT INTO shifts (
      id, tenant_id, location_id, role_name, required_qualification_codes,
      starts_at, ends_at, hourly_rate_cents, status, assigned_employee_id, baseline_cost_cents
    ) VALUES (
      ${cancelledShiftId}, ${tenantId}, ${locationId}, 'Registered Nurse',
      ${rostering.json(['RN', 'AGED_CARE'])},
      ${hoursFromNow(7.5)}, ${hoursFromNow(15.5)}, 6200, 'published',
      ${employees[0].id}, 49600
    )
  `;

  // A completed shift that produced the timesheet in the payroll scenario.
  await rostering`
    INSERT INTO shifts (
      id, tenant_id, location_id, role_name, required_qualification_codes,
      starts_at, ends_at, hourly_rate_cents, status, assigned_employee_id, baseline_cost_cents
    ) VALUES (
      ${completedShiftId}, ${tenantId}, ${locationId}, 'Registered Nurse',
      ${rostering.json(['RN', 'AGED_CARE'])},
      ${hoursFromNow(-14)}, ${hoursFromNow(-6)}, 6400, 'assigned',
      ${employees[2].id}, 51200
    )
  `;
}

async function seedAttendance(): Promise<void> {
  await attendance`DELETE FROM exceptions WHERE tenant_id = ${tenantId}`;
  await attendance`DELETE FROM adjustments WHERE tenant_id = ${tenantId}`;
  await attendance`DELETE FROM pay_lines WHERE tenant_id = ${tenantId}`;
  await attendance`DELETE FROM breaks WHERE tenant_id = ${tenantId}`;
  await attendance`DELETE FROM timesheets WHERE tenant_id = ${tenantId}`;
  await attendance`DELETE FROM award_rules WHERE tenant_id = ${tenantId}`;

  for (const employee of employees) {
    await attendance`
      INSERT INTO employees (id, tenant_id, name, hourly_rate_cents, award_rule_code)
      VALUES (${employee.id}, ${tenantId}, ${employee.name}, ${employee.rate}, NULL)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, hourly_rate_cents = EXCLUDED.hourly_rate_cents
    `;
  }

  await attendance`
    INSERT INTO award_rules (
      tenant_id, rule_code, name, max_ordinary_minutes_per_day, overtime_multiplier,
      break_required_after_minutes, unpaid_break_minutes, minimum_rest_hours_between_shifts, effective_from
    ) VALUES (
      ${tenantId}, 'MA000034', 'Nurses Award — Registered Nurse, day shift', 480, 1.5, 300, 30, 10,
      ${'2026-07-01T00:00:00.000Z'}
    )
  `;

  // Marcus clocked out of an 8.25 hour shift without taking the unpaid break.
  await attendance`
    INSERT INTO timesheets (
      id, tenant_id, employee_id, employee_name, shift_id, period_start, period_end, status,
      worked_minutes, ordinary_minutes, overtime_minutes, paid_minutes, total_pay_cents
    ) VALUES (
      ${timesheetId}, ${tenantId}, ${employees[2].id}, ${employees[2].name}, ${completedShiftId},
      ${hoursFromNow(-14)}, ${hoursFromNow(-6)}, 'open', 495, 480, 15, 480, 51200
    )
  `;

  await attendance`
    INSERT INTO pay_lines (id, tenant_id, timesheet_id, pay_type_code, description, minutes, rate_cents, multiplier, amount_cents)
    VALUES (${crypto.randomUUID()}, ${tenantId}, ${timesheetId}, 'ORD', 'Ordinary hours', 480, 6400, 1.0, 51200)
  `;
}

async function seedStudio(): Promise<void> {
  const workflowIds = [coverageWorkflowId, payrollWorkflowId];

  // A demo should start from a clean slate: leftovers from a previous run make
  // the approvals inbox and the run list unreadable.
  await studio`DELETE FROM approvals WHERE tenant_id = ${tenantId}`;
  await studio`DELETE FROM run_events`;
  await studio`DELETE FROM runs WHERE tenant_id = ${tenantId}`;
  await studio`DELETE FROM processed_events`;
  await studio`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`;
  await studio`DELETE FROM dead_letters WHERE tenant_id = ${tenantId}`;

  for (const workflowId of workflowIds) {
    await studio`DELETE FROM workflow_versions WHERE workflow_id = ${workflowId}`;
    await studio`DELETE FROM workflows WHERE workflow_id = ${workflowId}`;
  }

  const seeded = [
    { workflowId: coverageWorkflowId, template: demoWorkflows[0] },
    { workflowId: payrollWorkflowId, template: demoWorkflows[1] },
  ] as const;

  for (const { workflowId, template } of seeded) {
    const versionId = crypto.randomUUID();
    await studio`
      INSERT INTO workflows (workflow_id, tenant_id, name, description, enabled, draft_version_number, published_version_number)
      VALUES (${workflowId}, ${tenantId}, ${template.definition.name}, ${template.definition.description}, true, 1, 1)
    `;
    // jsonb parameters are passed as text and cast twice: a bare $n::jsonb with
    // a JSON string would store a jsonb string scalar, and the tagged template
    // rejects object parameters outright.
    await studio.unsafe(
      `INSERT INTO workflow_versions (
         version_id, workflow_id, tenant_id, version_number, status, definition, layout, diagnostics, created_by
       ) VALUES ($1, $2, $3, 1, 'published', $4::text::jsonb, $5::text::jsonb, $6::text::jsonb, 'seed')`,
      [
        versionId,
        workflowId,
        tenantId,
        JSON.stringify(template.definition),
        JSON.stringify(template.layout),
        JSON.stringify([]),
      ],
    );
  }
}

const only = (process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? 'all') as
  | 'all'
  | 'rostering'
  | 'attendance'
  | 'studio';

const targets: Array<{ name: typeof only; run: () => Promise<void> }> = [
  { name: 'rostering', run: seedRostering },
  { name: 'attendance', run: seedAttendance },
  { name: 'studio', run: seedStudio },
];

const selected = only === 'all' ? targets : targets.filter((target) => target.name === only);
if (selected.length === 0) {
  process.stderr.write(`unknown --only value "${only}" (expected all, rostering, attendance, or studio)\n`);
  process.exit(2);
}

for (const target of selected) {
  await target.run();
  process.stdout.write(`seeded ${target.name}\n`);
}

await Promise.all([rostering.end(), attendance.end(), studio.end()]);

process.stdout.write(
  `seeded tenant ${tenantId}: ${employees.length} employees, 2 shifts, 1 timesheet, ${demoWorkflows.length} published workflows\n`,
);
