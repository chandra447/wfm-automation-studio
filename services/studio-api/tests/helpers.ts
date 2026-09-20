import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { InMemoryEventBus } from '@wfm/eventbus';
import { createLogger } from '@wfm/observability';
import type { SQL } from 'bun';
import { createTestDatabase, demo, type TestDatabase } from '@wfm/testkit';
import type { ActorContext, RunEvent, RunStatus } from '@wfm/contracts';
import type { CandidateList, CreateOffersRequest, Shift, TimesheetDetailResponse } from '@wfm/contracts';
import type { QueueGateway } from '../src/engine/scope.ts';
import type { Orchestrator } from '../src/engine/orchestrator.ts';
import type { DomainClients } from '../src/engine/domain-clients.ts';
import { createLlmServices } from '../src/llm/index.ts';
import { RulesProposer, type Proposer } from '../src/engine/nodes/proposers.ts';
import { createEngine } from '../src/engine/index.ts';
import type { EngineService } from '../src/engine/contract.ts';
import { connectStudioDb, ensureStudioTables } from '../src/engine/db.ts';
import type { RunDb } from '../src/engine/run-store.ts';

/**
 * Test harness: a throwaway Postgres database, an in-memory bus, stub domain
 * clients that record every command, and an inline queue gateway that runs the
 * orchestrator directly (no Redis, no BullMQ).
 */

export const TENANT = demo.tenantId;

export const managerActor = { tenantId: TENANT, userId: demo.manager.userId, roles: [...demo.manager.roles] };
export const peopleOpsActor = { tenantId: TENANT, userId: demo.peopleOps.userId, roles: [...demo.peopleOps.roles] };

export const SHIFT_ID = '22222222-2222-4222-8222-000000000003';
export const TIMESHEET_ID = '77777777-7777-4777-8777-000000000001';

export const recorded = {
  offers: [] as Array<{ shiftId: string; body: CreateOffersRequest; idempotencyKey: string }>,
  assignments: [] as Array<{ shiftId: string; employeeId: string; idempotencyKey: string }>,
  adjustments: [] as Array<{ timesheetId: string; unpaidBreakMinutesDelta: number; overtimeMinutesDelta: number; idempotencyKey: string }>,
  timesheetApprovals: [] as Array<{ timesheetId: string; decision: 'approve' | 'reject' }>,
};

const shiftFixture: Shift = {
  shiftId: SHIFT_ID,
  tenantId: TENANT,
  locationId: '33333333-3333-4333-8333-000000000001',
  locationName: 'Aurora Aged Care — Kew',
  roleName: 'Registered Nurse',
  requiredQualificationCodes: ['RN'],
  startsAt: '2026-09-21T04:00:00.000Z',
  endsAt: '2026-09-21T12:00:00.000Z',
  hourlyRateCents: 6200,
  status: 'cancelled',
  assignedEmployeeId: null,
};

export const BEST_FIT_ID = demo.employees.bestFit.id;
export const EXPENSIVE_ID = demo.employees.expensive.id;
export const UNQUALIFIED_ID = demo.employees.unqualified.id;

export const candidatesFixture: CandidateList = {
  shiftId: SHIFT_ID,
  candidates: [
    {
      employeeId: BEST_FIT_ID,
      employeeName: demo.employees.bestFit.name,
      qualificationCodes: ['RN', 'MEDICATION'],
      hourlyRateCents: 6400,
      estimatedCostCents: 44800,
      costDeltaVsBaselineCents: 5_000,
      overtimeRisk: 'none',
      restHoursBeforeShift: 20,
      meetsRestRule: true,
      score: 0.9,
      reasons: ['medication qualified'],
    },
    {
      employeeId: EXPENSIVE_ID,
      employeeName: demo.employees.expensive.name,
      qualificationCodes: ['RN'],
      hourlyRateCents: 8100,
      estimatedCostCents: 58000,
      costDeltaVsBaselineCents: 20_000,
      overtimeRisk: 'high',
      restHoursBeforeShift: 20,
      meetsRestRule: true,
      score: 0.8,
      reasons: ['high overtime risk'],
    },
    {
      employeeId: UNQUALIFIED_ID,
      employeeName: demo.employees.unqualified.name,
      qualificationCodes: ['RN'],
      hourlyRateCents: 7_000,
      estimatedCostCents: 51_000,
      costDeltaVsBaselineCents: 12_000,
      overtimeRisk: 'none',
      restHoursBeforeShift: 4,
      meetsRestRule: false,
      score: 0.5,
      reasons: ['below minimum rest'],
    },
  ],
  generatedAt: new Date().toISOString(),
};

