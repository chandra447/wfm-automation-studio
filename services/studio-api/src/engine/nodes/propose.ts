import type { WorkflowNode } from '@wfm/workflows';
import { appendAudit, appendRunEvent } from '../run-store.ts';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';
import { readDomainTool } from './domain-tools.ts';

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
    data[tool] = await readDomainTool({ nodeId: node.id, toolId: tool, scope, deps, state, fetched: data });
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
