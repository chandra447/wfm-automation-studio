'use client';

import type { Diagnostic } from '@wfm/workflows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function DiagnosticsPanel({
  diagnostics,
  open,
  onToggle,
  onSelectNode,
  hasServerRejection,
}: {
  diagnostics: readonly Diagnostic[];
  open: boolean;
  onToggle: () => void;
  onSelectNode: (nodeId: string) => void;
  hasServerRejection: boolean;
}) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');

  return (
    <section className="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-3 px-4 py-2">
        <Button variant="ghost" size="xs" onClick={onToggle} className="gap-2">
          <span className={cn('inline-block transition-transform', open && 'rotate-90')}>▸</span>
          Validation
        </Button>
        {errors.length > 0 ? (
          <Badge className="bg-[var(--color-danger)] text-[var(--color-canvas)]">
            {errors.length} error{errors.length === 1 ? '' : 's'}
          </Badge>
        ) : (
          <Badge className="bg-[var(--color-success-soft)] text-[var(--color-success)]">no errors</Badge>
        )}
        {warnings.length > 0 && (
          <Badge className="bg-[var(--color-warning)] text-[var(--color-canvas)]">
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </Badge>
        )}
        {hasServerRejection && (
          <Badge className="bg-[var(--color-danger-soft)] text-[var(--color-danger)]">
            server rejected the last save
          </Badge>
        )}
        {errors.length === 0 && !hasServerRejection && (
          <p className="text-[11px] text-[var(--color-ink-faint)]">
            Ready to save and publish.
          </p>
        )}
      </div>
      {open && (
        <div className="max-h-48 overflow-y-auto px-4 pb-3">
          {diagnostics.length === 0 ? (
            <p className="py-2 text-[11px] text-[var(--color-ink-faint)]">No diagnostics — the definition is valid.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {diagnostics.map((diagnostic, index) => (
                <li
                  key={`${diagnostic.code}:${diagnostic.nodeId ?? ''}:${index}`}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px] odd:bg-[var(--color-surface-raised)]"
                >
                  <span
                    className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        diagnostic.severity === 'error' ? 'var(--color-danger)' : 'var(--color-warning)',
                    }}
                  />
                  <code className="shrink-0 rounded bg-[var(--color-canvas)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-muted)]">
                    {diagnostic.code}
                  </code>
                  <span className="min-w-0 flex-1 text-[var(--color-ink)]">{diagnostic.message}</span>
                  {diagnostic.nodeId && (
                    <button
                      type="button"
                      onClick={() => onSelectNode(diagnostic.nodeId!)}
                      className="shrink-0 font-mono text-[10px] text-[var(--color-primary)] underline-offset-2 hover:underline"
                    >
                      {diagnostic.nodeId}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
