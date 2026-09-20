'use client';

import { Trash } from '@phosphor-icons/react';
import { fieldsOf, toolById, type WorkflowDefinition, type WorkflowNode } from '@wfm/workflows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { OptionSources } from './control-options';
import { FieldRenderer, FieldShell } from './field-renderer';
import { nodeIconByType } from './node-icons';
import { accentVarByNodeType, nodeTypeLabel, withConfigKey } from './state';

export interface InspectorProps {
  node: WorkflowNode | null;
  definition: WorkflowDefinition;
  sources: OptionSources;
  onChange: (node: WorkflowNode, coalesceKey?: string) => void;
  onMetaChange: (patch: { name?: string; description?: string; enabled?: boolean }) => void;
  onDeleteNode: (nodeId: string) => void;
}

export function Inspector({ node, definition, sources, onChange, onMetaChange, onDeleteNode }: InspectorProps) {
  if (!node) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-3 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">Workflow</p>
        <FieldShell label="Description">
          <Textarea
            value={definition.description}
            rows={3}
            className="text-xs"
            onChange={(event) => onMetaChange({ description: event.target.value })}
          />
        </FieldShell>
        <div className="flex items-center justify-between">
          <Label className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">Enabled</Label>
          <Switch checked={definition.enabled} onCheckedChange={(enabled) => onMetaChange({ enabled })} />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          Select a node to configure it. The engine runs the compiled graph from the trigger; every
          path to an action must pass a policy check, and anything that moves pay must pass a human
          approval first.
        </p>
      </div>
    );
  }

  const config: Record<string, unknown> = node.config;
  const accent = accentVarByNodeType[node.type];
  const Icon = nodeIconByType[node.type];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--color-border-subtle)] px-4 py-3">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{
            backgroundColor: `color-mix(in oklab, ${accent} 22%, transparent)`,
            color: accent,
          }}
        >
          <Icon className="size-4" weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            {nodeTypeLabel(node.type)}
          </p>
          <p className="truncate text-xs font-medium text-[var(--color-ink)]">{node.label}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Delete node"
          title="Delete node"
          className="text-[var(--color-danger)]"
          onClick={() => onDeleteNode(node.id)}
        >
          <Trash className="size-3.5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <FieldShell label="Label">
          <Input
            value={node.label}
            maxLength={80}
            className="h-8 text-xs"
            onChange={(event) => onChange({ ...node, label: event.target.value }, `${node.id}:label`)}
          />
        </FieldShell>
        <p className="truncate font-mono text-[10px] text-[var(--color-ink-faint)]">id: {node.id}</p>
        {fieldsOf(node.type).map((spec) => (
          <FieldRenderer
            key={spec.key}
            spec={spec}
            config={config}
            fieldId={`${node.id}:${spec.key}`}
            sources={sources}
            onChange={(key, value, coalesceKey) =>
              onChange(withConfigKey(node, key, value), `${node.id}:${coalesceKey}`)
            }
          />
        ))}
        {node.type === 'action' && (
          <p className="text-[10px] leading-snug text-[var(--color-ink-faint)]">
            Downstream inputs can read this output with {'{{nodes.'}
            {node.id}
            {'.output.<path>}}'}.
          </p>
        )}
        {node.type === 'ai_decision' && (
          <p className="text-[10px] leading-snug text-[var(--color-ink-faint)]">
            Tools selected: {node.config.tools.map((toolId) => toolById(toolId)?.label ?? toolId).join(', ') || 'none'}
          </p>
        )}
      </div>
    </div>
  );
}
