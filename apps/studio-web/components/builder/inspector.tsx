'use client';

import { fieldsOf, toolById, type WorkflowDefinition, type WorkflowNode } from '@wfm/workflows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { OptionSources } from './control-options';
import { FieldRenderer, FieldShell } from './field-renderer';
import { accentVarByNodeType, withConfigKey } from './state';

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
      <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
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
        <p className="mt-4 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          Select a node to configure it. The engine runs the compiled graph from the trigger; every
          path to an action must pass a policy check, and anything that moves pay must pass a human
          approval first.
        </p>
      </aside>
    );
  }

  const config: Record<string, unknown> = node.config;
  const accent = accentVarByNodeType[node.type];

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accent }} />
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            {node.type.replace(/_/g, ' ')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="text-[var(--color-danger)]"
          onClick={() => onDeleteNode(node.id)}
        >
          Delete node
        </Button>
      </div>
      <FieldShell label="Label">
        <Input
          value={node.label}
          maxLength={80}
          className="h-8 text-xs"
          onChange={(event) => onChange({ ...node, label: event.target.value }, `${node.id}:label`)}
        />
      </FieldShell>
      <p className="font-mono text-[10px] text-[var(--color-ink-faint)]">id: {node.id}</p>
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
    </aside>
  );
}