export const timesheetFixture: TimesheetDetailResponse = {
  timesheet: {
    timesheetId: TIMESHEET_ID,
    tenantId: TENANT,
    employeeId: demo.employees.bestFit.id,
    employeeName: demo.employees.bestFit.name,
    shiftId: '22222222-2222-4222-8222-000000000005',
    periodStart: '2026-09-14T00:00:00.000Z',
    periodEnd: '2026-09-20T23:59:59.000Z',
    status: 'open',
    workedMinutes: 495,
    ordinaryMinutes: 420,
    overtimeMinutes: 75,
    paidMinutes: 495,
    totalPayCents: 52_800,
    breaks: [],
    payLines: [
      {
        payTypeCode: 'ORD',
        description: 'Ordinary hours',
        minutes: 420,
        rateCents: 6_400,
        multiplier: 1,
        amountCents: 44_800,
      },
      {
        payTypeCode: 'OVT',
        description: 'Overtime',
        minutes: 75,
        rateCents: 6_400,
        multiplier: 2,
        amountCents: 16_000,
      },
    ],
    exceptions: [
      {
        exceptionId: '88888888-8888-4888-8888-000000000009',
        timesheetId: TIMESHEET_ID,
        type: 'missed_break',
        awardRuleCode: 'MA000034',
        detail: 'Unpaid 30 minute break not recorded on an 8.25 hour shift',
        overtimeMinutes: 75,
        estimatedPayImpactCents: 8_240,
        status: 'open',
        detectedAt: new Date().toISOString(),
      },
    ],
  },
  awardRule: {
    ruleCode: 'MA000034',
    name: 'Aged Care Award',
    maxOrdinaryMinutesPerDay: 570,
    overtimeMultiplier: 2,
    breakRequiredAfterMinutes: 300,
    unpaidBreakMinutes: 30,
    minimumRestHoursBetweenShifts: 10,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  },
};

export function stubDomainClients(): DomainClients {
  return {
    rostering: {
      getShift: async (tenantId, shiftId) => {
        if (tenantId !== TENANT || shiftId !== SHIFT_ID) {
          throw new Error(`unknown shift ${shiftId} for tenant ${tenantId}`);
        }
        return shiftFixture;
      },
      listCandidates: async (_tenantId, _shiftId, options) => {
        const excluded = new Set(options?.excludeEmployeeIds ?? []);
        const candidates = candidatesFixture.candidates.filter((candidate) => !excluded.has(candidate.employeeId));
        return { ...candidatesFixture, candidates };
      },
      createOffers: async (_tenantId, shiftId, body, idempotencyKey) => {
        recorded.offers.push({ shiftId, body, idempotencyKey });
        return {
          shiftId,
          offers: body.employeeIds.map((employeeId) => ({
            offerId: crypto.randomUUID(),
            employeeId,
            status: 'sent' as const,
          })),
        };
      },
      assignEmployee: async (_tenantId, shiftId, body, idempotencyKey) => {
        recorded.assignments.push({ shiftId, employeeId: body.employeeId, idempotencyKey });
        return { ...shiftFixture, status: 'assigned', assignedEmployeeId: body.employeeId };
      },
      cancelShift: async () => {
        return { ...shiftFixture, status: 'cancelled' as const };
      },
    },
    attendance: {
      getTimesheet: async (tenantId, timesheetId) => {
        if (tenantId !== TENANT || timesheetId !== TIMESHEET_ID) {
          throw new Error(`unknown timesheet ${timesheetId}`);
        }
        return timesheetFixture;
      },
      listExceptions: async () => timesheetFixture.timesheet.exceptions,
      getAwardRule: async () => timesheetFixture.awardRule,
      applyAdjustment: async (tenantId, timesheetId, body, idempotencyKey) => {
        if (tenantId !== TENANT) throw new Error(`unknown tenant ${tenantId}`);
        recorded.adjustments.push({
          timesheetId,
          unpaidBreakMinutesDelta: body.unpaidBreakMinutesDelta,
          overtimeMinutesDelta: body.overtimeMinutesDelta,
          idempotencyKey,
        });
        return {
          timesheetId,
          adjustmentId: '88888888-8888-4888-8888-000000000001',
          unpaidBreakMinutesDelta: body.unpaidBreakMinutesDelta,
          overtimeMinutesDelta: body.overtimeMinutesDelta,
          payImpactCents: -11_200,
          appliedBy: 'studio-engine',
        };
      },
      decideTimesheet: async (_tenantId, timesheetId, body) => {
        recorded.timesheetApprovals.push({ timesheetId, decision: body.decision });
        return { timesheet: { ...timesheetFixture.timesheet, status: body.decision === 'approve' ? 'approved' as const : 'open' as const } };
      },
      clockOut: async (_tenantId, _shiftId, body) => {
        return {
          timesheet: { ...timesheetFixture.timesheet, employeeId: body.employeeId },
          emittedEvents: ['attendance.clock_out_recorded', 'attendance.missed_break', 'timesheet.exception_raised'],
        };
      },
    },
  };
}

