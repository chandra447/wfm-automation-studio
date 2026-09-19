'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Approval, RunDetail, RunEvent, RunSummary } from '@wfm/contracts';
import { apiFetch, subscribeToRun, ApiFailure } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { ApiNotice } from '@/components/runs/api-notice';
import { formatDateTime, formatDuration } from '@/components/runs/format';
import { RunEventTimeline } from '@/components/runs/run-event-timeline';
import { RunStatusPill } from '@/components/runs/run-status-pill';

type Connection = 'connecting' | 'streaming' | 'polling' | 'ended';

const terminalStatuses: Record<string, boolean> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};

const connectionLabels: Record<Connection, string> = {
  connecting: 'Connecting…',
  streaming: 'Live · streaming',
  polling: 'Live · polling (stream unavailable)',
  ended: 'Run finished',
};

function mergeEvent(current: RunEvent[], incoming: RunEvent): RunEvent[] {
  if (current.some((existing) => existing.seq === incoming.seq)) return current;
  return [...current, incoming].sort((a, b) => a.seq - b.seq);
}

export default function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = typeof params.runId === 'string' ? params.runId : '';
  const { headers } = useDemoActor();

  const [run, setRun] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [connection, setConnection] = useState<Connection>('connecting');

  const headersRef = useRef(headers);
  headersRef.current = headers;

  const refresh = useCallback(async () => {
    const detail = await apiFetch<RunDetail>(`/runs/${runId}`, { headers: headersRef.current });
    setRun(detail.run);
    setApproval(detail.approval);
    setEvents((current) => {
      const merged = [...current];
      for (const event of detail.events) {
        if (merged.some((existing) => existing.seq === event.seq)) continue;
        merged.push(event);
      }
      return merged.sort((a, b) => a.seq - b.seq);
    });
    return detail.run;
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let pollTimer: number | undefined;
    const controller = new AbortController();
    setEvents([]);
    setApproval(null);
    setRun(null);
    setError(null);
    setConnection('connecting');

    const onTimelineEvent = (event: RunEvent) => {
      if (cancelled) return;
      setEvents((current) => mergeEvent(current, event));
      if (event.kind === 'approval_requested' || event.kind === 'approval_decided') {
        void refresh().catch(() => undefined);
      }
    };

    const startPolling = () => {
      if (cancelled || pollTimer !== undefined) return;
      setConnection('polling');
      pollTimer = window.setInterval(() => {
        void (async () => {
          try {
            const status = (await refresh()).status;
            if (terminalStatuses[status] === true) {
              window.clearInterval(pollTimer);
              pollTimer = undefined;
              setConnection('ended');
            }
          } catch {
            // Polling keeps trying; the next successful refresh reconciles the view.
          }
        })();
      }, 4000);
    };

    void (async () => {
      try {
        const initial = await refresh();
        if (cancelled) return;
        if (terminalStatuses[initial.status] === true) {
          setConnection('ended');
          return;
        }

        // Stream first; after two consecutive failures fall back to polling.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (cancelled) return;
          try {
            setConnection('streaming');
            await subscribeToRun(runId, headersRef.current, onTimelineEvent, controller.signal);
            // A clean stream end means the run finished; pick up the final state.
            const finished = await refresh();
            if (cancelled) return;
            setConnection(terminalStatuses[finished.status] === true ? 'ended' : 'polling');
            if (terminalStatuses[finished.status] !== true) startPolling();
            return;
          } catch (streamError) {
            if (cancelled) return;
            if (controller.signal.aborted) return;
            const terminal = await refresh().catch(() => null);
            if (terminal !== null && terminalStatuses[terminal.status] === true) {
              setConnection('ended');
              return;
            }
            if (attempt === 1) {
              startPolling();
              setError(
                streamError instanceof ApiFailure
                  ? streamError
                  : new ApiFailure(0, 'NO_STREAM', 'Run stream unavailable — polling the run endpoint instead.'),
              );
            }
          }
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught);
          setConnection('ended');
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
    };
  }, [refresh, runId]);

  if (run === null && error !== null) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-8">
        <ApiNotice error={error} heading="Run unavailable" />
        <Link href="/runs" className="text-sm text-[var(--color-primary)] underline underline-offset-2">
          Back to runs
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      {run ? (
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold">{run.workflowName}</h1>
            <RunStatusPill status={run.status} />
            {run.dryRun ? (
              <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-xs font-medium" style={{ color: 'var(--color-warning)' }}>
                dry-run
              </span>
            ) : null}
            <span
              className="ml-auto rounded-full px-2 py-0.5 text-[11px]"
              style={{ backgroundColor: 'var(--color-surface-raised)', color: connection === 'streaming' ? 'var(--color-success)' : 'var(--color-ink-muted)' }}
            >
              ● {connectionLabels[connection]}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-ink-muted)]">
            <span>
              triggered by <span className="font-mono text-[var(--color-node-trigger)]">{run.triggerEventType}</span>
            </span>
            <span>started {formatDateTime(run.startedAt)}</span>
            <span>
              {run.finishedAt === null
                ? `running for ${formatDuration(run.startedAt, null)}`
                : `finished in ${formatDuration(run.startedAt, run.finishedAt)}`}
            </span>
            <span>{run.actionsExecuted} action{run.actionsExecuted === 1 ? '' : 's'} executed</span>
          </div>
          {run.summary ? <p className="text-sm text-[var(--color-ink-muted)]">{run.summary}</p> : null}
        </header>
      ) : (
        <header className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">Run</h1>
          <p className="text-xs text-[var(--color-ink-faint)] font-mono">{runId}</p>
        </header>
      )}

      {error && run !== null ? <ApiNotice error={error} heading="Live timeline degraded" /> : null}

      {approval !== null && approval.status === 'pending' ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Waiting on a human</h2>
          <ApprovalCard approval={approval} onDecided={() => void refresh().catch(() => undefined)} />
        </section>
      ) : null}

      {approval !== null && approval.status !== 'pending' ? (
        <p className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-ink-muted)]">
          Approval <span className="font-medium uppercase" style={{ color: approval.status === 'approved' ? 'var(--color-success)' : 'var(--color-danger)' }}>{approval.status}</span>
          {approval.decidedBy ? <> by {approval.decidedBy}</> : null}
          {approval.decisionReason ? <> — “{approval.decisionReason}”</> : null}
        </p>
      ) : null}

      <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
        <h2 className="mb-4 text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Reasoning timeline</h2>
        <RunEventTimeline events={events} live={connection === 'streaming' || connection === 'polling' || connection === 'connecting'} />
      </section>

      <Link href="/runs" className="text-sm text-[var(--color-primary)] underline underline-offset-2">
        Back to runs
      </Link>
    </div>
  );
}
