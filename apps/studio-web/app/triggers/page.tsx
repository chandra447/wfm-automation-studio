'use client';

import { useCallback, useEffect, useState } from 'react';
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

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-wide uppercase text-[var(--color-ink-faint)]">{label}</span>
      <pre className="max-h-64 overflow-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-lg font-semibold">Trigger catalogue</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Every platform event a workflow can react to. Events are skinny — identity and facts that are
          true at emit time; the engine always re-reads current state before proposing anything.
        </p>
      </header>

      {error ? <ApiNotice error={error} /> : null}

      {triggers !== null && error === null ? (
        <ul className="flex flex-col gap-2">
          {triggers.map((trigger) => {
            const open = openEventType === trigger.eventType;
            return (
              <li
                key={trigger.eventType}
                className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
              >
                <button
                  type="button"
                  onClick={() => setOpenEventType(open ? null : trigger.eventType)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 p-4 text-left"
                  aria-expanded={open}
                >
                  <span className="font-mono text-sm font-medium" style={{ color: ownerColors[trigger.owner] }}>
                    {trigger.eventType}
                  </span>
                  <span className="rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] text-[var(--color-ink-muted)]">
                    v{trigger.eventVersion}
                  </span>
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{ color: ownerColors[trigger.owner], backgroundColor: 'var(--color-surface-raised)' }}
                  >
                    {ownerLabels[trigger.owner]}
                  </span>
                  <span className="flex-1 text-xs text-[var(--color-ink-muted)]">{trigger.summary}</span>
                  <span className="text-[11px] text-[var(--color-ink-faint)]">{open ? 'hide' : 'schema & sample'}</span>
                </button>
                {open ? (
                  <div className="grid gap-4 border-t border-[var(--color-border-subtle)] p-4 md:grid-cols-2">
                    <JsonBlock label="JSON Schema" value={trigger.jsonSchema} />
                    <JsonBlock label="Sample event" value={trigger.sample} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
