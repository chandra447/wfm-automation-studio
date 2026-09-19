'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { portLabels } from '@wfm/workflows';
import type { EdgePort } from '@wfm/workflows';
import { cn } from '@/lib/utils';
import { accentVarByNodeType, legalPortsFor, nodeSummary, type BuilderFlowNode } from './state';

const typeLabels: Record<BuilderFlowNode['data']['node']['type'], string> = {
  trigger: 'Trigger',
  condition: 'Condition',
  ai_decision: 'AI decision',
  policy_check: 'Policy check',
  human_approval: 'Human approval',
  action: 'Action',
  end: 'End',
};

export function BuilderNode({ data, selected }: NodeProps<BuilderFlowNode>) {
  const { node, diagnostics } = data;
  const accent = accentVarByNodeType[node.type];
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  const ports = legalPortsFor(node.type);

  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border bg-[var(--color-surface-raised)] shadow-lg transition-shadow',
        'w-[220px] min-h-[88px] px-3 py-2.5',
        errors.length > 0 ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-subtle)]',
        selected && 'ring-2 ring-[var(--color-primary)]',
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 rounded-l-[var(--radius-card)]"
        style={{ backgroundColor: accent }}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs uppercase tracking-wide" style={{ color: accent }}>
            {typeLabels[node.type]}
          </p>
          <p className="truncate text-sm font-medium text-[var(--color-ink)]">{node.label}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {errors.length > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] font-semibold text-[var(--color-canvas)]">
              {errors.length}
            </span>
          )}
          {warnings.length > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-warning)] px-1 text-[10px] font-semibold text-[var(--color-canvas)]">
              {warnings.length}
            </span>
          )}
        </div>
      </div>
      <p className="mt-1 truncate font-mono text-[11px] text-[var(--color-ink-faint)]">{nodeSummary(node)}</p>

      {node.type !== 'trigger' && (
        <Handle type="target" position={Position.Left} id="in" style={{ top: '50%', left: -4 }} />
      )}
      {ports.map((port: EdgePort, index) => {
        const top = `${((index + 1) / (ports.length + 1)) * 100}%`;
        return (
          <span key={port}>
            <Handle
              type="source"
              position={Position.Right}
              id={port}
              style={{ top, right: -4, backgroundColor: accent }}
            />
            {ports.length > 1 && (
              <span
                className="pointer-events-none absolute text-[9px] uppercase tracking-wide text-[var(--color-ink-faint)]"
                style={{ top: `calc(${top} - 6px)`, right: 6 }}
              >
                {portLabels[port]}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
