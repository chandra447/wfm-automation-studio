'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Approval, Dashboard, RunStatus, RunSummary, SimulatorResponse, SimulatorScenario } from '@wfm/contracts';
import { apiFetch } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { ApiNotice } from '@/components/runs/api-notice';
import { RunStatusPill } from '@/components/runs/run-status-pill';
import { formatCents, formatDateTime, formatDuration } from '@/components/runs/format';

/** Every status the engine can park a run in, in lifecycle order. */
const runStatuses: readonly RunStatus[] = [
  'queued',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
];

const panel = 'rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5';
const panelHeading = 'text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]';

/**
 * The simulator drives the domain services directly, so the engine starts the
 * run asynchronously; the response has no runId. We remember which runs existed
 * before the POST and deep-link to whichever run appears afterwards.
 */
interface SimulatorResult {
  response: SimulatorResponse;
  scenario: SimulatorScenario;
  linkedRunId?: string;
  linkedRunName?: string;
}

const scenarioCopy: Record<SimulatorScenario, { label: string; description: string }> = {
  coverage_rescue: {
    label: 'Coverage rescue',
    description:
      'Cancels an aged-care RN shift 8h before start: the engine ranks eligible candidates, the cost delta crosses the tenant threshold, and a roster manager must approve before offers go out.',
  },
  payroll_exception: {
    label: 'Payroll exception',
    description:
      'Records a missed break on a timesheet: the engine computes unpaid-break and overtime impact against the award rule, and People Ops must approve before the adjustment is applied to the pay run.',
  },
};

/** Token counts are read at a glance, so a run's thousands stay one number. */
function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function Headline({
  label,
  value,
  hint,
  href,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  href: string | undefined;
  accent: string | undefined;
}) {
  const body = (
    <>
      <p className={panelHeading}>{label}</p>
      <p className="mt-1 text-2xl font-semibold" style={accent === undefined ? undefined : { color: accent }}>
        {value}
      </p>
      <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{hint}</p>
    </>
  );
  return href === undefined ? (
    <div className={`${panel} p-4`}>{body}</div>
  ) : (
    <Link href={href} className={`${panel} p-4 transition-colors hover:border-[var(--color-primary)]`}>
      {body}
    </Link>
  );
}

