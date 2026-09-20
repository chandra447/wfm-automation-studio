import type { WorkflowNode } from '@wfm/workflows';
import { timesheetDetailResponseSchema, type AnyWfmEvent } from '@wfm/contracts';
import { appendAudit, appendRunEvent } from '../run-store.ts';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';

/**
 * Reads the shift id for shift-scoped events (aggregate or payload). Nothing
 * else in the engine assumes which field carries it.
 */
function shiftIdOf(event: AnyWfmEvent): string {
  if ('shiftId' in event.payload && typeof event.payload.shiftId === 'string') return event.payload.shiftId;
  return event.aggregate.id;
}

function awardRuleCodeOf(timesheetData: unknown): string | null {
  const parsed = timesheetDetailResponseSchema.safeParse(timesheetData);
  return parsed.success ? parsed.data.awardRule.ruleCode : null;
}

function timesheetIdOf(event: AnyWfmEvent): string {
  if ('timesheetId' in event.payload && typeof event.payload.timesheetId === 'string') {
    return event.payload.timesheetId;
  }
  return event.aggregate.id;
}

/**
 * AI decision node: fetches ONLY the node's declared tools through the domain
 * clients (identity-not-truth: state is re-read from the owning service), then
 * asks the injected proposer for a proposal. The proposer's output is recorded
 * as the node output and audited; it never executes anything itself.
 */
export async function runProposeNode(
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  if (node.type !== 'ai_decision') throw new Error(`${node.type} executor reached with a ${node.type} node`);
  const data: Record<string, unknown> = {};
  for (const tool of node.config.tools) {
    try {
      switch (tool) {
        case 'shift.get': {
          data[tool] = await deps.clients.rostering.getShift(scope.tenantId, shiftIdOf(state.event));
          break;
        }
        case 'shift.candidates': {
          const exclusions =
            'cancelledByEmployeeId' in state.event.payload && typeof state.event.payload.cancelledByEmployeeId === 'string'
              ? [state.event.payload.cancelledByEmployeeId]
              : [];
          data[tool] = await deps.clients.rostering.listCandidates(scope.tenantId, shiftIdOf(state.event), {
            ...(exclusions.length > 0 ? { excludeEmployeeIds: exclusions } : {}),
          });
          break;
        }
        case 'employee.availability': {
          // No contract exists for availability yet; the proposer runs without
          // it and the missing tool is recorded in evidence.
          data[tool] = { unavailable: 'no availability endpoint in the domain services yet' };
          break;
        }
        case 'timesheet.get': {
          data[tool] = await deps.clients.attendance.getTimesheet(scope.tenantId, timesheetIdOf(state.event));
          break;
        }
        case 'award_rule.get': {
          const ruleCode =
            'awardRuleCode' in state.event.payload && typeof state.event.payload.awardRuleCode === 'string'
              ? state.event.payload.awardRuleCode
              : awardRuleCodeOf(data['timesheet.get']);
          if (ruleCode) {
            data[tool] = await deps.clients.attendance.getAwardRule(scope.tenantId, ruleCode);
          } else {
            data[tool] = { error: `no award rule code available on ${state.event.eventType}` };
          }
          break;
        }
        default: {
          deps.logger.warn({ tenantId: scope.tenantId, runId: scope.runId, nodeId: node.id, tool }, 'unknown tool skipped');
          data[tool] = { error: `unknown tool ${tool}` };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn({ tenantId: scope.tenantId, runId: scope.runId, nodeId: node.id, tool, message }, 'tool fetch failed');
      data[tool] = { error: message };
    }
  }

  const proposal = await deps.proposer.propose({
    runId: scope.runId,
    node,
    event: state.event,
    data,
    steering: state.messages,
  });
  const actor =
    proposal.proposer === 'llm' ? `llm:${proposal.model ?? 'unknown'}@${proposal.promptVersion ?? 'v1'}` : 'rules';

  await appendAudit(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'ai_decision.propose',
    actor,
    detail: {
      goal: node.config.goal,
      tools: node.config.tools,
      output: proposal.output,
      evidence: proposal.evidence,
      model: proposal.model ?? null,
      promptVersion: proposal.promptVersion ?? null,
    },
  });
  await appendRunEvent(deps.db, {
    runId: scope.runId,
    kind: 'proposal_created',
    nodeId: node.id,
    title: `${node.label}: ${proposal.proposer} proposal`,
    detail: proposal.rationale,
    data: {
      output: proposal.output,
      proposer: proposal.proposer,
      evidence: proposal.evidence,
      model: proposal.model ?? null,
      promptVersion: proposal.promptVersion ?? null,
    },
  });
  return {
    nodes: { [node.id]: { output: proposal.output, summary: proposal.rationale } },
    cursor: node.id,
    decision: { nodeId: node.id, port: 'always' },
  };
}
