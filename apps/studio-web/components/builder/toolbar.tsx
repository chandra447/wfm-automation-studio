'use client';

import Link from 'next/link';
import { ArrowClockwise, ArrowCounterClockwise, ArrowLeft } from '@phosphor-icons/react';
import type { WorkflowDefinition } from '@wfm/workflows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'failed' | 'conflict';

/**
 * The floating top bar. It keeps the whole run of workflow-level actions in one
 * rounded strip over the canvas: what the workflow is called, whether the draft
 * is on the server, and the undo/save/publish controls.
 */
export function Toolbar({
  definition,
  saveState,
  lastSavedAt,
  offline,
  publishedVersion,
  errorCount,
  canUndo,
  canRedo,
  saving,
  publishing,
  onRename,
  onUndo,
  onRedo,
  onSaveNow,
  onPublish,
}: {
  definition: WorkflowDefinition;
  saveState: SaveState;
  lastSavedAt: number | null;
  offline: boolean;
  publishedVersion: number | null;
  errorCount: number;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  publishing: boolean;
  onRename: (name: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSaveNow: () => void;
  onPublish: () => void;
}) {
  const saveLabel = offline
    ? 'API offline'
    : saveState === 'saving'
      ? 'Saving…'
      : saveState === 'failed'
        ? 'Save failed'
        : saveState === 'dirty'
          ? 'Unsaved changes'
          : lastSavedAt !== null
            ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}`
            : 'Saved';

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 shadow-2xl shadow-black/50">
      <Link
        href="/builder"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Workflows
      </Link>
      <Input
        value={definition.name}
        maxLength={120}
        aria-label="Workflow name"
        className="h-8 w-56 text-sm"
        onChange={(event) => onRename(event.target.value)}
      />
      <span
        className={cn(
          'flex items-center gap-1.5 text-[11px]',
          saveState === 'failed' || saveState === 'conflict'
            ? 'text-[var(--color-danger)]'
            : 'text-[var(--color-ink-faint)]',
        )}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor:
              saveState === 'clean'
                ? 'var(--color-success)'
                : saveState === 'failed' || saveState === 'conflict'
                  ? 'var(--color-danger)'
                  : 'var(--color-warning)',
          }}
        />
        {saveLabel}
      </span>
      {publishedVersion !== null && (
        <Badge className="bg-[var(--color-success-soft)] text-[var(--color-success)]">
          published v{publishedVersion}
        </Badge>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="icon-sm" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
          <ArrowCounterClockwise />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
          <ArrowClockwise />
        </Button>
        <Button variant="outline" size="sm" disabled={offline || saveState === 'clean' || saving} onClick={onSaveNow}>
          Save
        </Button>
        <Button
          size="sm"
          disabled={offline || errorCount > 0 || publishing}
          title={errorCount > 0 ? `${errorCount} validation error${errorCount === 1 ? '' : 's'} block publishing` : undefined}
          onClick={onPublish}
        >
          {publishing ? 'Publishing…' : 'Publish'}
        </Button>
      </div>
    </div>
  );
}
