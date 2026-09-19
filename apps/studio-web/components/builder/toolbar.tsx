'use client';

import Link from 'next/link';
import type { WorkflowDefinition } from '@wfm/workflows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'failed' | 'conflict';

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
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2">
      <Link
        href="/builder"
        className="rounded-md px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
      >
        ← Workflows
      </Link>
      <Input
        value={definition.name}
        maxLength={120}
        aria-label="Workflow name"
        className="h-8 w-64 text-sm"
        onChange={(event) => onRename(event.target.value)}
      />
      <span
        className={cn(
          'flex items-center gap-1.5 text-[11px]',
          saveState === 'failed' || saveState === 'conflict' ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-faint)]',
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
          ↺
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
          ↻
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
