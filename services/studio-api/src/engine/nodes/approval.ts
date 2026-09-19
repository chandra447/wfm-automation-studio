import { interrupt } from '@langchain/langgraph';
import { type AnyWfmEvent } from '@wfm/contracts';
import {
  candidateChoiceOutputSchema,
  coveragePlanOutputSchema,
  timesheetAdjustmentOutputSchema,
  type HumanApprovalNode,
} from '@wfm/workflows';
import { appendAudit, appendRunEvent, getFirstRunEvent, insertApproval, listApprovalsForNode } from '../run-store.ts';
import { publishApprovalRequested } from '../events.ts';
import type { ApprovalRow, RunDb } from '../run-store.ts';
import type { ResumePayload, RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';

interface Proposal {
  action: string;
  rationale: string;
  evidence: Array<{ label: string; value: string }>;
  payImpactCents: number;
  payload: unknown;
}

function payImpactOf(event: AnyWfmEvent): number {
  const payload = event.payload;
  if (typeof payload === 'object' && payload !== null && 'estimatedPayImpactCents' in payload) {
    const value = (payload as Record<string, unknown>)['estimatedPayImpactCents'];
    if (typeof value === 'number') return value;
  }
  return 0;
}

/**
 * The most recent upstream AI proposal on this path, whatever its kind.
 * Approvals always surface a proposal: an approval node with no upstream
 * decision node still shows why it is pausing.
 */
function findProposal(state: RunStateFields): Proposal | null {
  for (const value of Object.values(state.nodes)) {
    const output = value?.output;
    const candidate = candidateChoiceOutputSchema.safeParse(output);
    if (candidate.success) {
      return {
        action: 'rostering.send_offers',
        rationale: candidate.data.rationale,
        payImpactCents: candidate.data.costDeltaCents,
        payload: candidate.data,
      };
    }
    const adjustment = timesheetAdjustmentOutputSchema.safeParse(output);
    if (adjustment.success) {
      return {
        action: 'time_attendance.apply_adjustment',
        rationale: adjustment.data.rationale,
        payImpactCents: adjustment.data.payImpactCents,
        payload: adjustment.data,
      };
    }
    const plan = coveragePlanOutputSchema.safeParse(output);
    if (plan.success) {
      return {
        action: 'coverage_plan',
        rationale: plan.data.rationale,
        payImpactCents: plan.data.costDeltaCents,
        payload: plan.data,
      };
    }
  }
  return null;
}

/**
 * Human approval node (design §7.3, ADR-0005). Everything before the
 * `interrupt()` re-executes on resume, so every write is idempotent per
 * (runId, nodeId): a decided approval routes straight to its port, a pending
 * one is reused, and a timed-out one escalates to a fresh approval — never an
 * auto-approval of a pay-affecting action.
 */
export async function runApprovalNode(
  scope: RunScope,
  deps: ExecutorDeps,
  node: HumanApprovalNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  const rows = await listApprovalsForNode(deps.db, scope.runId, node.id);

  const decided = rows.find((row) => row.status === 'approved' || row.status === 'rejected');
  if (decided) {
    const port = decided.status === 'approved' ? 'approved' : 'rejected';
    const summary = `${node.label}: ${decided.status} by ${decided.decidedBy ?? 'unknown'}`;
    return {
      nodes: {
        [node.id]: {
          output: {
            decision: decided.status,
            approvalId: decided.approvalId,
            decidedBy: decided.decidedBy,
            reason: decided.decisionReason,
          },
          summary,
        },
      },
      cursor: node.id,
      decision: { nodeId: node.id, port },
    };
  }

  let pending = rows.find((row) => row.status === 'pending');
  if (!pending) {
    const latest = rows.at(-1);
    if (latest && latest.status === 'timed_out' && latest.requestedFromRole === node.config.escalateTo) {
      return escalationExhausted(scope, deps, node);
    }
    const role = rows.length === 0 ? node.config.role : node.config.escalateTo;
    pending = await createApproval(scope, deps, node, state, role);
  }

  const first = interrupt<ResumePayload>({
    decision: 'pending',
    approvalId: pending.approvalId,
  });
  if (first.decision !== 'timeout') {
    return decisionResult(node.id, first);
  }

  const second = interrupt<ResumePayload>({
    decision: 'pending',
    approvalId: first.approvalId,
  });
  return decisionResult(node.id, second);
}

function decisionResult(
  nodeId: string,
  resume: ResumePayload,
): Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'> {
  if (resume.decision === 'timeout') {
    throw new Error(
      `approval ${resume.approvalId} timed out again at node ${nodeId} and no further escalation is configured`,
    );
  }
  const port = resume.decision === 'approve' ? 'approved' : 'rejected';
  return {
    nodes: {
      [nodeId]: {
        output: { decision: resume.decision, approvalId: resume.approvalId },
        summary: `approval ${resume.approvalId} ${resume.decision === 'approve' ? 'approved' : 'rejected'}`,
      },
    },
    cursor: nodeId,
    decision: { nodeId, port },
  };
}

