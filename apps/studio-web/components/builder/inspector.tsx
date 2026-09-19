'use client';

import type { ReactNode } from 'react';
import type { Condition } from '@wfm/contracts';
import {
  aiOutputLabels,
  approvalDisplaySchema,
  commandById,
  commandCatalog,
  policyCheckKindSchema,
  policyCheckLabels,
  toolById,
  toolCatalog,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@wfm/workflows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { accentVarByNodeType } from './state';

export interface TriggerEventOption {
  eventType: string;
  owner: string;
}

export interface InspectorProps {
  node: WorkflowNode | null;
  definition: WorkflowDefinition;
  triggerEvents: readonly TriggerEventOption[];
  onChange: (node: WorkflowNode, coalesceKey?: string) => void;
  onMetaChange: (patch: { name?: string; description?: string; enabled?: boolean }) => void;
  onDeleteNode: (nodeId: string) => void;
}

const conditionOps: ReadonlyArray<{ value: Condition['op']; label: string }> = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'at least' },
  { value: 'in', label: 'is one of (comma list)' },
  { value: 'contains', label: 'contains' },
  { value: 'exists', label: 'exists' },
];

const outcomeLabels = {
  completed: 'Run completed',
  stopped: 'Stopped by decision',
  needs_attention: 'Needs attention',
} as const;

const approvalDisplayLabels: Record<(typeof approvalDisplaySchema.options)[number], string> = {
  rationale: 'Rationale',
  evidence: 'Evidence',
  payImpact: 'Pay impact',
  candidateComparison: 'Candidate comparison',
};

