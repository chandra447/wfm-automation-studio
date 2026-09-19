'use client';

import { ApiFailure } from '@/lib/api';

/**
 * Error banner for API-backed pages. A 403 is the demo's authorisation proof:
 * it gets its own wording so the reviewer can see the role check fire.
 */
export function ApiNotice({ error, heading = 'Request failed' }: { error: unknown; heading?: string }) {
  const forbidden = error instanceof ApiFailure && error.status === 403;
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ApiFailure ? `HTTP ${error.status}: ` : '';
  return (
    <div
      className="rounded-lg border p-4 text-sm"
      style={{
        backgroundColor: forbidden ? 'var(--color-danger-soft)' : 'var(--color-warning-soft)',
        borderColor: 'var(--color-border-subtle)',
        color: forbidden ? 'var(--color-danger)' : 'var(--color-warning)',
      }}
      role="alert"
    >
      <p className="font-medium">{forbidden ? 'Not allowed' : heading}</p>
      <p className="mt-1 text-[var(--color-ink-muted)]">
        {forbidden ? `Your role cannot approve this. ${message}` : `${status}${message}`}
      </p>
    </div>
  );
}
