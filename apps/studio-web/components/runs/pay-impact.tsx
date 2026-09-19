'use client';

import { cn } from '@/lib/utils';
import { formatCents } from './format';

const toneFor = (cents: number): { text: string; bg: string; border: string; prefix: string } => {
  if (cents === 0) return { text: 'var(--color-ink-muted)', bg: 'var(--color-surface-raised)', border: 'var(--color-border-subtle)', prefix: 'no pay impact' };
  if (cents > 0) return { text: 'var(--color-warning)', bg: 'var(--color-warning-soft)', border: 'var(--color-border-subtle)', prefix: 'pays' };
  return { text: 'var(--color-success)', bg: 'var(--color-success-soft)', border: 'var(--color-border-subtle)', prefix: 'saves' };
};

export function PayImpactBadge({ cents, className }: { cents: number; className?: string }) {
  const tone = toneFor(cents);
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', className)}
      style={{
        color: tone.text,
        backgroundColor: tone.bg,
        borderColor: cents === 0 ? 'var(--color-border-subtle)' : 'transparent',
      }}
    >
      <span aria-hidden>{cents > 0 ? '↑' : cents < 0 ? '↓' : '·'}</span>
      {cents === 0 ? tone.prefix : `${tone.prefix} ${formatCents(Math.abs(cents))}`}
    </span>
  );
}
