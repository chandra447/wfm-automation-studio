'use client';

import type { DragEvent } from 'react';
import { motion } from 'motion/react';
import type { WorkflowNodeType } from '@wfm/workflows';
import { nodePalette } from '@wfm/workflows';
import { accentVarByNodeType } from './state';

const paletteIcons: Record<WorkflowNodeType, string> = {
  trigger: '⚡',
  condition: '⑂',
  ai_decision: '✦',
  policy_check: '⛨',
  human_approval: '👤',
  action: '➤',
  artifact: '📄',
  end: '■',
};

export function Palette({ onAdd, disabled }: { onAdd: (nodeType: WorkflowNodeType) => void; disabled?: boolean }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
      <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
        Palette
      </p>
      {nodePalette.map((item, index) => (
        <motion.div
          key={item.type}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.03, duration: 0.25 }}
        >
          <button
            type="button"
            draggable
            onDragStart={(event: DragEvent<HTMLButtonElement>) => {
              event.dataTransfer.setData('application/wfm-node-type', item.type);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onAdd(item.type)}
            disabled={disabled}
            className="flex w-full cursor-grab items-start gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-raised)] disabled:pointer-events-none disabled:opacity-40"
          >
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[11px]"
              style={{ backgroundColor: accentVarByNodeType[item.type], color: 'var(--color-canvas)' }}
            >
              {paletteIcons[item.type]}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-[var(--color-ink)]">{item.label}</span>
              <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-ink-faint)]">
                {item.description}
              </span>
            </span>
          </button>
        </motion.div>
      ))}
      <p className="mt-2 px-1 text-[10px] leading-snug text-[var(--color-ink-faint)]">
        Drag onto the canvas or click to add. Wire ports by dragging from a node&apos;s right edge.
      </p>
    </aside>
  );
}
