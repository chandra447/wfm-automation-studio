'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from 'react';
import { conditionSchema, type Condition } from '@wfm/contracts';
import type { Control, FieldSpec } from '@wfm/workflows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { UNSET_OPTION_VALUE, optionsFor, type ControlOption, type OptionSources } from './control-options';

type TemplateFieldElement = HTMLInputElement | HTMLTextAreaElement;

interface ActiveTemplateField {
  fieldId: string;
  label: string;
}

interface TemplateFieldRegistry {
  register: (fieldId: string, element: TemplateFieldElement | null) => void;
  activate: (fieldId: string, label: string) => void;
  insert: (text: string) => boolean;
  active: ActiveTemplateField | null;
}

const TemplateFieldContext = createContext<TemplateFieldRegistry | null>(null);

function targetOf(
  elements: Map<string, TemplateFieldElement>,
  active: ActiveTemplateField | null,
): TemplateFieldElement | undefined {
  const activated = active === null ? undefined : elements.get(active.fieldId);
  if (activated !== undefined) return activated;
  if (elements.size !== 1) return undefined;
  return elements.values().next().value;
}

/**
 * Holds the template fields currently on screen so the data palette can insert
 * a reference at the caret of the one the author last touched. A click in the
 * palette moves focus off the field, so the target is remembered rather than
 * read from document.activeElement.
 */
export function TemplateFieldProvider({ children }: { children: ReactNode }) {
  const elements = useRef(new Map<string, TemplateFieldElement>());
  const activated = useRef<ActiveTemplateField | null>(null);
  const [active, setActive] = useState<ActiveTemplateField | null>(null);

  const register = useCallback((fieldId: string, element: TemplateFieldElement | null) => {
    if (element === null) elements.current.delete(fieldId);
    else elements.current.set(fieldId, element);
  }, []);

  const activate = useCallback((fieldId: string, label: string) => {
    activated.current = { fieldId, label };
    setActive({ fieldId, label });
  }, []);

  const insert = useCallback((text: string) => {
    const target = targetOf(elements.current, activated.current);
    if (target === undefined) return false;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, 'end');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    return true;
  }, []);

  const value = useMemo<TemplateFieldRegistry>(
    () => ({ register, activate, insert, active }),
    [register, activate, insert, active],
  );

  return <TemplateFieldContext.Provider value={value}>{children}</TemplateFieldContext.Provider>;
}

export function useTemplateFields(): TemplateFieldRegistry {
  const registry = useContext(TemplateFieldContext);
  if (!registry) throw new Error('useTemplateFields must be used inside TemplateFieldProvider');
  return registry;
}

/** Binds one field to the palette: registers its element and marks it active on focus. */
function useTemplateField<E extends TemplateFieldElement>(fieldId: string, label: string, enabled: boolean) {
  const registry = useTemplateFields();
  const ref: RefCallback<E> = useCallback(
    (element) => registry.register(fieldId, enabled ? element : null),
    [registry, fieldId, enabled],
  );
  const onFocus = useCallback(() => {
    if (enabled) registry.activate(fieldId, label);
  }, [registry, fieldId, label, enabled]);
  return { ref, onFocus };
}

export interface FieldRendererProps {
  spec: FieldSpec;
  config: Record<string, unknown>;
  fieldId: string;
  sources: OptionSources;
  onChange: (key: string, value: unknown, coalesceKey: string) => void;
}

interface ControlProps<C extends Control> {
  spec: FieldSpec;
  control: C;
  config: Record<string, unknown>;
  fieldId: string;
  sources: OptionSources;
  onChange: FieldRendererProps['onChange'];
}

