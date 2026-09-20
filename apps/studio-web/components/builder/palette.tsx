'use client';

import { useState, type DragEvent } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import type { WorkflowNodeType } from '@wfm/workflows';
import { nodePalette } from '@wfm/workflows';
import { Input } from '@/components/ui/input';
import { nodeIconByType } from './node-icons';
import { accentVarByNodeType } from './state';

/** Every kind maps to exactly one section, so a new kind cannot fall out of the list. */
const groupByType: Record<WorkflowNodeType, string> = {
  trigger: 'Triggers',
  condition: 'Decisions',
  ai_decision: 'Decisions',
  agent: 'Decisions',
  policy_check: 'Policy',
  human_approval: 'Approvals',
  action: 'Actions',
  artifact: 'Artifacts',
  end: 'Flow',
};

const GROUP_ORDER = ['Triggers', 'Decisions', 'Policy', 'Approvals', 'Actions', 'Artifacts', 'Flow'] as const;

type PaletteEntry = (typeof nodePalette)[number];

function PaletteRow({
  entry,
  disabled,
  onAdd,
}: {
  entry: PaletteEntry;
  disabled?: boolean | undefined;
  onAdd: (nodeType: WorkflowNodeType) => void;
}) {
  const Icon = nodeIconByType[entry.type];
  const accent = accentVarByNodeType[entry.type];
  return (
    <button
      type="button"
      draggable
      onDragStart={(event: DragEvent<HTMLButtonElement>) => {
        event.dataTransfer.setData('application/wfm-node-type', entry.type);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onAdd(entry.type)}
      disabled={disabled}
      className="flex w-full cursor-grab items-start gap-2.5 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-raised)] disabled:pointer-events-none disabled:opacity-40"
    >
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md"
        style={{
          backgroundColor: `color-mix(in oklab, ${accent} 22%, transparent)`,
          color: accent,
        }}
      >
        <Icon className="size-4" weight="duotone" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-[var(--color-ink)]">{entry.label}</span>
        <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-ink-faint)]">
          {entry.description}
        </span>
      </span>
    </button>
  );
}

export function Palette({ onAdd, disabled }: { onAdd: (nodeType: WorkflowNodeType) => void; disabled?: boolean }) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const matching = nodePalette.filter(
    (entry) =>
      query === '' ||
      entry.label.toLowerCase().includes(query) ||
      entry.description.toLowerCase().includes(query),
  );
  const groups = GROUP_ORDER.map((title) => ({
    title,
    entries: matching.filter((entry) => groupByType[entry.type] === title),
  })).filter((group) => group.entries.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-3">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--color-ink-faint)]" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Filter components"
            placeholder="Filter components…"
            className="pl-7"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {groups.length === 0 ? (
          <p className="px-1 text-[11px] text-[var(--color-ink-faint)]">No components match “{search.trim()}”.</p>
        ) : (
          groups.map((group) => (
            <section key={group.title} className="mb-3 last:mb-0">
              <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
                {group.title}
              </p>
              <div className="flex flex-col">
                {group.entries.map((entry) => (
                  <PaletteRow key={entry.type} entry={entry} disabled={disabled} onAdd={onAdd} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      <p className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-2.5 text-[10px] leading-snug text-[var(--color-ink-faint)]">
        Drag onto the canvas or click to add. Wire ports by dragging from a node&apos;s edge.
      </p>
    </div>
  );
}
