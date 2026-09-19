import type { AnyWfmEvent } from '@wfm/contracts';
import type { WorkflowDefinition } from '@wfm/workflows';
import type { RunScope } from './scope.ts';

/**
 * LangGraph channel shape for a run. `nodes` accumulates per-node outputs
 * (reducer merge), `cursor`/`decision` are last-writer channels that carry the
 * outcome of the node that just executed for edge routing.
 */

export interface NodeResult {
  output: unknown;
  summary: string;
  port: string;
}

export interface RunDecision {
  nodeId: string;
  port: string;
}

export interface RunStateFields {
  runId: string;
  tenantId: string;
  definition: WorkflowDefinition;
  event: AnyWfmEvent;
  nodes: Record<string, { output: unknown; summary: string }>;
  cursor: string;
  decision: RunDecision | null;
}

export interface ResumePayload {
  decision: 'approve' | 'reject' | 'timeout';
  approvalId: string;
}

export type { RunScope };
