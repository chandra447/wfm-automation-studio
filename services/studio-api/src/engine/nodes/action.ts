import {
  adjustmentRequestSchema,
  assignShiftRequestSchema,
  createOffersRequestSchema,
  timesheetApprovalRequestSchema,
} from '@wfm/contracts';
import { z } from 'zod';
import {
  commandById,
  resolveTemplateMap,
  type WorkflowNode,
  type CommandDescriptor,
} from '@wfm/workflows';
import { appendAudit, appendRunEvent, countAction, getDecidedApproval } from "../run-store.ts";
import { publishActionExecuted } from '../events.ts';
import type { RunScope, RunStateFields } from '../state.ts';
import { templateScopeOf, type ExecutorDeps } from './context.ts';

export interface ActionOutcome {
  executed: boolean;
  command: string;
  idempotencyKey: string;
  resultSummary: string;
  payImpactCents: number;
  decidedBy: string | null;
}

/**
 * Action node: resolves the saved input templates against the trigger event
 * and earlier node outputs, then issues the catalogued command to the owning
 * domain service under `run:<runId>:node:<nodeId>`. In dry-run mode the
 * intended command is recorded but no service is called.
 */
export async function runActionNode(
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  if (node.type !== 'action') throw new Error(`${node.type} executor reached with a ${node.type} node`);
  const command = commandById(node.config.command);
  if (!command) throw new Error(`unknown command "${node.config.command}" in action node ${node.id}`);

  const resolved = resolveTemplateMap(node.config.input, templateScopeOf(scope, state));

  const outcome = scope.dryRun ? dryRunOutcome(command, node.id) : await executeCommand(command, resolved, scope, deps, node.id);
  if (outcome.executed) {
    await countAction(deps.db, scope.runId);
  }

  await appendRunEvent(deps.db, {
    runId: scope.runId,
    kind: 'action_executed',
    nodeId: node.id,
    title: `${node.label}${outcome.executed ? '' : ' (dry-run)'}`,
    detail: `${outcome.command} — ${outcome.resultSummary}`,
    data: { ...outcome },
  });
  await appendAudit(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'action.execute',
    actor: outcome.decidedBy ?? 'studio-engine',
    detail: {
      command: outcome.command,
      idempotencyKey: outcome.idempotencyKey,
      result: outcome.resultSummary,
      dryRun: scope.dryRun,
    },
  });
  if (outcome.executed) {
    await publishActionExecuted(deps.bus, {
      tenantId: scope.tenantId,
      correlationId: scope.correlationId,
      causationId: scope.triggerEventId,
      runId: scope.runId,
      workflowId: scope.workflowId,
      action: node.config.command,
      targetService: command.service,
      command: outcome.command,
      idempotencyKey: outcome.idempotencyKey,
      resultSummary: outcome.resultSummary,
      payImpactCents: outcome.payImpactCents,
    });
  }
  return {
    nodes: { [node.id]: { output: outcome, summary: `${node.label}: ${outcome.resultSummary}` } },
    cursor: node.id,
    decision: { nodeId: node.id, port: 'always' },
  };
}

function idempotencyKeyOf(runId: string, nodeId: string): string {
  return `run:${runId}:node:${nodeId}`;
}

function dryRunOutcome(command: CommandDescriptor, nodeId: string): ActionOutcome {
  return {
    executed: false,
    command: `${command.method} ${command.pathTemplate}`,
    idempotencyKey: idempotencyKeyOf('dry-run', nodeId),
    resultSummary: `dry-run: ${command.label} against ${command.service} — no command issued`,
    payImpactCents: 0,
    decidedBy: 'studio-engine',
  };
}

/**
 * Who authorised the action: the pending/decided approval's decider. With no
 * approval (a non-pay action after an explicit path), the engine itself acted.
 */
async function decidedByOf(deps: ExecutorDeps, runId: string): Promise<string> {
  const approval = await getDecidedApproval(deps.db, runId);
  return approval?.decidedBy ?? 'studio-engine';
}

async function executeCommand(
  command: CommandDescriptor,
  resolved: Record<string, unknown>,
  scope: RunScope,
  deps: ExecutorDeps,
  nodeId: string,
): Promise<ActionOutcome> {
  const idempotencyKey = idempotencyKeyOf(scope.runId, nodeId);
  const decidedBy = await decidedByOf(deps, scope.runId);

  switch (command.id) {
    case 'rostering.send_offers': {
      const body = createOffersRequestSchema.parse({
        employeeIds: resolved['employeeIds'],
        expiresAt: resolved['expiresAt'],
        reason: resolved['reason'],
      });
      const shiftId = requireUuid(resolved['shiftId'], 'shiftId');
      const offers = await deps.clients.rostering.createOffers(scope.tenantId, shiftId, body, idempotencyKey);
      return {
        executed: true,
        command: `POST /shifts/${shiftId}/offers`,
        idempotencyKey,
        resultSummary: `Offers sent to ${offers.offers.length} employee(s)`,
        payImpactCents: 0,
        decidedBy,
      };
    }
    case 'rostering.assign_employee': {
      const body = assignShiftRequestSchema.parse({
        employeeId: resolved['employeeId'],
        reason: resolved['reason'],
      });
      const shiftId = requireUuid(resolved['shiftId'], 'shiftId');
      const shift = await deps.clients.rostering.assignEmployee(scope.tenantId, shiftId, body, idempotencyKey);
      return {
        executed: true,
        command: `POST /shifts/${shiftId}/assignment`,
        idempotencyKey,
        resultSummary: `Shift ${shiftId} assigned to employee ${shift.assignedEmployeeId ?? body.employeeId}`,
        payImpactCents: 0,
        decidedBy,
      };
    }
    case 'time_attendance.apply_adjustment': {
      const body = adjustmentRequestSchema.parse({
        reason: resolved['reason'],
        unpaidBreakMinutesDelta: resolved['unpaidBreakMinutesDelta'],
        overtimeMinutesDelta: resolved['overtimeMinutesDelta'],
      });
      const timesheetId = requireUuid(resolved['timesheetId'], 'timesheetId');
      const adjustment = await deps.clients.attendance.applyAdjustment(scope.tenantId, timesheetId, body, idempotencyKey);
      return {
        executed: true,
        command: `POST /timesheets/${timesheetId}/adjustments`,
        idempotencyKey,
        resultSummary: `Adjustment ${adjustment.adjustmentId} applied by ${adjustment.appliedBy} (pay impact ${adjustment.payImpactCents} cents)`,
        payImpactCents: adjustment.payImpactCents,
        decidedBy,
      };
    }
    case 'time_attendance.approve_timesheet': {
      const body = timesheetApprovalRequestSchema.parse({
        decision: resolved['decision'],
        reason: resolved['reason'],
      });
      const timesheetId = requireUuid(resolved['timesheetId'], 'timesheetId');
      const result = await deps.clients.attendance.decideTimesheet(scope.tenantId, timesheetId, body);
      return {
        executed: true,
        command: `POST /timesheets/${timesheetId}/approval`,
        idempotencyKey,
        resultSummary: `Timesheet ${timesheetId} is now ${result.timesheet.status}`,
        payImpactCents: 0,
        decidedBy,
      };
    }
    default:
      throw new Error(`command "${command.id}" has no executor binding in the engine`);
  }
}

function requireUuid(value: unknown, field: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new Error(`action input "${field}" did not resolve to a UUID (${parsed.error.issues[0]?.message ?? 'invalid'})`);
  }
  return parsed.data;
}
