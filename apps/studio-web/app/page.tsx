'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Approval, RunSummary, SimulatorResponse, SimulatorScenario } from '@wfm/contracts';
import { apiFetch } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { ApiNotice } from '@/components/runs/api-notice';
import { RunStatusPill } from '@/components/runs/run-status-pill';
import { formatDuration } from '@/components/runs/format';

/** Engine list response shape (services/studio-api engine contract). */
interface WorkflowListItem {
  workflowId: string;
  name: string;
  description: string;
  enabled: boolean;
  publishedVersionNumber: number | null;
  updatedAt: string;
}

interface EngineWorkflowsResponse {
  workflows: WorkflowListItem[];
}

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

export default function OverviewPage() {
  const { headers } = useDemoActor();
  const [workflows, setWorkflows] = useState<EngineWorkflowsResponse | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyScenario, setBusyScenario] = useState<SimulatorScenario | null>(null);
  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [pollTimer, setPollTimer] = useState<number | undefined>(undefined);
  const pollTimerRef = useRef<number | undefined>(undefined);
  pollTimerRef.current = pollTimer;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [workflowList, runList, pending] = await Promise.all([
        apiFetch<EngineWorkflowsResponse>('/workflows', { headers }),
        apiFetch<RunSummary[]>('/runs?limit=5', { headers }),
        apiFetch<Approval[]>('/approvals?status=pending', { headers }),
      ]);
      setWorkflows(workflowList);
      setRuns(runList);
      setApprovals(pending);
    } catch (caught) {
      setError(caught);
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
              setResult((current) => (current === null ? current : { ...current, linkedRunId: newcomer.runId, linkedRunName: newcomer.workflowName }));
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

  const workflowCount = workflows === null ? null : workflows.workflows.length;
  const enabledCount = workflows === null ? 0 : workflows.workflows.filter((workflow) => workflow.enabled).length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          AI proposes, deterministic policy constrains, humans decide, the domain services own the write.
        </p>
      </header>

      {error ? <ApiNotice error={error} /> : null}

      <section className="grid gap-3 sm:grid-cols-3">
        <Link href="/builder" className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-primary)]">
          <p className="text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Workflows</p>
          <p className="mt-1 text-2xl font-semibold">{workflowCount === null ? '…' : workflowCount}</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {workflowCount === null ? '' : `${enabledCount} enabled · compose one in the builder`}
          </p>
        </Link>
        <Link href="/runs" className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-primary)]">
          <p className="text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Recent runs</p>
          <p className="mt-1 text-2xl font-semibold">{runs === null ? '…' : runs.length}</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">latest executions with their reasoning trail</p>
        </Link>
        <Link href="/approvals" className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-primary)]">
          <p className="text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Pending approvals</p>
          <p className="mt-1 text-2xl font-semibold" style={approvals !== null && approvals.length > 0 ? { color: 'var(--color-node-approval)' } : undefined}>
            {approvals === null ? '…' : approvals.length}
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">anything that moves pay waits for a human</p>
        </Link>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
        <h2 className="text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Demo scenarios</h2>
        {Object.entries(scenarioCopy).map(([scenario, copy]) => {
          const scenarioId = scenario as SimulatorScenario;
          return (
            <div key={scenario} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                disabled={busyScenario !== null}
                onClick={() => void runScenario(scenarioId)}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
                style={{ backgroundColor: scenario === 'coverage_rescue' ? 'var(--color-node-condition)' : 'var(--color-node-action)' }}
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
              emitted: {result.response.emittedEvents.map((eventType) => <span key={eventType} className="font-mono">{eventType} </span>)}
            </p>
            {result.linkedRunId !== undefined ? (
              <Link href={`/runs/${result.linkedRunId}`} className="mt-2 inline-block text-sm font-medium text-[var(--color-primary)] underline underline-offset-2">
                {result.linkedRunName} — watch the run
              </Link>
            ) : (
              <p className="mt-2 text-[var(--color-ink-faint)]">watching for the run to start… <Link href="/runs" className="underline underline-offset-2">open runs</Link></p>
            )}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">Recent runs</h2>
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
              <span className="ml-auto text-xs text-[var(--color-ink-faint)]">{formatDuration(run.startedAt, run.finishedAt)}</span>
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
