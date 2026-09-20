'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  fieldsOf,
  portLabels,
  type EdgePort,
  type FieldSpec,
  type WorkflowNode,
  type WorkflowNodeType,
} from '@wfm/workflows';
import { cn } from '@/lib/utils';
import type { OptionSources } from './control-options';
import { CompactFieldProvider, FieldRenderer } from './field-renderer';
import { nodeIconByType } from './node-icons';
import {
  accentVarByNodeType,
  legalPortsFor,
  nodeDescription,
  withConfigKey,
  type BuilderFlowNode,
} from './state';

/**
 * A card edits the graph, but a React Flow node's data is frozen to
 * `{ node, diagnostics }`, and handing every card its own callback would
 * rebuild all of them whenever one field changes. The canvas supplies the store
 * and the option sources once, here, and each card reads them.
 */
interface BuilderNodeEditing {
  sources: OptionSources;
  onChange: (node: WorkflowNode, coalesceKey?: string) => void;
}

const BuilderNodeContext = createContext<BuilderNodeEditing | null>(null);

export function BuilderNodeProvider({ sources, onChange, children }: BuilderNodeEditing & { children: ReactNode }) {
  const value = useMemo<BuilderNodeEditing>(() => ({ sources, onChange }), [sources, onChange]);
  return <BuilderNodeContext.Provider value={value}>{children}</BuilderNodeContext.Provider>;
}

function useBuilderNodeEditing(): BuilderNodeEditing {
  const editing = useContext(BuilderNodeContext);
  if (editing === null) throw new Error('BuilderNode must be rendered inside BuilderNodeProvider');
  return editing;
}

/**
 * The two fields a card shows, per kind, in card order. These are the values an
 * author reads off the graph without opening the inspector; a key the kind does
 * not declare, or one its own config hides, is skipped rather than faked. A kind
 * whose fields are all better edited in the inspector (or has none) shows none.
 */
const cardFieldKeys: Record<WorkflowNodeType, readonly string[]> = {
  trigger: ['eventType'],
  condition: ['conditions'],
  ai_decision: ['model'],
  policy_check: ['checks'],
  human_approval: ['role'],
  action: ['command'],
  artifact: ['format', 'body'],
  end: ['outcome'],
};

const CARD_FIELD_LIMIT = 2;

function cardFields(node: WorkflowNode, config: Record<string, unknown>): FieldSpec[] {
  const declared = fieldsOf(node.type);
  const chosen: FieldSpec[] = [];
  for (const key of cardFieldKeys[node.type]) {
    const spec = declared.find((candidate) => candidate.key === key);
    if (spec === undefined) continue;
    if (spec.visible !== undefined && !spec.visible(config)) continue;
    chosen.push(spec);
    if (chosen.length === CARD_FIELD_LIMIT) break;
  }
  return chosen;
}

/** A port dot sitting on the card edge: sized here, coloured by the caller. */
const handleShape = { width: 10, height: 10, border: '2px solid var(--color-surface-raised)' };

function DiagnosticBadge({ count, tone }: { count: number; tone: 'danger' | 'warning' }) {
  return (
    <span
      className={cn(
        'flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 text-[10px] font-semibold text-[var(--color-canvas)]',
        tone === 'danger' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-warning)]',
      )}
    >
      {count}
    </span>
  );
}

export function BuilderNode({ data, selected }: NodeProps<BuilderFlowNode>) {
  const { node, diagnostics } = data;
  const editing = useBuilderNodeEditing();
  const accent = accentVarByNodeType[node.type];
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  const ports = legalPortsFor(node.type);
  const config: Record<string, unknown> = node.config;
  const fields = cardFields(node, config);
  const Icon = nodeIconByType[node.type];
  const hasInput = node.type !== 'trigger';

  return (
    <div
      className={cn(
        'relative w-[300px] rounded-[var(--radius-card)] border bg-[var(--color-surface-raised)] shadow-lg transition-shadow',
        errors.length > 0 ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-subtle)]',
        selected && 'ring-2 ring-[var(--color-primary)]',
      )}
    >
      {hasInput && (
        <div className="relative flex h-7 items-center px-3.5">
          <Handle
            type="target"
            position={Position.Left}
            id="in"
            style={{ ...handleShape, backgroundColor: 'var(--color-ink-faint)' }}
          />
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-ink-faint)]">
            Input
          </span>
        </div>
      )}

      <div className={cn('flex items-start gap-2.5 px-3.5', hasInput ? 'pt-1' : 'pt-3')}>
        <span
          className="flex size-[22px] shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: `color-mix(in oklab, ${accent} 18%, transparent)`, color: accent }}
        >
          <Icon size={13} weight="bold" />
        </span>
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[22px] text-[var(--color-ink)]">
          {node.label}
        </p>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {errors.length > 0 && <DiagnosticBadge count={errors.length} tone="danger" />}
          {warnings.length > 0 && <DiagnosticBadge count={warnings.length} tone="warning" />}
        </div>
      </div>

      <p className="line-clamp-2 px-3.5 pt-1 text-[11px] leading-snug text-[var(--color-ink-faint)]">
        {nodeDescription(node.type)}
      </p>

      {fields.length > 0 && (
        <CompactFieldProvider>
          <div className="nodrag flex flex-col gap-2.5 px-3.5 pt-3">
            {fields.map((spec) => (
              <FieldRenderer
                key={spec.key}
                spec={spec}
                config={config}
                fieldId={`card:${node.id}:${spec.key}`}
                sources={editing.sources}
                onChange={(key, value, coalesceKey) =>
                  editing.onChange(withConfigKey(node, key, value), `${node.id}:${coalesceKey}`)
                }
              />
            ))}
          </div>
        </CompactFieldProvider>
      )}

      <p className="px-3.5 pt-3 font-mono text-[10px] leading-none text-[var(--color-ink-faint)]">id: {node.id}</p>

      {ports.length > 0 && (
        <div className="flex flex-col pb-1.5 pt-2">
          {ports.map((port: EdgePort) => (
            <div key={port} className="relative flex h-7 items-center justify-end px-3.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-ink-faint)]">
                {portLabels[port]}
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={port}
                style={{ ...handleShape, backgroundColor: accent }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
