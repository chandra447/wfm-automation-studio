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

/**
 * A human turn in the run. Approvers write these when they decide with
 * feedback, and every later AI node sees them as steering.
 */
export interface RunMessage {
  role: 'human';
  content: string;
  at: string;
  nodeId: string;
  approvalId: string | null;
  actor: string | null;
}

export interface RunStateFields {
  runId: string;
  tenantId: string;
  definition: WorkflowDefinition;
  event: AnyWfmEvent;
  nodes: Record<string, { output: unknown; summary: string }>;
  /** Human turns, oldest first; empty until an approver steers the run. */
  messages: RunMessage[];
  cursor: string;
  decision: RunDecision | null;
}

export interface ResumePayload {
  decision: 'approve' | 'reject' | 'timeout';
  approvalId: string;
  /** Steering the approver attached to the decision, when they said more than yes or no. */
  feedback?: string;
}

export type { RunScope };