async function escalationExhausted(
  scope: RunScope,
  deps: ExecutorDeps,
  node: HumanApprovalNode,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  const detail =
    `Approval timed out for ${node.config.role} and again for ${node.config.escalateTo}. ` +
    'The run failed without executing any pay-affecting action.';
  await appendRunEvent(deps.db, {
    runId: scope.runId,
    kind: 'run_failed',
    nodeId: node.id,
    title: `${node.label}: approval chain exhausted`,
    detail,
  });
  await appendAudit(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'human_approval.escalation_exhausted',
    actor: 'system',
    detail: { role: node.config.role, escalateTo: node.config.escalateTo },
  });
  return {
    nodes: {
      [node.id]: { output: { decision: 'escalation_exhausted' }, summary: `${node.label}: approval chain exhausted` },
    },
    cursor: node.id,
    decision: { nodeId: node.id, port: 'rejected' },
  };
}

async function createApproval(
  scope: RunScope,
  deps: ExecutorDeps,
  node: HumanApprovalNode,
  state: RunStateFields,
  role: string,
): Promise<ApprovalRow> {
  const db: RunDb = deps.db;
  const proposal = findProposal(state) ?? {
    action: 'manual_review',
    rationale: `Run waits on a human decision at ${node.label}.`,
    evidence: [{ label: 'Trigger event', value: state.event.eventType }],
    payImpactCents: payImpactOf(state.event),
    payload: state.event.payload,
  };
  const proposer = await proposalProposerOf(db, scope.runId);
  const expiresAt = new Date(Date.now() + node.config.timeoutMinutes * 60_000);
  const row = await insertApproval(db, {
    approvalId: crypto.randomUUID(),
    runId: scope.runId,
    tenantId: scope.tenantId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    status: 'pending',
    subject: `${scope.workflowName} — ${node.label}`,
    requestedFromRole: role,
    escalateTo: node.config.escalateTo,
    expiresAt,
    payImpactCents: proposal.payImpactCents,
    proposal: {
      action: proposal.action,
      rationale: proposal.rationale,
      evidence: proposal.evidence,
      proposer,
      payImpactCents: proposal.payImpactCents,
      payload: proposal.payload,
    },
  });
  await appendRunEvent(db, {
    runId: scope.runId,
    kind: 'approval_requested',
    nodeId: node.id,
    title: `${node.label}: approval requested from ${role}`,
    detail: `Subject: ${row.subject}. Expires at ${row.expiresAt.toISOString()}.`,
    data: {
      approvalId: row.approvalId,
      expiresAt: row.expiresAt.toISOString(),
      payImpactCents: row.payImpactCents,
      requestedFromRole: role,
    },
  });
  await appendAudit(db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'human_approval.requested',
    actor: 'system',
    detail: {
      approvalId: row.approvalId,
      requestedFromRole: role,
      escalateTo: row.escalateTo,
      payImpactCents: row.payImpactCents,
    },
  });
  await publishApprovalRequested(deps.bus, {
    tenantId: scope.tenantId,
    correlationId: scope.correlationId,
    causationId: scope.triggerEventId,
    runId: scope.runId,
    approvalId: row.approvalId,
    workflowId: scope.workflowId,
    requestedFromRole: role,
    expiresAt: row.expiresAt.toISOString(),
    subject: row.subject,
    payImpactCents: row.payImpactCents,
  });
  await deps.queue.scheduleApprovalTimeout({
    runId: scope.runId,
    approvalId: row.approvalId,
    runAt: row.expiresAt,
  });
  return row;
}

async function proposalProposerOf(db: RunDb, runId: string): Promise<'llm' | 'rules'> {
  const event = await getFirstRunEvent(db, runId, 'proposal_created');
  const data: unknown = event?.data;
  if (typeof data === 'object' && data !== null && 'proposer' in data) {
    return (data as Record<string, unknown>)['proposer'] === 'llm' ? 'llm' : 'rules';
  }
  return 'rules';
}