export function FieldRenderer({ spec, config, fieldId, sources, onChange }: FieldRendererProps) {
  if (spec.visible !== undefined && !spec.visible(config)) return null;
  const control = spec.control;
  switch (control.kind) {
    case 'text':
      return <TextControl spec={spec} control={control} config={config} fieldId={fieldId} sources={sources} onChange={onChange} />;
    case 'textarea':
      return (
        <TextareaControl spec={spec} control={control} config={config} fieldId={fieldId} sources={sources} onChange={onChange} />
      );
    case 'number':
      return (
        <NumberControl spec={spec} control={control} config={config} fieldId={fieldId} sources={sources} onChange={onChange} />
      );
    case 'select':
      return (
        <SelectControl spec={spec} control={control} config={config} fieldId={fieldId} sources={sources} onChange={onChange} />
      );
    case 'switch':
      return (
        <SwitchControl spec={spec} control={control} config={config} fieldId={fieldId} sources={sources} onChange={onChange} />
      );
    case 'checklist':
      return (
        <ChecklistControl spec={spec} control={control} config={config} fieldId={fieldId} sources={sources} onChange={onChange} />
      );
    case 'conditions':
      return (
        <ConditionsControl spec={spec} control={control} config={config} fieldId={fieldId} sources={sources} onChange={onChange} />
      );
    case 'templateMap':
      return (
        <TemplateMapControl spec={spec} control={control} config={config} fieldId={fieldId} sources={sources} onChange={onChange} />
      );
  }
}

export function FieldShell({
  label,
  hint,
  template,
  children,
}: {
  label: string;
  hint?: string | undefined;
  template?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</Label>
      {children}
      {hint !== undefined && <p className="text-[10px] leading-snug text-[var(--color-ink-faint)]">{hint}</p>}
      {template === true && (
        <p className="text-[10px] leading-snug text-[var(--color-primary)]">
          Templates allowed — {'{{...}}'} reads the trigger event, run metadata, or an earlier node. Pick one from
          the data palette.
        </p>
      )}
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

function TextControl({ spec, control, config, fieldId, onChange }: ControlProps<Extract<Control, { kind: 'text' }>>) {
  const { ref, onFocus } = useTemplateField<HTMLInputElement>(fieldId, spec.label, spec.template === true);
  return (
    <FieldShell label={spec.label} hint={spec.hint} template={spec.template === true}>
      <Input
        ref={ref}
        value={stringValue(config[spec.key])}
        maxLength={control.maxLength}
        placeholder={control.placeholder}
        className="h-8 text-xs"
        onFocus={onFocus}
        onChange={(event) => onChange(spec.key, event.target.value, spec.key)}
      />
    </FieldShell>
  );
}

function TextareaControl({
  spec,
  control,
  config,
  fieldId,
  onChange,
}: ControlProps<Extract<Control, { kind: 'textarea' }>>) {
  const { ref, onFocus } = useTemplateField<HTMLTextAreaElement>(fieldId, spec.label, spec.template === true);
  return (
    <FieldShell label={spec.label} hint={spec.hint} template={spec.template === true}>
      <Textarea
        ref={ref}
        value={stringValue(config[spec.key])}
        rows={control.rows}
        maxLength={control.maxLength}
        placeholder={control.placeholder}
        className="text-xs"
        onFocus={onFocus}
        onChange={(event) => onChange(spec.key, event.target.value, spec.key)}
      />
    </FieldShell>
  );
}

function NumberControl({ spec, control, config, onChange }: ControlProps<Extract<Control, { kind: 'number' }>>) {
  const raw = config[spec.key];
  return (
    <FieldShell label={spec.label} hint={spec.hint} template={spec.template === true}>
      <Input
        type="number"
        min={control.min}
        max={control.max}
        value={typeof raw === 'number' && Number.isFinite(raw) ? raw : ''}
        className="h-8 text-xs"
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (!Number.isFinite(parsed)) return;
          const stepped = control.integer === true ? Math.floor(parsed) : parsed;
          const lower = control.min === undefined ? stepped : Math.max(control.min, stepped);
          const bounded = control.max === undefined ? lower : Math.min(control.max, lower);
          onChange(spec.key, bounded, spec.key);
        }}
      />
    </FieldShell>
  );
}

function SwitchControl({ spec, config, onChange }: ControlProps<Extract<Control, { kind: 'switch' }>>) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">{spec.label}</Label>
        <Switch
          checked={config[spec.key] === true}
          onCheckedChange={(checked) => onChange(spec.key, checked, spec.key)}
        />
      </div>
      {spec.hint !== undefined && <p className="text-[10px] leading-snug text-[var(--color-ink-faint)]">{spec.hint}</p>}
    </div>
  );
}

