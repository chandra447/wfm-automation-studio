'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { RunStatus, RunSummary } from '@wfm/contracts';
import { apiFetch } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { ApiNotice } from '@/components/runs/api-notice';
import { formatDateTime, formatDuration } from '@/components/runs/format';
import { RunStatusPill } from '@/components/runs/run-status-pill';

const statusFilterLabels: Record<RunStatus | 'all', string> = {
  all: 'All',
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export default function RunsPage() {
  const { headers } = useDemoActor();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [status, setStatus] = useState<RunStatus | 'all'>('all');
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (filter: RunStatus | 'all') => {
      setError(null);
      try {
        const query = filter === 'all' ? '' : `?status=${filter}`;
        const list = await apiFetch<RunSummary[]>(`/runs${query}`, { headers });
        setRuns(list);
      } catch (caught) {
        setError(caught);
      }
    },
    [headers],
  );

  useEffect(() => {
    void load(status);
  }, [load, status]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-lg font-semibold">Runs</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Every workflow execution over a domain event, with the reasoning trail and the human decisions it passed through.
        </p>
      </header>

      <nav className="flex flex-wrap gap-1.5" aria-label="Run status filter">
        {(Object.keys(statusFilterLabels) as Array<RunStatus | 'all'>).map((candidate) => {
          const active = candidate === status;
          return (
            <button
              key={candidate}
              type="button"
              onClick={() => setStatus(candidate)}
              className="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
              style={{
                borderColor: active ? 'transparent' : 'var(--color-border-subtle)',
                backgroundColor: active ? 'var(--color-primary-soft)' : 'transparent',
                color: active ? 'var(--color-ink)' : 'var(--color-ink-muted)',
              }}
            >
              {statusFilterLabels[candidate]}
            </button>
          );
        })}
      </nav>

      {error ? <ApiNotice error={error} /> : null}

      {runs !== null && error === null ? (
        runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-8 text-center text-sm text-[var(--color-ink-faint)]">
            No runs yet. Fire a scenario from the overview, or trigger an event through a domain service.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <li
                key={run.runId}
                className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-primary)]"
              >
                <Link href={`/runs/${run.runId}`} className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{run.workflowName}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
                      triggered by <span className="font-mono text-[var(--color-node-trigger)]">{run.triggerEventType}</span>
                      {run.dryRun ? <span className="text-[var(--color-warning)]"> · dry-run</span> : null}
                    </p>
                  </div>
                  <RunStatusPill status={run.status} />
                  <span className="text-xs text-[var(--color-ink-faint)]">{formatDateTime(run.startedAt)}</span>
                  <span className="text-xs text-[var(--color-ink-muted)]">
                    {run.finishedAt === null && (run.status === 'running' || run.status === 'awaiting_approval')
                      ? `${formatDuration(run.startedAt, null)} so far`
                      : formatDuration(run.startedAt, run.finishedAt)}
                  </span>
                  <span className="text-xs text-[var(--color-ink-faint)]">
                    {run.actionsExecuted} action{run.actionsExecuted === 1 ? '' : 's'} executed
                  </span>
                  {run.summary ? <span className="w-full text-xs text-[var(--color-ink-muted)]">{run.summary}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