function parseConditionValue(raw: string, op: Condition['op']): Condition['value'] {
  const trimmed = raw.trim();
  if (op === 'exists') return undefined;
  if (op === 'in') {
    return trimmed.length === 0
      ? []
      : trimmed.split(',').map((part) => {
          const clean = part.trim();
          return /^-?\d+(\.\d+)?$/.test(clean) ? Number(clean) : clean;
        });
  }
  if (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') {
    const parsed = Number(trimmed);
    return trimmed.length > 0 && Number.isFinite(parsed) ? parsed : undefined;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const parsed = Number(trimmed);
  return trimmed.length > 0 && Number.isFinite(parsed) ? parsed : trimmed;
}

function conditionValueToInput(value: Condition['value']): string {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.map((entry) => String(entry)).join(', ') : String(value);
}

function FieldShell({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</Label>
      {children}
      {hint !== undefined && <p className="text-[10px] leading-snug text-[var(--color-ink-faint)]">{hint}</p>}
    </div>
  );
}

function CheckRow({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-3.5 w-3.5 accent-[var(--color-primary)]"
      />
      <span className="min-w-0">{label}</span>
    </label>
  );
}

function ConditionEditor({
  conditions,
  onChange,
}: {
  conditions: Condition[];
  onChange: (conditions: Condition[], coalesceKey: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {conditions.map((condition, index) => {
        const rowKey = `${index}`;
        return (
          <div
            key={rowKey}
            className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2"
          >
            <div className="flex items-center gap-1.5">
              <Input
                value={condition.field}
                placeholder="payload.hoursUntilStart"
                className="h-7 flex-1 font-mono text-xs"
                onChange={(event) =>
                  onChange(
                    conditions.map((candidate, i) =>
                      i === index ? { ...candidate, field: event.target.value } : candidate,
                    ),
                    `cond:${rowKey}:field`,
                  )
                }
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Remove condition"
                onClick={() => onChange(conditions.filter((_, i) => i !== index), `cond:${rowKey}:remove`)}
              >
                ✕
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              <Select
                value={condition.op}
                onValueChange={(rawOp) => {
                  const nextOp = conditionOps.find((option) => option.value === rawOp)?.value;
                  if (!nextOp) return;
                  onChange(
                    conditions.map((candidate, i) => {
                      if (i !== index) return candidate;
                      const value = parseConditionValue(conditionValueToInput(candidate.value), nextOp);
                      return { ...candidate, op: nextOp, ...(value === undefined ? {} : { value }) };
                    }),
                    `cond:${rowKey}:op`,
                  );
                }}
              >
                <SelectTrigger size="sm" className="w-40 shrink-0 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {conditionOps.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="text-xs">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {condition.op !== 'exists' && (
                <Input
                  value={conditionValueToInput(condition.value)}
                  placeholder="value"
                  className="h-7 min-w-0 flex-1 text-xs"
                  onChange={(event) => {
                    const value = parseConditionValue(event.target.value, condition.op);
                    onChange(
                      conditions.map((candidate, i) =>
                        i === index
                          ? { ...candidate, ...(value === undefined ? {} : { value }) }
                          : candidate,
                      ),
                      `cond:${rowKey}:value`,
                    );
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...conditions, { field: 'payload.value', op: 'eq', value: '' }], 'cond:add')}
      >
        + Add condition
      </Button>
    </div>
  );
}

export function Inspector({
  node,
  definition,
  triggerEvents,
  onChange,
  onMetaChange,
  onDeleteNode,
}: InspectorProps) {
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

  const commit = (next: WorkflowNode, coalesceKey?: string) => onChange(next, coalesceKey);
  const accent = accentVarByNodeType[node.type];

  const body = (() => {
    switch (node.type) {
      case 'trigger':
        return (
          <>
            <FieldShell label="Event type" hint="Fires when this event reaches the backbone for your tenant.">
              <Select
                value={node.config.eventType}
                onValueChange={(eventType) =>
                  commit({ ...node, config: { ...node.config, eventType } }, `${node.id}:eventType`)
                }
              >
                <SelectTrigger size="sm" className="w-full font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {triggerEvents.map((option) => (
                    <SelectItem key={option.eventType} value={option.eventType} className="font-mono text-xs">
                      {option.eventType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldShell>
            <FieldShell label="Conditions" hint="All conditions must match for the workflow to start.">
              <ConditionEditor
                conditions={node.config.conditions}
                onChange={(conditions, key) =>
                  commit({ ...node, config: { ...node.config, conditions } }, `${node.id}:${key}`)
                }
              />
            </FieldShell>
          </>
        );
      case 'condition':
        return (
          <>
            <FieldShell label="Description">
              <Input
                value={node.config.description}
                maxLength={200}
                className="h-8 text-xs"
                onChange={(event) =>
                  commit(
                    { ...node, config: { ...node.config, description: event.target.value } },
                    `${node.id}:description`,
                  )
                }
              />
            </FieldShell>
            <FieldShell label="Conditions" hint="All must match to take the yes branch.">
              <ConditionEditor
                conditions={node.config.conditions}
                onChange={(conditions, key) =>
                  commit({ ...node, config: { ...node.config, conditions } }, `${node.id}:${key}`)
                }
              />
            </FieldShell>
          </>
        );
      case 'ai_decision':
        return (
          <>
            <FieldShell label="Goal" hint="What the model should decide. It must justify the output with evidence.">
              <Textarea
                rows={5}
                value={node.config.goal}
                className="text-xs"
                onChange={(event) =>
                  commit({ ...node, config: { ...node.config, goal: event.target.value } }, `${node.id}:goal`)
                }
              />
            </FieldShell>
            <FieldShell label="Read-only tools" hint="Context the AI may fetch before proposing.">
              <div className="flex flex-col">
                {toolCatalog.map((tool) => {
                  const checked = node.config.tools.includes(tool.id);
                  return (
                    <CheckRow
                      key={tool.id}
                      checked={checked}
                      label={`${tool.label} — ${tool.description}`}
                      onToggle={() => {
                        const tools = checked
                          ? node.config.tools.filter((candidate) => candidate !== tool.id)
                          : [...node.config.tools, tool.id];
                        commit({ ...node, config: { ...node.config, tools } }, `${node.id}:tools`);
                      }}
                    />
                  );
                })}
              </div>
            </FieldShell>
            <FieldShell label="Output shape">
              <Select
                value={node.config.output}
                onValueChange={(raw) => {
                  if (raw === 'candidate_choice' || raw === 'timesheet_adjustment' || raw === 'coverage_plan') {
                    commit({ ...node, config: { ...node.config, output: raw } }, `${node.id}:output`);
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(aiOutputLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value} className="text-xs">
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldShell>
            <div className="flex items-center justify-between">
              <Label className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                Must cite evidence
              </Label>
              <Switch
                checked={node.config.mustCiteEvidence}
                onCheckedChange={(mustCiteEvidence) =>
                  commit({ ...node, config: { ...node.config, mustCiteEvidence } }, `${node.id}:cite`)
                }
              />
            </div>
          </>
        );
      case 'policy_check':
        return (
          <>
            <FieldShell label="Checks" hint="Deterministic guardrails evaluated before anything else.">
              <div className="flex flex-col">
                {policyCheckKindSchema.options.map((kind) => {
                  const checked = node.config.checks.includes(kind);
                  return (
                    <CheckRow
                      key={kind}
                      checked={checked}
                      label={policyCheckLabels[kind]}
                      onToggle={() => {
                        const checks = checked
                          ? node.config.checks.filter((candidate) => candidate !== kind)
                          : [...node.config.checks, kind];
                        commit({ ...node, config: { ...node.config, checks } }, `${node.id}:checks`);
                      }}
                    />
                  );
                })}
              </div>
            </FieldShell>
            <FieldShell label="Cost cap (cents)" hint="Cost deltas above this cap fail the check.">
              <Input
                type="number"
                min={0}
                value={node.config.costCapCents}
                className="h-8 text-xs"
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  const capped = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
                  commit({ ...node, config: { ...node.config, costCapCents: capped } }, `${node.id}:cap`);
                }}
              />
            </FieldShell>
            <div className="flex items-center justify-between">
              <Label className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                Escalate on failure
              </Label>
              <Switch
                checked={node.config.escalateOnFailure}
                onCheckedChange={(escalateOnFailure) =>
                  commit({ ...node, config: { ...node.config, escalateOnFailure } }, `${node.id}:escalate`)
                }
              />
            </div>
          </>
        );
      case 'human_approval':
        return (
          <>
            <FieldShell label="Deciding role">
              <Input
                value={node.config.role}
                maxLength={60}
                className="h-8 font-mono text-xs"
                onChange={(event) =>
                  commit({ ...node, config: { ...node.config, role: event.target.value } }, `${node.id}:role`)
                }
              />
            </FieldShell>
            <FieldShell label="Timeout (minutes)" hint="After the timeout the run escalates — it never auto-approves pay.">
              <Input
                type="number"
                min={1}
                max={10_080}
                value={node.config.timeoutMinutes}
                className="h-8 text-xs"
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (!Number.isFinite(parsed)) return;
                  const clamped = Math.min(10_080, Math.max(1, Math.floor(parsed)));
                  commit({ ...node, config: { ...node.config, timeoutMinutes: clamped } }, `${node.id}:timeout`);
                }}
              />
            </FieldShell>
            <FieldShell label="Escalate to">
              <Input
                value={node.config.escalateTo}
                maxLength={60}
                className="h-8 font-mono text-xs"
                onChange={(event) =>
                  commit(
                    { ...node, config: { ...node.config, escalateTo: event.target.value } },
                    `${node.id}:escalateTo`,
                  )
                }
              />
            </FieldShell>
            <FieldShell label="Show the approver">
              <div className="flex flex-col">
                {approvalDisplaySchema.options.map((display) => {
                  const checked = node.config.show.includes(display);
                  return (
                    <CheckRow
                      key={display}
                      checked={checked}
                      label={approvalDisplayLabels[display]}
                      onToggle={() => {
                        const show = checked
                          ? node.config.show.filter((candidate) => candidate !== display)
                          : [...node.config.show, display];
                        commit({ ...node, config: { ...node.config, show } }, `${node.id}:show`);
                      }}
                    />
                  );
                })}
              </div>
            </FieldShell>
          </>
        );
      case 'action': {
        const command = commandById(node.config.command) ?? commandCatalog[0]!;
        return (
          <>
            <FieldShell label="Command" hint={`${command.service} · ${command.method} ${command.pathTemplate}`}>
              <Select
                value={command.id}
                onValueChange={(next) =>
                  commit({ ...node, config: { command: next, input: {} } }, `${node.id}:command`)
                }
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {commandCatalog.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id} className="text-xs">
                      {candidate.label}
                      {candidate.payAffecting ? ' · pay-affecting' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldShell>
            {command.payAffecting && (
              <p className="rounded-md bg-[var(--color-warning-soft)] px-2 py-1.5 text-[10px] leading-snug text-[var(--color-warning)]">
                This command moves pay. Validation requires a human approval on every path that reaches it.
              </p>
            )}
            <FieldShell
              label="Inputs"
              hint="Values may use templates: {{input.payload.shiftId}}, {{nodes.<id>.output.<path>}}, {{now+4h}}."
            >
              <div className="flex flex-col gap-2">
                {command.inputs.map((input) => (
                  <div key={input.field} className="flex flex-col gap-1">
                    <Label className="font-mono text-[11px] text-[var(--color-ink-muted)]">
                      {input.field}
                      {input.required ? <span className="text-[var(--color-danger)]">*</span> : null}
                    </Label>
                    <Input
                      value={node.config.input[input.field] ?? ''}
                      placeholder={input.description}
                      className="h-8 font-mono text-xs"
                      onChange={(event) => {
                        const value = event.target.value;
                        const nextInput =
                          value.length === 0
                            ? Object.fromEntries(
                                Object.entries(node.config.input).filter(([field]) => field !== input.field),
                              )
                            : { ...node.config.input, [input.field]: value };
                        commit(
                          { ...node, config: { ...node.config, input: nextInput } },
                          `${node.id}:in:${input.field}`,
                        );
                      }}
                    />
                    <p className="text-[10px] text-[var(--color-ink-faint)]">{input.description}</p>
                  </div>
                ))}
              </div>
            </FieldShell>
          </>
        );
      }
      case 'end':
        return (
          <FieldShell label="Outcome">
            <Select
              value={node.config.outcome}
              onValueChange={(raw) => {
                if (raw === 'completed' || raw === 'stopped' || raw === 'needs_attention') {
                  commit({ ...node, config: { ...node.config, outcome: raw } }, `${node.id}:outcome`);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(outcomeLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value} className="text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldShell>
        );
    }
  })();

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
          onChange={(event) => commit({ ...node, label: event.target.value }, `${node.id}:label`)}
        />
      </FieldShell>
      <p className="font-mono text-[10px] text-[var(--color-ink-faint)]">id: {node.id}</p>
      {body}
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
