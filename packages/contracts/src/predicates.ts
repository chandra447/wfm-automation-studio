import { z } from 'zod';
import type { AnyWfmEvent } from './events/registry.ts';

/**
 * Condition DSL for workflow triggers. Conditions are data, not code: the
 * studio stores them, the engine evaluates them, the UI previews them — all
 * through this one evaluator so a customer's rule cannot mean two things.
 */
export const conditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'exists']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
});

export type Condition = z.infer<typeof conditionSchema>;

export interface ConditionResult {
  condition: Condition;
  actual: unknown;
  matched: boolean;
}

export interface ConditionEvaluation {
  matched: boolean;
  results: ConditionResult[];
}

/** Reads a dot path such as `payload.hoursUntilStart` or `aggregate.id`. */
export function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function compare(actual: unknown, condition: Condition): boolean {
  const { op, value } = condition;
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === value;
    case 'neq':
      return actual !== value;
    case 'lt':
      return typeof actual === 'number' && typeof value === 'number' && actual < value;
    case 'lte':
      return typeof actual === 'number' && typeof value === 'number' && actual <= value;
    case 'gt':
      return typeof actual === 'number' && typeof value === 'number' && actual > value;
    case 'gte':
      return typeof actual === 'number' && typeof value === 'number' && actual >= value;
    case 'in':
      return Array.isArray(value) && value.includes(actual as string | number);
    case 'contains':
      return Array.isArray(actual)
        ? actual.includes(value as never)
        : typeof actual === 'string' && typeof value === 'string' && actual.includes(value);
    default:
      return false;
  }
}

export function evaluateConditions(
  conditions: readonly Condition[],
  event: AnyWfmEvent,
): ConditionEvaluation {
  const results = conditions.map<ConditionResult>((condition) => {
    const actual = readPath(event, condition.field);
    return { condition, actual, matched: compare(actual, condition) };
  });
  return { matched: results.every((result) => result.matched), results };
}
