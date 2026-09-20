'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TriggerDescriptor } from '@wfm/contracts';
import { apiFetch } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { ApiNotice } from '@/components/runs/api-notice';

const ownerLabels: Record<TriggerDescriptor['owner'], string> = {
  rostering: 'Rostering',
  'time-attendance': 'Time & attendance',
  studio: 'Studio',
};

const ownerColors: Record<TriggerDescriptor['owner'], string> = {
  rostering: 'var(--color-node-condition)',
  'time-attendance': 'var(--color-node-action)',
  studio: 'var(--color-node-ai)',
};

/** The order the sources are read in: the two domain services, then the platform's own. */
const OWNER_ORDER: readonly TriggerDescriptor['owner'][] = ['rostering', 'time-attendance', 'studio'];

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">{label}</span>
      <pre className="max-h-64 overflow-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/**
 * The catalogue is a table because it is one: fifteen events with the same four
 * facts each. Grouped by the service that owns them, because that is the
 * question an author arrives with — what can this service tell my workflow —
 * and the schema and sample open under their own row rather than in a panel
 * that would cover the list they were reading.
 */
export default function TriggersPage() {
  const { headers } = useDemoActor();
  const [triggers, setTriggers] = useState<TriggerDescriptor[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [openEventType, setOpenEventType] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTriggers(await apiFetch<TriggerDescriptor[]>('/triggers', { headers }));
    } catch (caught) {
      setError(caught);
    }
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(
    () =>
      OWNER_ORDER.map((owner) => ({
        owner,
        triggers: (triggers ?? []).filter((trigger) => trigger.owner === owner),
      })).filter((group) => group.triggers.length > 0),
    [triggers],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-lg font-semibold">Trigger catalogue</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Every platform event a workflow can react to. Events are skinny — identity and facts that are
          true at emit time; the engine always re-reads current state before proposing anything.
        </p>
        {triggers !== null && error === null ? (
          <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
            {triggers.length} events across {groups.length} sources
          </p>
        ) : null}
      </header>

      {error ? <ApiNotice error={error} /> : null}

      {triggers !== null && error === null ? (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)]">
                <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                  Event
                </th>
                <th scope="col" className="w-20 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                  Version
                </th>
                <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                  What it means
                </th>
                <th scope="col" className="w-40 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                  Payload
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.owner}>
                <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
                  <th scope="colgroup" colSpan={4} className="px-4 py-2 font-normal">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: ownerColors[group.owner] }}
                      />
                      <span
                        className="text-[11px] font-medium uppercase tracking-wide"
                        style={{ color: ownerColors[group.owner] }}
                      >
                        {ownerLabels[group.owner]}
                      </span>
                      <span className="text-[11px] text-[var(--color-ink-faint)]">
                        {group.triggers.length} {group.triggers.length === 1 ? 'event' : 'events'}
                      </span>
                    </span>
                  </th>
                </tr>
                {group.triggers.map((trigger) => {
                  const open = openEventType === trigger.eventType;
                  return (
                    <TriggerRow
                      key={trigger.eventType}
                      trigger={trigger}
                      open={open}
                      onToggle={() => setOpenEventType(open ? null : trigger.eventType)}
                    />
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      ) : null}
    </div>
  );
}

function TriggerRow({
  trigger,
  open,
  onToggle,
}: {
  trigger: TriggerDescriptor;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-[var(--color-border-subtle)] transition-colors last:border-b-0 hover:bg-[var(--color-surface-raised)]"
      >
        <td className="px-4 py-2.5 font-mono text-xs text-[var(--color-ink)]">{trigger.eventType}</td>
        <td className="px-4 py-2.5 text-xs text-[var(--color-ink-muted)]">v{trigger.eventVersion}</td>
        <td className="px-4 py-2.5 text-xs text-[var(--color-ink-muted)]">{trigger.summary}</td>
        <td className="px-4 py-2.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            className="text-[11px] text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink-muted)] hover:underline"
          >
            {open ? 'hide' : 'schema & sample'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-canvas)]">
          <td colSpan={4} className="px-4 py-4">
            <div className="grid gap-4 md:grid-cols-2">
              <JsonBlock label="JSON Schema" value={trigger.jsonSchema} />
              <JsonBlock label="Sample event" value={trigger.sample} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
