'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiFailure } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DataCatalogue } from './api-types';
import type { ControlOption } from './control-options';
import { useTemplateFields } from './field-renderer';

export interface DataPaletteProps {
  eventType: string;
  triggerEvents: readonly ControlOption[];
  headers: Record<string, string>;
}

/**
 * The catalogue of everything a {{...}} reference can read, for the workflow's
 * trigger event. Clicking a path inserts it at the caret of the template field
 * the author last touched.
 */
export function DataPalette({ eventType, triggerEvents, headers }: DataPaletteProps) {
  const { insert, active } = useTemplateFields();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState(eventType);
  const [following, setFollowing] = useState(eventType);
  const [catalogue, setCatalogue] = useState<DataCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (following !== eventType) {
    setFollowing(eventType);
    setSelected(eventType);
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const loaded = await apiFetch<DataCatalogue>(
          `/data-catalogue?eventType=${encodeURIComponent(selected)}`,
          { headers },
        );
        if (!alive) return;
        setCatalogue(loaded);
        setError(null);
      } catch (failure) {
        if (!alive) return;
        setCatalogue(null);
        setError(
          failure instanceof ApiFailure ? failure.message : 'The data catalogue is unreachable.',
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [selected, headers]);

  if (!open) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] py-2">
        <Button variant="ghost" size="icon-xs" aria-label="Show data palette" onClick={() => setOpen(true)}>
          ◂
        </Button>
        <p className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)] [writing-mode:vertical-rl]">
          Data
        </p>
      </aside>
    );
  }

  const eventOptions = triggerEvents.some((option) => option.value === selected)
    ? triggerEvents
    : [{ value: selected, label: selected }, ...triggerEvents];

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">Data</p>
        <Button variant="ghost" size="icon-xs" aria-label="Hide data palette" onClick={() => setOpen(false)}>
          ▸
        </Button>
      </header>
      <div className="flex flex-col gap-2 border-b border-[var(--color-border-subtle)] px-3 py-3">
        <Label className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">
          Trigger event
        </Label>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger size="sm" className="w-full font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {eventOptions.map((option) => (
              <SelectItem key={option.value} value={option.value} className="font-mono text-xs">
                {option.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] leading-snug text-[var(--color-ink-faint)]">
          {active === null
            ? 'Click a field that allows templates, then click a path here.'
            : `Inserting into ${active.label}.`}
        </p>
        {notice !== null && <p className="text-[10px] text-[var(--color-warning)]">{notice}</p>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {error !== null && <p className="text-[10px] leading-snug text-[var(--color-warning)]">{error}</p>}
        {catalogue === null && error === null && (
          <p className="text-[10px] text-[var(--color-ink-faint)]">Loading the catalogue…</p>
        )}
        {catalogue?.roots.map((root) => (
          <section key={root.name} className="flex flex-col gap-1">
            <p className="text-[11px] font-medium text-[var(--color-ink)]">{root.label}</p>
            <p className="text-[10px] leading-snug text-[var(--color-ink-faint)]">{root.description}</p>
            <div className="mt-1 flex flex-col gap-0.5">
              {root.paths.map((path) => (
                <button
                  key={path.path}
                  type="button"
                  title={`Insert {{${path.path}}}`}
                  onClick={() => setNotice(insert(`{{${path.path}}}`) ? null : 'Click a template field first.')}
                  className="flex w-full flex-col rounded-md border border-transparent px-2 py-1 text-left hover:border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-raised)]"
                >
                  <span className="block truncate font-mono text-[10px] text-[var(--color-ink)]">
                    {path.path}
                  </span>
                  <span className="block truncate text-[10px] text-[var(--color-ink-faint)]">
                    {path.type}
                  </span>
                  {path.sample.length > 0 && (
                    <span className="block truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {path.sample}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}
