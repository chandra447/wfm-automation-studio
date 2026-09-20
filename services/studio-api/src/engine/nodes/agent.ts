import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { isNode, resolveSlots, templateSlotsOf, type AgentNode, type WorkflowNode } from '@wfm/workflows';
import { z } from 'zod';
import { appendAudit, appendRunEvent } from '../run-store.ts';
import type { RunScope, RunStateFields } from '../state.ts';
import { templateScopeOf, type ExecutorDeps } from './context.ts';
import { DOMAIN_TOOLS, readDomainTool } from './domain-tools.ts';
import { OUTPUT_SCHEMAS, withoutIneligible } from './proposers.ts';
import { AgentUnavailableError, agentUnavailableMessage } from './agent-runner.ts';

/** The kind's own default, for a stored definition that predates the default. */
const DEFAULT_MAX_STEPS = 6;

/**
 * AI agent node: the same declared read-only tools and the same structured
 * output as an AI decision, but the model chooses which tools to call and how
 * often, up to its step budget, before it answers. The proposal is recorded and
 * audited exactly as the AI decision's is; the node still executes nothing.
 */
export async function runAgentNode(
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  if (!isNode(node, 'agent')) throw new Error(`${node.type} executor reached with a ${node.type} node`);
  if (deps.agent === null) {
    throw new AgentUnavailableError(
      agentUnavailableMessage({ nodeId: node.id, label: node.label, tenantId: scope.tenantId }),
    );
  }

  const fetched: Record<string, unknown> = {};
  const result = await deps.agent.run({
    runId: scope.runId,
    nodeId: node.id,
    label: node.label,
    tenantId: scope.tenantId,
    goal: resolvedGoal(node, scope, state),
    ...(node.config.model === undefined ? {} : { model: node.config.model }),
    maxSteps: typeof node.config.maxSteps === 'number' ? node.config.maxSteps : DEFAULT_MAX_STEPS,
    output: node.config.output,
    mustCiteEvidence: node.config.mustCiteEvidence,
    schema: OUTPUT_SCHEMAS[node.config.output],
    event: state.event,
    steering: state.messages,
    tools: declaredTools(node, scope, deps, state, fetched),
  });
  const output = withoutIneligible(result.output, fetched);

  await appendAudit(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'agent.propose',
    actor: `llm:${result.model}@${result.promptVersion}`,
    detail: {
      goal: node.config.goal,
      tools: node.config.tools,
      toolTrail: result.toolTrail,
      output,
      evidence: output.evidence,
      model: result.model,
      promptVersion: result.promptVersion,
    },
  });
  await appendRunEvent(deps.db, {
    runId: scope.runId,
    kind: 'proposal_created',
    nodeId: node.id,
    title: `${node.label}: agent proposal`,
    detail: output.rationale,
    data: {
      output,
      proposer: 'agent',
      toolTrail: result.toolTrail,
      evidence: output.evidence,
      model: result.model,
      promptVersion: result.promptVersion,
    },
  });
  return {
    nodes: { [node.id]: { output, summary: output.rationale } },
    cursor: node.id,
    decision: { nodeId: node.id, port: 'always' },
  };
}

/**
 * The declared tools, and only those. Each one reads through the shared domain
 * table, so a tool the model calls is the same read the AI decision node would
 * have made, and its result is accumulated for the next tool that needs it.
 */
function declaredTools(
  node: AgentNode,
  scope: RunScope,
  deps: ExecutorDeps,
  state: RunStateFields,
  fetched: Record<string, unknown>,
): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];
  for (const id of node.config.tools) {
    const domainTool = DOMAIN_TOOLS[id];
    if (domainTool === undefined) {
      deps.logger.warn({ tenantId: scope.tenantId, runId: scope.runId, nodeId: node.id, tool: id }, 'unknown tool skipped');
      continue;
    }
    tools.push(
      tool(
        async () => {
          const read = await readDomainTool({ nodeId: node.id, toolId: id, scope, deps, state, fetched });
          fetched[id] = read;
          return JSON.stringify(read);
        },
        { name: domainTool.id, description: domainTool.description, schema: z.object({}) },
      ),
    );
  }
  return tools;
}

/** The goal's {{...}} references, resolved against the run's own data. */
function resolvedGoal(node: AgentNode, scope: RunScope, state: RunStateFields): string {
  const resolved = resolveSlots(templateSlotsOf(node), templateScopeOf(scope, state));
  return String(resolved['goal'] ?? node.config.goal);
}
