import { TEMPLATE_PATTERN, isWholeReference, parseTemplateExpression } from './grammar.ts';
import type { TemplateSlot } from '../kinds/types.ts';

/**
 * Run-time resolution. One resolver for every kind: a node hands it the slots
 * its kind declared, and gets back either raw values (for a whole reference) or
 * a rendered string.
 */

export interface TemplateScope {
  input: unknown;
  nodes: Record<string, { output: unknown }>;
  run: Record<string, unknown>;
  now: Date;
}

export function readPath(source: unknown, path: string): unknown {
  if (path.length === 0) return source;
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function valueOf(reference: ReturnType<typeof parseTemplateExpression>, scope: TemplateScope): unknown {
  if (reference === null) return undefined;
  switch (reference.kind) {
    case 'now':
      return new Date(scope.now.getTime() + reference.offsetMinutes * 60_000).toISOString();
    case 'input':
      return readPath(scope.input, reference.path);
    case 'run':
      return readPath(scope.run, reference.path);
    case 'node':
      return readPath(scope.nodes[reference.nodeId]?.output, reference.path);
    default:
      return undefined;
  }
}

export function resolveTemplate(template: string, scope: TemplateScope): string {
  return template.replace(TEMPLATE_PATTERN, (_match, expression: string) => {
    const value = valueOf(parseTemplateExpression(expression), scope);
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Resolves a mapping of field to template, keeping raw values for whole references. */
export function resolveTemplateMap(
  mapping: Record<string, string>,
  scope: TemplateScope,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [field, template] of Object.entries(mapping)) {
    resolved[field] = resolveSlot({ origin: field, template, mode: isWholeReference(template) ? 'whole' : 'inline' }, scope);
  }
  return resolved;
}

export function resolveSlot(slot: TemplateSlot, scope: TemplateScope): unknown {
  if (slot.mode === 'whole') {
    const whole = slot.template.trim().slice(2, -2).trim();
    return valueOf(parseTemplateExpression(whole), scope);
  }
  return resolveTemplate(slot.template, scope);
}

/** Resolves every slot a kind declared, keyed by the slot's origin. */
export function resolveSlots(slots: readonly TemplateSlot[], scope: TemplateScope): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const slot of slots) resolved[slot.origin] = resolveSlot(slot, scope);
  return resolved;
}
