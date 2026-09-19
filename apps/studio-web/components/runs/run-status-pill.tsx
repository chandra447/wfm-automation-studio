'use client';

import type { RunStatus } from '@wfm/contracts';
import { cn } from '@/lib/utils';

const statusTone: Record<RunStatus, { label: string; color: string; background: string }> = {
  queued: { label: 'Queued', color: 'var(--color-ink-muted)', background: 'var(--color-surface-raised)' },
  running: { label: 'Running', color: 'var(--color-node-condition)', background: 'var(--color-surface-raised)' },
  awaiting_approval: { label: 'Awaiting approval', color: 'var(--color-node-approval)', background: 'var(--color-danger-soft)' },
  succeeded: { label: 'Succeeded', color: 'var(--color-success)', background: 'var(--color-success-soft)' },
  failed: { label: 'Failed', color: 'var(--color-danger)', background: 'var(--color-danger-soft)' },
  cancelled: { label: 'Cancelled', color: 'var(--color-ink-faint)', background: 'var(--color-surface-raised)' },
};

export function RunStatusPill({ status, className }: { status: RunStatus; className?: string }) {
  const tone = statusTone[status];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium whitespace-nowrap', className)}
      style={{ color: tone.color, backgroundColor: tone.background }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tone.color }} />
      {tone.label}
    </span>
  );
}
