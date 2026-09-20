'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { demoWorkflows, type CanvasLayout, type WorkflowDefinition } from '@wfm/workflows';
import { apiFetch, ApiFailure } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { defaultEventType, emptyDefinitionFor } from './state';
import type { WorkflowMutationResult, WorkflowSummary } from './api-types';

interface TemplateEntry {
  key: string;
  title: string;
  description: string;
  build: () => { definition: WorkflowDefinition; layout: CanvasLayout };
}

const blankDefinition = emptyDefinitionFor(defaultEventType());

const blankEntry: TemplateEntry = {
  key: 'blank',
  title: blankDefinition.name,
  description: 'A trigger wired to an end node. Add branches, checks, and approvals yourself.',
  build: () => ({
    definition: structuredClone(blankDefinition),
    layout: {
      viewport: { x: 0, y: 0, zoom: 1 },
      positions: { trigger: { x: 0, y: 160 }, done: { x: 320, y: 160 } },
    },
  }),
};

const templateEntries: readonly TemplateEntry[] = [
  {
    key: 'coverage-rescue',
    title: demoWorkflows[0].definition.name,
    description: demoWorkflows[0].definition.description,
    build: () => ({
      definition: structuredClone(demoWorkflows[0].definition),
      layout: structuredClone(demoWorkflows[0].layout),
    }),
  },
  {
    key: 'payroll-exception',
    title: demoWorkflows[1].definition.name,
    description: demoWorkflows[1].definition.description,
    build: () => ({
      definition: structuredClone(demoWorkflows[1].definition),
      layout: structuredClone(demoWorkflows[1].layout),
    }),
  },
];

const startEntries: readonly TemplateEntry[] = [blankEntry, ...templateEntries];

function templateSummary(definition: WorkflowDefinition): string {
  const counts: Record<string, number> = {};
  for (const node of definition.nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;
  const trigger = definition.nodes.find((node) => node.type === 'trigger');
  const on = trigger && trigger.type === 'trigger' ? ` · on ${trigger.config.eventType}` : '';
  return (
    Object.entries(counts)
      .map(([kind, count]) => (count === 1 ? kind.replace(/_/g, ' ') : `${count}× ${kind.replace(/_/g, ' ')}`))
      .join(' · ') + on
  );
}

function isoTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function GridBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_-10%,var(--color-primary-soft),transparent_45%),radial-gradient(circle_at_85%_0%,var(--color-success-soft),transparent_40%)] opacity-70" />
      <motion.div
        className="absolute -left-24 top-24 h-64 w-64 rounded-full bg-[var(--color-primary)] opacity-20 blur-3xl"
        animate={{ y: [0, 24, 0], scale: [1, 1.08, 1] }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute right-10 top-40 h-56 w-56 rounded-full bg-[var(--color-success)] opacity-10 blur-3xl"
        animate={{ y: [0, -20, 0], scale: [1.05, 1, 1.05] }}
        transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute inset-0 bg-[linear-gradient(var(--color-canvas-grid)_1px,transparent_1px),linear-gradient(90deg,var(--color-canvas-grid)_1px,transparent_1px)] bg-[size:48px_48px] opacity-25 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
    </div>
  );
}

