import { timesheetDetailResponseSchema, type AnyWfmEvent } from '@wfm/contracts';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';

/**
 * The read-only domain reads an AI node may perform. Identity-not-truth: every
 * read goes back to the service that owns the data, and nothing here writes.
 *
 * The table is shared by the AI decision node, which fetches exactly the tools
 * its config declares, and the agent node, which offers the same tools to the
 * model and lets it choose. The description is what the agent's planner reads
 * when deciding whether a tool is worth calling, so it is written for a reader
 * that has only the sentence.
 */
export interface DomainTool {
  id: string;
  description: string;
  /**
   * `fetched` is what has already been read this execution, keyed by tool id,
   * so a tool that depends on another works whichever order they are called in.
   */
  read: (
    scope: RunScope,
    deps: ExecutorDeps,
    state: RunStateFields,
    fetched: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Reads the shift id for shift-scoped events (aggregate or payload). Nothing
 * else in the engine assumes which field carries it.
 */
function shiftIdOf(event: AnyWfmEvent): string {
  if ('shiftId' in event.payload && typeof event.payload.shiftId === 'string') return event.payload.shiftId;
  return event.aggregate.id;
}

function timesheetIdOf(event: AnyWfmEvent): string {
  if ('timesheetId' in event.payload && typeof event.payload.timesheetId === 'string') {
    return event.payload.timesheetId;
  }
  return event.aggregate.id;
}

function awardRuleCodeOf(timesheetData: unknown): string | null {
  const parsed = timesheetDetailResponseSchema.safeParse(timesheetData);
  return parsed.success ? parsed.data.awardRule.ruleCode : null;
}

export const DOMAIN_TOOLS: Record<string, DomainTool> = {
  'shift.get': {
    id: 'shift.get',
    description: 'Read the shift this run is about: its role, location, start and end times, and hourly rate.',
    read: async (scope, deps, state) => deps.clients.rostering.getShift(scope.tenantId, shiftIdOf(state.event)),
  },
  'shift.candidates': {
    id: 'shift.candidates',
    description:
      'List the employees who could cover the shift, with each one’s cost, rest hours, overtime risk and service score.',
    read: async (scope, deps, state) => {
      const exclusions =
        'cancelledByEmployeeId' in state.event.payload &&
        typeof state.event.payload.cancelledByEmployeeId === 'string'
          ? [state.event.payload.cancelledByEmployeeId]
          : [];
      return deps.clients.rostering.listCandidates(scope.tenantId, shiftIdOf(state.event), {
        ...(exclusions.length > 0 ? { excludeEmployeeIds: exclusions } : {}),
      });
    },
  },
  'employee.availability': {
    id: 'employee.availability',
    description:
      'Check whether employees are free to work the shift. No availability service exists yet, so this reports that it is unavailable.',
    read: async () => ({ unavailable: 'no availability endpoint in the domain services yet' }),
  },
  'timesheet.get': {
    id: 'timesheet.get',
    description: 'Read the timesheet this run is about, including its pay lines, exceptions and the award rule it is paid under.',
    read: async (scope, deps, state) =>
      deps.clients.attendance.getTimesheet(scope.tenantId, timesheetIdOf(state.event)),
  },
  'award_rule.get': {
    id: 'award_rule.get',
    description:
      'Read the award rule that governs the pay: ordinary limits, overtime multiplier, and unpaid break requirements.',
    read: async (scope, deps, state, fetched) => {
      const payload = state.event.payload;
      const ruleCode =
        'awardRuleCode' in payload && typeof payload.awardRuleCode === 'string'
          ? payload.awardRuleCode
          : awardRuleCodeOf(fetched['timesheet.get']);
      if (!ruleCode) return { error: `no award rule code available on ${state.event.eventType}` };
      return deps.clients.attendance.getAwardRule(scope.tenantId, ruleCode);
    },
  },
};

export interface DomainReadRequest {
  nodeId: string;
  toolId: string;
  scope: RunScope;
  deps: ExecutorDeps;
  state: RunStateFields;
  fetched: Record<string, unknown>;
}

/**
 * One domain read with the engine's error policy: an unknown tool and a failed
 * fetch are both recorded as an error object the caller keeps, never thrown.
 * A tool that cannot be read must not take the run down with it.
 */
export async function readDomainTool(request: DomainReadRequest): Promise<unknown> {
  const { nodeId, toolId, scope, deps, state, fetched } = request;
  const tool = DOMAIN_TOOLS[toolId];
  if (tool === undefined) {
    deps.logger.warn({ tenantId: scope.tenantId, runId: scope.runId, nodeId, tool: toolId }, 'unknown tool skipped');
    return { error: `unknown tool ${toolId}` };
  }
  try {
    return await tool.read(scope, deps, state, fetched);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn(
      { tenantId: scope.tenantId, runId: scope.runId, nodeId, tool: toolId, message },
      'tool fetch failed',
    );
    return { error: message };
  }
}
