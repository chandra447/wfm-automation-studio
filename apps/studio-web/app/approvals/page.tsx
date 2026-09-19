'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Approval, DecisionResponse } from '@wfm/contracts';
import { apiFetch } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { ApiNotice } from '@/components/runs/api-notice';

interface DecisionOutcome {
  workflowName: string;
  runId: string;
  runStatus: string;
}

export default function ApprovalsPage() {
  const { headers } = useDemoActor();
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [outcomes, setOutcomes] = useState<Record<string, DecisionOutcome>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const pending = await apiFetch<Approval[]>('/approvals?status=pending', { headers });
      setApprovals(pending);
    } catch (caught) {
      setError(caught);
    }
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDecided = (approval: Approval, response: DecisionResponse) => {
    setOutcomes((current) => ({
      ...current,
      [approval.approvalId]: { workflowName: approval.workflowName, runId: response.runId, runStatus: response.runStatus },
    }));
    setApprovals((current) => current?.filter((candidate) => candidate.approvalId !== approval.approvalId) ?? null);
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-lg font-semibold">Approvals inbox</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Everything here can move pay or reassign work, so a human decides before the engine executes.
          Switch the actor in the header to see the role check refuse an out-of-role approver.
        </p>
      </header>

      {error ? <ApiNotice error={error} /> : null}

      {approvals !== null && error === null ? (
        <section className="flex flex-col gap-4">
          {approvals.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-8 text-center text-sm text-[var(--color-ink-faint)]">
              Nothing waiting on a human. Run the coverage or payroll simulator from the overview to generate an approval.
            </p>
          ) : (
            approvals.map((approval) =>
              outcomes[approval.approvalId] ? null : (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  onDecided={(response: DecisionResponse) => onDecided(approval, response)}
                />
              ),
            )
          )}
        </section>
      ) : null}

      {Object.keys(outcomes).length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Decided this session</h2>
          {Object.entries(outcomes).map(([approvalId, outcome]) => (
            <p
              key={approvalId}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-success-soft)] p-3 text-sm"
              style={{ color: 'var(--color-success)' }}
            >
              <span className="font-medium">{outcome.workflowName}</span>
              <span className="text-[var(--color-ink-muted)]">decision recorded — run is now</span>
              <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-xs font-medium">{outcome.runStatus}</span>
              <Link href={`/runs/${outcome.runId}`} className="ml-auto text-xs underline underline-offset-2 hover:text-[var(--color-ink)]">
                Watch the run
              </Link>
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}