export function BuilderList() {
  const router = useRouter();
  const { headers } = useDemoActor();
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await apiFetch<WorkflowSummary[]>('/workflows', { headers });
        if (!alive) return;
        setWorkflows([...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      } catch (error) {
        if (!alive) return;
        setLoadError(
          error instanceof ApiFailure ? error.message : 'Studio API is unreachable — showing the demo templates offline.',
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [headers]);

  const create = async (entry: TemplateEntry) => {
    setCreating(entry.key);
    setCreateError(null);
    const built = entry.build();
    try {
      const result = await apiFetch<WorkflowMutationResult>('/workflows', {
        method: 'POST',
        headers,
        body: {
          name: built.definition.name,
          description: built.definition.description,
          enabled: built.definition.enabled,
          definition: built.definition,
          layout: built.layout,
        },
      });
      router.push(`/builder/${result.workflowId}`);
    } catch (error) {
      setCreating(null);
      setCreateError(
        error instanceof ApiFailure
          ? `${error.message} (${error.status})`
          : 'Could not reach the studio API. You can still open a template offline below.',
      );
    }
  };

  const copyExisting = async (source: WorkflowSummary) => {
    setCreating(source.workflowId);
    setCreateError(null);
    try {
      const result = await apiFetch<WorkflowMutationResult>('/workflows', {
        method: 'POST',
        headers,
        body: { name: `${source.name} copy`, fromWorkflowId: source.workflowId },
      });
      router.push(`/builder/${result.workflowId}`);
    } catch (error) {
      setCreating(null);
      setCreateError(
        error instanceof ApiFailure
          ? `${error.message} (${error.status})`
          : 'Could not reach the studio API to copy that workflow.',
      );
    }
  };

  return (
    <div className="relative min-h-full">
      <GridBackdrop />
      <div className="relative mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-primary)]">
            Automation Studio
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
            Compose workflows over workforce events
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
            Drag nodes onto the canvas, wire their ports, and let the validator prove that every
            action is guarded by policy and — for anything that moves pay — by a human decision
            before you publish.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--color-ink)]">Start a workflow</h2>
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm">New workflow</Button>
              </DialogTrigger>
              <DialogContent className="border-[var(--color-border-subtle)] bg-[var(--color-surface)] sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Choose a starting point</DialogTitle>
                  <DialogDescription>
                    Start blank, from a template, or from a copy of a workflow you already have.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto">
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
                      Blank
                    </p>
                    <Button
                      variant="outline"
                      className="h-auto flex-col items-start gap-1 px-3 py-3 text-left"
                      disabled={creating !== null}
                      onClick={() => void create(blankEntry)}
                    >
                      <span className="text-sm font-medium">{blankEntry.title}</span>
                      <span className="text-[11px] font-normal leading-snug text-[var(--color-ink-faint)]">
                        {blankEntry.description}
                      </span>
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
                      Templates
                    </p>
                    {templateEntries.map((entry) => (
                      <Button
                        key={entry.key}
                        variant="outline"
                        className="h-auto flex-col items-start gap-1 px-3 py-3 text-left"
                        disabled={creating !== null}
                        onClick={() => void create(entry)}
                      >
                        <span className="text-sm font-medium">{entry.title}</span>
                        <span className="text-[11px] font-normal leading-snug text-[var(--color-ink-faint)]">
                          {entry.description}
                        </span>
                      </Button>
                    ))}
                  </div>
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
                      Copy an existing workflow
                    </p>
                    {workflows === null && (
                      <p className="text-[11px] text-[var(--color-ink-faint)]">Loading your workflows…</p>
                    )}
                    {workflows !== null && workflows.length === 0 && (
                      <p className="text-[11px] text-[var(--color-ink-faint)]">
                        No saved workflows to copy yet — start from a template.
                      </p>
                    )}
                    {workflows?.map((workflow) => (
                      <Button
                        key={workflow.workflowId}
                        variant="outline"
                        className="h-auto flex-col items-start gap-1 px-3 py-3 text-left"
                        disabled={creating !== null}
                        onClick={() => void copyExisting(workflow)}
                      >
                        <span className="text-sm font-medium">{workflow.name}</span>
                        <span className="text-[11px] font-normal leading-snug text-[var(--color-ink-faint)]">
                          draft v{workflow.draftVersionNumber}
                          {workflow.publishedVersionNumber !== null
                            ? ` · published v${workflow.publishedVersionNumber}`
                            : ''}
                          {' · '}
                          {isoTime(workflow.updatedAt)}
                        </span>
                      </Button>
                    ))}
                  </div>
                  {createError !== null && <p className="text-[11px] text-[var(--color-danger)]">{createError}</p>}
                </div>
              </DialogContent>
            </Dialog>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {startEntries.map((entry, index) => {
              const built = entry.build();
              return (
                <motion.article
                  key={entry.key}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/80 p-4 backdrop-blur"
                >
                  <h3 className="text-sm font-medium text-[var(--color-ink)]">{built.definition.name}</h3>
                  <p className="flex-1 text-[11px] leading-snug text-[var(--color-ink-faint)]">
                    {built.definition.description}
                  </p>
                  <p className="font-mono text-[10px] text-[var(--color-ink-faint)]">
                    {templateSummary(built.definition)}
                  </p>
                </motion.article>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">Your workflows</h2>
          {loadError !== null && (
            <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/80 p-4">
              <p className="text-xs text-[var(--color-warning)]">{loadError}</p>
              <p className="text-[11px] text-[var(--color-ink-faint)]">
                The canvas still works against the built-in templates offline:
              </p>
              <div className="flex gap-2">
                <Link href="/builder/coverage-rescue">
                  <Button variant="outline" size="sm">
                    Open coverage rescue offline
                  </Button>
                </Link>
                <Link href="/builder/payroll-exception">
                  <Button variant="outline" size="sm">
                    Open payroll exception offline
                  </Button>
                </Link>
              </div>
            </div>
          )}
          {workflows === null && loadError === null && (
            <p className="text-xs text-[var(--color-ink-faint)]">Loading…</p>
          )}
          {workflows !== null && workflows.length === 0 && (
            <p className="text-xs text-[var(--color-ink-faint)]">No workflows yet — create one above.</p>
          )}
          {workflows !== null && workflows.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2">
              {workflows.map((workflow, index) => (
                <motion.li
                  key={workflow.workflowId}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index * 0.04, 0.3) }}
                  className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/80 p-4 backdrop-blur"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-medium text-[var(--color-ink)]">{workflow.name}</h3>
                    <Badge
                      className={
                        workflow.enabled
                          ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
                          : 'bg-[var(--color-surface-raised)] text-[var(--color-ink-faint)]'
                      }
                    >
                      {workflow.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </div>
                  <p className="flex-1 text-[11px] leading-snug text-[var(--color-ink-faint)]">
                    {workflow.description}
                  </p>
                  <p className="font-mono text-[10px] text-[var(--color-ink-faint)]">
                    draft v{workflow.draftVersionNumber}
                    {workflow.publishedVersionNumber !== null
                      ? ` · published v${workflow.publishedVersionNumber}`
                      : ''}
                    {' · '}
                    {isoTime(workflow.updatedAt)}
                  </p>
                  <Link href={`/builder/${workflow.workflowId}`} className="self-start">
                    <Button size="sm" variant="outline">
                      Open canvas →
                    </Button>
                  </Link>
                </motion.li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
