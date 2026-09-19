'use client';

import { useEffect, useState } from 'react';
import type { Approval, DecisionResponse } from '@wfm/contracts';
import { apiFetch, ApiFailure } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { cn } from '@/lib/utils';
import { formatCents, formatCountdown } from '../runs/format';
import { PayImpactBadge } from '../runs/pay-impact';

interface ApprovalCardProps {
  approval: Approval;
  onDecided: (response: DecisionResponse) => void;
  className?: string;
}

export function ApprovalCard({ approval, onDecided, className }: ApprovalCardProps) {
  const { headers, actor } = useDemoActor();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const countdown = formatCountdown(approval.expiresAt, now);
  const expired = countdown === 'expired';

  const decide = async (decision: 'approve' | 'reject') => {
    setSubmitting(true);
    setFailure(null);
    try {
      const response = await apiFetch<DecisionResponse>(`/approvals/${approval.approvalId}/decision`, {
        method: 'POST',
        headers,
        body: { decision, reason },
      });
      onDecided(response);
    } catch (error) {
      setFailure(
        error instanceof ApiFailure
          ? error
          : new ApiFailure(0, 'REQUEST_FAILED', error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const needsReason = reason.trim().length === 0;
  const forbidden = failure !== null && failure.status === 403;

  return (
    <article
      className={cn('flex flex-col gap-4 rounded-xl border p-5', className, forbidden && 'ring-1')}
      style={{
        backgroundColor: 'var(--color-surface)',
        borderColor: forbidden ? 'var(--color-danger)' : 'var(--color-border-subtle)',
        ...(forbidden ? { boxShadow: '0 0 0 1px var(--color-danger)' } : {}),
      }}
    >
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{approval.workflowName}</h3>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Subject: <span className="text-[var(--color-ink)]">{approval.subject}</span>
          </p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-1 text-right">
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{
              color: expired ? 'var(--color-danger)' : 'var(--color-warning)',
              backgroundColor: expired ? 'var(--color-danger-soft)' : 'var(--color-warning-soft)',
            }}
          >
            {expired ? 'Escalation overdue' : countdown}
          </span>
          <span className="text-[11px] text-[var(--color-ink-faint)]">
            role required: <span className="font-mono text-[var(--color-ink-muted)]">{approval.requestedFromRole}</span>
          </span>
        </div>
      </header>

      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[11px] font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Proposed action</span>
          <span className="font-mono text-xs text-[var(--color-node-ai)]">{approval.proposal.action}</span>
          <span
            className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase"
            style={{
              color: approval.proposal.proposer === 'llm' ? 'var(--color-node-ai)' : 'var(--color-node-policy)',
              backgroundColor: 'var(--color-surface)',
            }}
            title={approval.proposal.proposer === 'llm' ? 'Proposed by the LLM agent' : 'Proposed by the deterministic rules engine'}
          >
            proposer: {approval.proposal.proposer}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">{approval.proposal.rationale}</p>
        {approval.proposal.evidence.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1 text-xs">
            {approval.proposal.evidence.map((entry, index) => (
              <li key={index} className="text-[var(--color-ink-muted)]">
                <span className="text-[var(--color-ink-faint)]">{entry.label}:</span> <span className="text-[var(--color-ink)]">{entry.value}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PayImpactBadge cents={approval.proposal.payImpactCents} />
          <span className="text-[11px] text-[var(--color-ink-faint)]">
            pay impact {formatCents(approval.proposal.payImpactCents)}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-[var(--color-ink-faint)]" htmlFor={`reason-${approval.approvalId}`}>
          Reason <span className="text-[var(--color-danger)]">(required)</span>
        </label>
        <textarea
          id={`reason-${approval.approvalId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why this decision is being made — recorded verbatim in the audit trail"
          rows={2}
          className="w-full rounded-md border bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-primary)]"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        />
      </div>

      {failure ? (
        <div
          role="alert"
          className="rounded-lg border p-3 text-xs"
          style={{
            backgroundColor: failure.status === 403 ? 'var(--color-danger-soft)' : 'var(--color-warning-soft)',
            borderColor: failure.status === 403 ? 'var(--color-danger)' : 'var(--color-border-subtle)',
            color: failure.status === 403 ? 'var(--color-danger)' : 'var(--color-warning)',
          }}
        >
          <p className="font-medium">{failure.status === 403 ? 'Not allowed' : `Decision failed (HTTP ${failure.status})`}</p>
          <p className="mt-1 text-[var(--color-ink-muted)]">
            {failure.status === 403
              ? `Your role cannot approve this. ${failure.message}`
              : failure.message}
          </p>
          {forbidden ? (
            <p className="mt-1 text-[var(--color-ink-faint)]">
              Acting as {actor.label} (roles: {actor.roles.join(', ')}) — this approval needs{' '}
              <span className="font-mono">{approval.requestedFromRole}</span>. Switch actor in the header.
            </p>
          ) : null}
        </div>
      ) : null}

      <footer className="flex items-center gap-2">
        <button
          type="button"
          disabled={submitting || needsReason}
          onClick={() => void decide('approve')}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
          style={{ backgroundColor: 'var(--color-success)' }}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={submitting || needsReason}
          onClick={() => void decide('reject')}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
          style={{ backgroundColor: 'var(--color-danger)' }}
        >
          Reject
        </button>
        {needsReason ? <span className="text-[11px] text-[var(--color-ink-faint)]">Enter a reason to enable the decision</span> : null}
        <span className="ml-auto text-[11px] text-[var(--color-ink-faint)]">escalates to {approval.escalateTo} on timeout</span>
      </footer>
    </article>
  );
}
