'use client';

import type { RunEvent } from '@wfm/contracts';
import { formatDateTime } from './format';
import { PayImpactBadge } from './pay-impact';

/**
 * RunEvent.data is intentionally open: the engine appends step facts that vary
 * per node. The timeline reads the fields it knows how to present and renders
 * the rest as raw JSON.
 */
interface EventFacts {
  rationale?: string;
  evidence?: Array<{ label?: string; value: string }>;
  payImpactCents?: number;
  idempotencyKey?: string;
  command?: string;
  commandType?: string;
  decision?: string;
  decidedBy?: string;
}

/** Engine step data crosses the network unvalidated; each field is checked at use. */
function factsOf(data: unknown): EventFacts {
  if (typeof data !== 'object' || data === null) return {};
  const raw = data as Record<string, unknown>;
  const facts: EventFacts = {};
  if (typeof raw.rationale === 'string') facts.rationale = raw.rationale;
  if (typeof raw.payImpactCents === 'number') facts.payImpactCents = raw.payImpactCents;
  if (typeof raw.idempotencyKey === 'string') facts.idempotencyKey = raw.idempotencyKey;
  if (typeof raw.command === 'string') facts.command = raw.command;
  if (typeof raw.commandType === 'string') facts.commandType = raw.commandType;
  if (typeof raw.decision === 'string') facts.decision = raw.decision;
  if (typeof raw.decidedBy === 'string') facts.decidedBy = raw.decidedBy;
  if (Array.isArray(raw.evidence)) {
    const evidence: NonNullable<EventFacts['evidence']> = [];
    for (const entry of raw.evidence) {
      if (typeof entry !== 'object' || entry === null) continue;
      const candidate = entry as { label?: unknown; value?: unknown };
      if (typeof candidate.value !== 'string') continue;
      evidence.push({
        value: candidate.value,
        ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
      });
    }
    if (evidence.length > 0) facts.evidence = evidence;
  }
  return facts;
}

const kindTone: Record<RunEvent['kind'], { label: string; color: string }> = {
  event_received: { label: 'Event', color: 'var(--color-node-trigger)' },
  context_resolved: { label: 'Context', color: 'var(--color-node-condition)' },
  policy_evaluated: { label: 'Policy', color: 'var(--color-node-policy)' },
  proposal_created: { label: 'Proposal', color: 'var(--color-node-ai)' },
  approval_requested: { label: 'Approval needed', color: 'var(--color-node-approval)' },
  approval_decided: { label: 'Approval decided', color: 'var(--color-primary)' },
  action_executed: { label: 'Action executed', color: 'var(--color-node-action)' },
  run_completed: { label: 'Run completed', color: 'var(--color-success)' },
  run_failed: { label: 'Run failed', color: 'var(--color-danger)' },
  note: { label: 'Note', color: 'var(--color-ink-faint)' },
};

const emphasizedByKind: Record<string, boolean> = {
  approval_requested: true,
  run_failed: true,
  run_completed: true,
};

function EventData({ facts, raw }: { facts: EventFacts; raw: unknown }) {
  const hasStructured =
    facts.rationale !== undefined ||
    facts.payImpactCents !== undefined ||
    facts.idempotencyKey !== undefined ||
    (facts.evidence?.length ?? 0) > 0 ||
    facts.command !== undefined ||
    facts.decision !== undefined;

  return (
    <div className="flex flex-col gap-2 text-xs">
      {facts.rationale === undefined ? null : (
        <p className="text-[var(--color-ink-muted)] leading-relaxed">{facts.rationale}</p>
      )}
      {facts.decision === undefined ? null : (
        <p className="text-[var(--color-ink-muted)]">
          Decision:{' '}
          <span className="font-medium" style={{ color: facts.decision === 'approve' ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {facts.decision}
          </span>
          {facts.decidedBy ? <span> · by {facts.decidedBy}</span> : null}
        </p>
      )}
      {facts.evidence === undefined ? null : (
        <ul className="flex flex-col gap-1">
          {facts.evidence.map((entry, index) => (
            <li key={index} className="text-[var(--color-ink-muted)]">
              <span className="text-[var(--color-ink-faint)]">{entry.label ?? 'evidence'}:</span> <span className="text-[var(--color-ink)]">{entry.value}</span>
            </li>
          ))}
        </ul>
      )}
      {facts.payImpactCents === undefined ? null : <PayImpactBadge cents={facts.payImpactCents} className="w-fit" />}
      {facts.command === undefined ? null : (
        <p className="text-[var(--color-ink-muted)]">
          Command: <span className="font-mono text-[var(--color-node-action)]">{facts.command}</span>
          {facts.commandType ? <span className="text-[var(--color-ink-faint)]"> ({facts.commandType})</span> : null}
        </p>
      )}
      {facts.idempotencyKey === undefined ? null : (
        <p className="text-[var(--color-ink-muted)]">
          Idempotency-Key:{' '}
          <code className="rounded bg-[var(--color-surface-raised)] px-1 py-0.5 font-mono text-[11px] text-[var(--color-ink)]">{facts.idempotencyKey}</code>
        </p>
      )}
      {hasStructured || raw === undefined || raw === null ? null : (
        <details>
          <summary className="cursor-pointer text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]">data</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-[var(--color-surface-raised)] p-2 font-mono text-[11px] text-[var(--color-ink-muted)]">
            {JSON.stringify(raw, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export function RunEventTimeline({ events, live }: { events: RunEvent[]; live?: boolean }) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  if (sorted.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-sm text-[var(--color-ink-faint)]">
        {live ? 'Waiting for the first run event…' : 'No events recorded for this run.'}
      </p>
    );
  }

  return (
    <ol className="relative flex flex-col">
      {sorted.map((event, index) => {
        const tone = kindTone[event.kind];
        const facts = factsOf(event.data);
        const last = index === sorted.length - 1;
        const emphasized = emphasizedByKind[event.kind] === true;
        return (
          <li key={`${event.seq}-${event.at}`} className="relative flex gap-3 pb-5 pl-1">
            {last ? null : (
              <span aria-hidden className="absolute top-5 bottom-0 left-[7px] w-px" style={{ backgroundColor: 'var(--color-border-subtle)' }} />
            )}
            <span
              aria-hidden
              className="relative z-10 mt-1 inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2"
              style={{
                backgroundColor: tone.color,
                borderColor: 'var(--color-canvas)',
                boxShadow: emphasized ? `0 0 0 2px ${tone.color}55` : undefined,
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium" style={{ color: tone.color }}>
                  {event.title}
                </span>
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
                  style={{ color: tone.color, backgroundColor: 'var(--color-surface-raised)' }}
                >
                  {tone.label}
                </span>
                {event.nodeId ? <span className="font-mono text-[10px] text-[var(--color-ink-faint)]">{event.nodeId}</span> : null}
                <span className="ml-auto font-mono text-[10px] text-[var(--color-ink-faint)]">{formatDateTime(event.at)}</span>
              </div>
              {event.detail ? <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{event.detail}</p> : null}
              <div className="mt-2">
                <EventData facts={facts} raw={event.data} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
