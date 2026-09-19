import {
  adjustmentRequestSchema,
  assignShiftRequestSchema,
  clockOutRequestSchema,
  createOffersRequestSchema,
  timesheetApprovalRequestSchema,
} from '@wfm/contracts';
import { commandById, type ActionNode, type CommandDescriptor } from '@wfm/workflows';
import { appendAudit, appendRunEvent } from '../run-store.ts';
import { publishActionExecuted } from '../events.ts';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';
import { resolveTemplateMap } from '@wfm/workflows';

export interface ActionOutcome {
  executed: boolean;
  command: string;
  idempotencyKey: string;
  resultSummary: string;
  payImpactCents: number;
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
  node: ActionNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  const command = commandById(node.config.command);
  if (!command) throw new Error(`unknown command "${node.config.command}" in action node ${node.id}`);

  const resolved = resolveTemplateMap(node.config.input, {
    input: state.event,
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, value]) => [id, { output: value?.output }])),
    now: new Date(),
  });

  const outcome = scope.dryRun
    ? dryRunOutcome(command, node.id, resolved)
    : await executeCommand(command, resolved, scope);

  await appendRunEvent(deps.db, {
    runId: scope.runId,
    kind: 'action_executed',
    nodeId: node.id,
    title: `${node.label}${outcome.executed ? '' : ' (dry-run)'}`,
    detail: `${outcome.command} — ${outcome.resultSummary}`,
    data: outcome,
  });
  await appendAudit(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'action.execute',
    actor: scope.dryRun ? 'studio-engine' : (outcome.decidedBy ?? 'studio-engine'),
    detail: { command: outcome.command, idempotencyKey: outcome.idempotencyKey, result: outcome.resultSummary, dryRun: scope.dryRun },
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

function dryRunOutcome(
  command: CommandDescriptor,
  nodeId: string,
  resolved: Record<string, unknown>,
): ActionOutcome & { decidedBy?: string } {
  const path = renderPath(command.pathTemplate, resolved);
  return {
    executed: false,
    command: `${command.method} ${path}`,
    idempotencyKey: idempotencyKeyOf(nodeIdPlaceholder, resolved),
    resultSummary: `dry-run: ${command.label} against ${command.service} with ${Object.keys(resolved).length} resolved inputs`,
    payImpactCents: 0,
  };
}
