'use client';

import { CaretDown, CaretUp, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import type { Diagnostic } from '@wfm/workflows';
import { cn } from '@/lib/utils';

/**
 * The validation summary: a pill in the bottom-left corner of the canvas that
 * expands upward into the diagnostic list, so the count is always readable and
 * the list only takes screen space while it is open.
 */
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
    <div className="flex w-[24rem] flex-col gap-2">
      {open && (
        <section
          aria-label="Diagnostics"
          className="flex max-h-[52vh] min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl shadow-black/50"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
            <h2 className="text-xs font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
              Validation
            </h2>
            {errors.length > 0 ? (
              <span className="text-[11px] text-[var(--color-danger)]">
                {errors.length} error{errors.length === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="text-[11px] text-[var(--color-success)]">no errors</span>
            )}
            {warnings.length > 0 && (
              <span className="text-[11px] text-[var(--color-warning)]">
                {warnings.length} warning{warnings.length === 1 ? '' : 's'}
              </span>
            )}
            {hasServerRejection && (
              <span className="text-[11px] text-[var(--color-danger)]">server rejected the last save</span>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {diagnostics.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-[var(--color-ink-faint)]">
                No diagnostics — the definition is valid.
              </p>
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
        </section>
      )}

      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          'flex items-center gap-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-left shadow-2xl shadow-black/50 transition-colors',
          'hover:bg-[var(--color-surface-raised)]',
        )}
      >
        {errors.length > 0 ? (
          <WarningCircle className="h-4 w-4 shrink-0 text-[var(--color-danger)]" weight="fill" />
        ) : (
          <CheckCircle className="h-4 w-4 shrink-0 text-[var(--color-success)]" weight="fill" />
        )}
        <span className="text-xs text-[var(--color-ink-faint)]">Validation</span>
        <span
          className={cn(
            'text-xs font-medium',
            errors.length > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]',
          )}
        >
          {errors.length > 0 ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : 'no errors'}
        </span>
        {warnings.length > 0 && (
          <span className="text-[11px] text-[var(--color-warning)]">
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </span>
        )}
        {hasServerRejection && (
          <span className="text-[11px] text-[var(--color-danger)]">server rejected</span>
        )}
        <span className="ml-auto text-[var(--color-ink-faint)]">
          {open ? <CaretDown className="h-3.5 w-3.5" /> : <CaretUp className="h-3.5 w-3.5" />}
        </span>
      </button>
    </div>
  );
}