export interface Harness {
  engine: EngineService;
  databaseUrl: string;
  orchestrator: Orchestrator;
  proposer: Proposer;
  bus: InMemoryEventBus;
  db: RunDb;
  sql: SQL;
  timeouts: Array<{ tenantId: string; runId: string; approvalId: string; runAt: Date }>;
  drop: () => Promise<void>;
}

export interface HarnessOptions {
  proposer?: Proposer;
  /** Supply a Postgres-backed saver to prove state outlives the engine instance. */
  checkpointer?: BaseCheckpointSaver;
  /** Reuse an existing database, e.g. to bring a second engine up over the same state. */
  databaseUrl?: string;
}

export async function createHarness(options?: HarnessOptions): Promise<Harness> {
  const database: TestDatabase = options?.databaseUrl
    ? { url: options.databaseUrl, drop: async () => {} }
    : await createTestDatabase(
        'postgres://wfm:wfm@127.0.0.1:5433/studio',
        `studio_test_${Math.random().toString(36).slice(2, 10)}`,
      );
  const { sql, db } = connectStudioDb(database.url);
  await ensureStudioTables(sql);

  const bus = new InMemoryEventBus();
  const logger = createLogger('studio-engine-test', 'warn');
  const proposer = options?.proposer ?? new RulesProposer();

  const timeouts: Harness['timeouts'] = [];
  const queueTarget: { value?: QueueGateway } = {};
  const queueProxy: QueueGateway = {
    enqueueRunStart: async (tenantId, runId) => queueTarget.value?.enqueueRunStart(tenantId, runId),
    enqueueRunStep: async (tenantId, runId) => queueTarget.value?.enqueueRunStep(tenantId, runId),
    scheduleApprovalTimeout: async (job) => queueTarget.value?.scheduleApprovalTimeout(job),
    start: async () => {},
    stop: async () => {},
  };

  const llm = await createLlmServices(db, {
    ...process.env,
    PLATFORM_LLM_API_KEY: '',
    MODEL_CATALOGUE_PATH: 'config/models.jsonl',
  });

  const { engine, orchestrator } = createEngine({
    sql,
    db,
    bus,
    clients: stubDomainClients(),
    proposer,
    llm,
    checkpointer: options?.checkpointer ?? new MemorySaver(),
    queue: queueProxy,
    logger,
    dryRun: false,
  });

  queueTarget.value = {
    enqueueRunStart: async (_tenantId, runId) => {
      await orchestrator.runStep(runId);
    },
    enqueueRunStep: async (_tenantId, runId) => {
      await orchestrator.runStep(runId);
    },
    scheduleApprovalTimeout: async (job) => {
      timeouts.push(job);
    },
    start: async () => {},
    stop: async () => {},
  };

  return {
    engine,
    orchestrator,
    proposer,
    bus,
    db,
    sql,
    timeouts,
    databaseUrl: database.url,
    drop: async () => {
      await sql.close({ timeout: 5 });
      await bus.close();
      if (options?.databaseUrl === undefined) await database.drop();
    },
  };
}

/** Publishes an event and waits until the run it started reaches a terminal state or the given status. */
export async function waitForRunStatus(probe: () => Promise<RunStatus | null>): Promise<RunStatus> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await probe();
    if (status) return status;
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 25);
    await delay.promise;
  }
  throw new Error('run did not reach the expected status');
}

export async function runEventsOf(engine: EngineService, actor: ActorContext, runId: string): Promise<RunEvent[]> {
  const detail = await engine.getRun(actor, runId);
  return detail.events;
}
