import { isNode, resolveSlot, templateSlotsOf, type WorkflowNode } from '@wfm/workflows';
import type { RunScope, RunStateFields } from '../state.ts';
import { appendAudit, appendRunEvent } from '../run-store.ts';
import { templateScopeOf, type ExecutorDeps } from './context.ts';
import { insertArtifact } from '../artifact-store.ts';

/**
 * Renders a document from the run's own data and attaches it to the run. The
 * body's references come from the kind's declared template slots, so this
 * executor never parses {{...}} itself: it resolves what the kind declared.
 */
export async function runArtifactNode(
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  if (!isNode(node, 'artifact')) throw new Error(`artifact executor reached with a ${node.type} node`);

  const templateScope = templateScopeOf(scope, state);
  const slots = templateSlotsOf(node);
  const rendered = slots.map((slot) => String(resolveSlot(slot, templateScope) ?? '')).join('\n');
  const content =
    node.config.format === 'json'
      ? JSON.stringify({ name: node.config.name, body: rendered }, null, 2)
      : rendered;

  const artifact = await insertArtifact(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    nodeId: node.id,
    name: node.config.name,
    format: node.config.format,
    content,
  });

  await appendRunEvent(deps.db, {
    runId: scope.runId,
    kind: 'note',
    nodeId: node.id,
    title: `Artifact rendered: ${node.config.name}`,
    detail: `${artifact.format} · ${content.length} characters`,
    data: { artifactId: artifact.artifactId, name: artifact.name, format: artifact.format },
  });
  await appendAudit(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'artifact.render',
    actor: 'studio-engine',
    detail: { artifactId: artifact.artifactId, name: artifact.name, format: artifact.format },
  });

  return {
    nodes: { [node.id]: { output: { artifactId: artifact.artifactId, name: artifact.name }, summary: `Rendered ${artifact.name}` } },
    cursor: node.id,
    decision: { nodeId: node.id, port: 'always' },
  };
}