function SelectControl({
  spec,
  control,
  config,
  sources,
  onChange,
}: ControlProps<Extract<Control, { kind: 'select' }>>) {
  const options = controlOptions(control, sources);
  const current = stringValue(config[spec.key]);
  const listed = options.some((option) => option.value === current);
  const items: readonly ControlOption[] =
    current === '' || listed ? options : [{ value: current, label: `${current} — not in the catalogue` }, ...options];
  return (
    <FieldShell label={spec.label} hint={spec.hint} template={spec.template === true}>
      <Select
        value={current === '' ? UNSET_OPTION_VALUE : current}
        onValueChange={(next) => onChange(spec.key, next === UNSET_OPTION_VALUE ? undefined : next, spec.key)}
      >
        <SelectTrigger size="sm" className="w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}

function ChecklistControl({
  spec,
  control,
  config,
  sources,
  onChange,
}: ControlProps<Extract<Control, { kind: 'checklist' }>>) {
  const options = controlOptions(control, sources);
  const selected = stringList(config[spec.key]);
  return (
    <FieldShell label={spec.label} hint={spec.hint} template={spec.template === true}>
      <div className="flex flex-col">
        {options.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <CheckRow
              key={option.value}
              checked={checked}
              label={option.label}
              onToggle={() =>
                onChange(
                  spec.key,
                  checked ? selected.filter((value) => value !== option.value) : [...selected, option.value],
                  `${spec.key}:${option.value}`,
                )
              }
            />
          );
        })}
      </div>
    </FieldShell>
  );
}

function ConditionsControl({
  spec,
  config,
  onChange,
}: ControlProps<Extract<Control, { kind: 'conditions' }>>) {
  const parsed = conditionSchema.array().safeParse(config[spec.key]);
  const conditions: Condition[] = parsed.success ? parsed.data : [];
  return (
    <FieldShell label={spec.label} hint={spec.hint} template={spec.template === true}>
      <ConditionEditor conditions={conditions} onChange={(next, key) => onChange(spec.key, next, key)} />
    </FieldShell>
  );
}

function TemplateMapControl({
  spec,
  control,
  config,
  fieldId,
  onChange,
}: ControlProps<Extract<Control, { kind: 'templateMap' }>>) {
  const values = stringRecord(config[spec.key]);
  const rows = control.rows(stringRecord(config));
  return (
    <FieldShell label={spec.label} hint={spec.hint} template>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <TemplateMapRow
            key={row.field}
            spec={spec}
            fieldId={`${fieldId}:${row.field}`}
            row={row}
            values={values}
            onChange={onChange}
          />
        ))}
      </div>
    </FieldShell>
  );
}

function TemplateMapRow({
  spec,
  fieldId,
  row,
  values,
  onChange,
}: {
  spec: FieldSpec;
  fieldId: string;
  row: { field: string; required: boolean; description: string };
  values: Record<string, string>;
  onChange: FieldRendererProps['onChange'];
}) {
  const { ref, onFocus } = useTemplateField<HTMLInputElement>(fieldId, `${spec.label} · ${row.field}`, true);
  return (
    <div className="flex flex-col gap-1">
      <Label className="font-mono text-[11px] text-[var(--color-ink-muted)]">
        {row.field}
        {row.required ? <span className="text-[var(--color-danger)]">*</span> : null}
      </Label>
      <Input
        ref={ref}
        value={values[row.field] ?? ''}
        placeholder={row.description}
        className="h-8 font-mono text-xs"
        onFocus={onFocus}
        onChange={(event) => {
          const next = event.target.value;
          const merged = { ...values };
          if (next.length === 0) delete merged[row.field];
          else merged[row.field] = next;
          onChange(spec.key, merged, `${spec.key}:${row.field}`);
        }}
      />
      <p className="text-[10px] text-[var(--color-ink-faint)]">{row.description}</p>
    </div>
  );
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

function controlOptions(
  control: Extract<Control, { kind: 'select' | 'checklist' }>,
  sources: OptionSources,
): readonly ControlOption[] {
  if (control.options !== undefined) return control.options;
  if (control.optionsFrom === undefined) return [];
  return optionsFor(control.optionsFrom, sources);
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const entry of value) if (typeof entry === 'string') entries.push(entry);
  return entries;
}

/** The declared row config is a string map; the action kind reads its command from it. */
function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string') entries.push([key, entry]);
  return Object.fromEntries(entries);
}