export default function DashboardPage() {
  const { headers } = useDemoActor();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busyScenario, setBusyScenario] = useState<SimulatorScenario | null>(null);
  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [pollTimer, setPollTimer] = useState<number | undefined>(undefined);
  const pollTimerRef = useRef<number | undefined>(undefined);
  pollTimerRef.current = pollTimer;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summary, runList, pending] = await Promise.all([
        apiFetch<Dashboard>('/dashboard', { headers }),
        apiFetch<RunSummary[]>('/runs?limit=5', { headers }),
        apiFetch<Approval[]>('/approvals?status=pending', { headers }),
      ]);
      setDashboard(summary);
      setRuns(runList);
      setApprovals(pending);
      setUpdatedAt(new Date().toISOString());
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (pollTimerRef.current !== undefined) window.clearInterval(pollTimerRef.current);
    },
    [],
  );

  const runScenario = async (scenario: SimulatorScenario) => {
    setBusyScenario(scenario);
    setError(null);
    try {
      const existing = await apiFetch<RunSummary[]>('/runs?limit=100', { headers });
      const known = new Set(existing.map((candidate) => candidate.runId));
      const response = await apiFetch<SimulatorResponse>(`/simulator/${scenario}`, { method: 'POST', headers });
      setResult({ response, scenario });

      // The engine starts the run from the emitted event; watch for a new run.
      if (pollTimerRef.current !== undefined) window.clearInterval(pollTimerRef.current);
      let attempts = 0;
      const timer = window.setInterval(() => {
        attempts += 1;
        void (async () => {
          try {
            const fresh = await apiFetch<RunSummary[]>('/runs?limit=100', { headers });
            const newcomer = fresh.find((candidate) => !known.has(candidate.runId));
            if (newcomer !== undefined) {
              setResult((current) =>
                current === null
                  ? current
                  : { ...current, linkedRunId: newcomer.runId, linkedRunName: newcomer.workflowName },
              );
              window.clearInterval(timer);
              setPollTimer(undefined);
              void load();
            }
          } catch {
            // Keep polling until the window elapses.
          }
          if (attempts >= 10) {
            window.clearInterval(timer);
            setPollTimer(undefined);
          }
        })();
      }, 1500);
      setPollTimer(timer);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyScenario(null);
    }
  };

  const succeeded = dashboard?.runs.byStatus['succeeded'] ?? 0;
  const finished =
    succeeded +
    (dashboard?.runs.byStatus['failed'] ?? 0) +
    (dashboard?.runs.byStatus['cancelled'] ?? 0);
  const pendingCount = approvals === null ? null : approvals.length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-start gap-4">
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            AI proposes, deterministic policy constrains, humans decide, the domain services own the write.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {updatedAt !== null ? (
            <span className="text-xs text-[var(--color-ink-faint)]">Updated {formatDateTime(updatedAt)}</span>
          ) : null}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink)] transition-colors hover:border-[var(--color-primary)] disabled:opacity-40"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error ? <ApiNotice error={error} /> : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Headline
          label="Runs"
          value={dashboard === null ? '…' : String(dashboard.runs.total)}
          hint={
            dashboard === null
              ? 'all executions for this tenant'
              : `${dashboard.runs.last24h} in the last 24h${
                  dashboard.runs.medianDurationMs === null
                    ? ''
                    : ` · median ${(dashboard.runs.medianDurationMs / 1000).toFixed(1)}s`
                }`
          }
          href="/runs"
          accent={undefined}
        />
        <Headline
          label="Success rate"
          value={dashboard === null ? '…' : finished === 0 ? '—' : `${Math.round((succeeded / finished) * 100)}%`}
          hint={dashboard === null ? 'over finished runs' : `${succeeded} of ${finished} finished runs`}
          href={undefined}
          accent={dashboard !== null && finished > 0 && succeeded < finished ? 'var(--color-warning)' : undefined}
        />
        <Headline
          label="Tokens"
          value={
            dashboard === null
              ? '…'
              : `${compactCount(dashboard.tokens.inputTokens)} / ${compactCount(dashboard.tokens.outputTokens)}`
          }
          hint={dashboard === null ? 'input / output' : `in / out · ${dashboard.tokens.calls} model calls`}
          href={undefined}
          accent={undefined}
        />
        <Headline
          label="Estimated cost"
          value={dashboard === null ? '…' : formatCents(dashboard.tokens.estimatedCostCents)}
          hint="priced from the model catalogue"
          href={undefined}
          accent={undefined}
        />
        <Headline
          label="Pending approvals"
          value={pendingCount === null ? '…' : String(pendingCount)}
          hint="anything that moves pay waits for a human"
          href="/approvals"
          accent={pendingCount !== null && pendingCount > 0 ? 'var(--color-node-approval)' : undefined}
        />
      </section>

      <section className={`${panel} flex flex-col gap-3`}>
        <h2 className={panelHeading}>Runs by status</h2>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {runStatuses.map((status) => {
            const count = dashboard?.runs.byStatus[status] ?? 0;
            return (
              <span
                key={status}
                className={`flex items-center gap-2 ${dashboard !== null && count === 0 ? 'opacity-40' : ''}`}
              >
                <RunStatusPill status={status} />
                <span className="text-sm font-semibold">{dashboard === null ? '…' : count}</span>
              </span>
            );
          })}
        </div>
      </section>

      <section className={`${panel} flex flex-col gap-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={panelHeading}>Workflows</h2>
          <Link href="/builder" className="text-xs text-[var(--color-primary)] underline underline-offset-2">
            Open the builder
          </Link>
        </div>
        {dashboard !== null && dashboard.workflows.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                <th className="pb-2 font-medium">Workflow</th>
                <th className="pb-2 font-medium">Versions</th>
                <th className="pb-2 font-medium">Runs</th>
                <th className="pb-2 font-medium">Last run</th>
                <th className="pb-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.workflows.map((workflow) => (
                <tr key={workflow.workflowId} className="border-t border-[var(--color-border-subtle)]">
                  <td className="py-2 pr-4">
                    <Link
                      href={`/builder/${workflow.workflowId}`}
                      className="font-medium transition-colors hover:text-[var(--color-primary)]"
                    >
                      {workflow.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {workflow.publishedVersion === null
                      ? `unpublished · draft v${workflow.draftVersion}`
                      : `v${workflow.publishedVersion} live · draft v${workflow.draftVersion}`}
                  </td>
                  <td className="py-2 pr-4">{workflow.runs}</td>
                  <td className="py-2 pr-4 text-xs text-[var(--color-ink-faint)]">
                    {workflow.lastRunAt === null ? 'never' : formatDateTime(workflow.lastRunAt)}
                  </td>
                  <td className="py-2">
                    <span
                      className="rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
                      style={{
                        color: workflow.enabled ? 'var(--color-success)' : 'var(--color-ink-faint)',
                        backgroundColor: workflow.enabled
                          ? 'var(--color-success-soft)'
                          : 'var(--color-surface-raised)',
                      }}
                    >
                      {workflow.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : dashboard !== null ? (
          <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-4 text-center text-xs text-[var(--color-ink-faint)]">
            No workflows yet — compose one in the builder.
          </p>
        ) : null}
      </section>

      <section className={`${panel} flex flex-col gap-3`}>
        <h2 className={panelHeading}>Demo scenarios</h2>
        {Object.entries(scenarioCopy).map(([scenario, copy]) => {
          const scenarioId = scenario as SimulatorScenario;
          return (
            <div key={scenario} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                disabled={busyScenario !== null}
                onClick={() => void runScenario(scenarioId)}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
                style={{
                  backgroundColor:
                    scenario === 'coverage_rescue' ? 'var(--color-node-condition)' : 'var(--color-node-action)',
                }}
              >
                {busyScenario === scenarioId ? 'Running…' : copy.label}
              </button>
              <p className="flex-1 text-xs text-[var(--color-ink-muted)]">{copy.description}</p>
            </div>
          );
        })}
        {result !== null ? (
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs">
            <p className="text-[var(--color-ink-muted)]">{result.response.note}</p>
            <p className="mt-1 text-[var(--color-ink-faint)]">
              emitted:{' '}
              {result.response.emittedEvents.map((eventType) => (
                <span key={eventType} className="font-mono">
                  {eventType}{' '}
                </span>
              ))}
            </p>
            {result.linkedRunId !== undefined ? (
              <Link
                href={`/runs/${result.linkedRunId}`}
                className="mt-2 inline-block text-sm font-medium text-[var(--color-primary)] underline underline-offset-2"
              >
                {result.linkedRunName} — watch the run
              </Link>
            ) : (
              <p className="mt-2 text-[var(--color-ink-faint)]">
                watching for the run to start…{' '}
                <Link href="/runs" className="underline underline-offset-2">
                  open runs
                </Link>
              </p>
            )}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={panelHeading}>Recent runs</h2>
        {runs !== null && runs.length > 0 ? (
          runs.map((run) => (
            <Link
              key={run.runId}
              href={`/runs/${run.runId}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-primary)]"
            >
              <span className="text-sm font-medium">{run.workflowName}</span>
              <span className="font-mono text-[11px] text-[var(--color-node-trigger)]">{run.triggerEventType}</span>
              <RunStatusPill status={run.status} />
              <span className="ml-auto text-xs text-[var(--color-ink-faint)]">
                {formatDuration(run.startedAt, run.finishedAt)}
              </span>
            </Link>
          ))
        ) : runs !== null ? (
          <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-4 text-center text-xs text-[var(--color-ink-faint)]">
            No runs yet — fire a scenario above.
          </p>
        ) : null}
      </section>
    </div>
  );
}
