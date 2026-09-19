/**
 * Input templates let a saved workflow wire one node's output into the next
 * node's input without executing code. Three forms are supported and all three
 * are validated at save time:
 *
 *   {{input.payload.shiftId}}            the trigger event
 *   {{nodes.<nodeId>.output.<path>}}     an upstream node's output
 *   {{now+4h}} | {{now-30m}}             a timestamp offset from now
 */
export const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export type TemplateReference =
  | { kind: 'input'; path: string }
  | { kind: 'node'; nodeId: string; path: string }
  | { kind: 'now'; offsetMinutes: number };

export function parseTemplateExpression(expression: string): TemplateReference | null {
  const trimmed = expression.trim();

  const nowMatch = /^now\s*([+-])\s*(\d+)([mh])$/.exec(trimmed);
  if (nowMatch) {
    const [, sign, magnitude, unit] = nowMatch;
    const minutes = Number(magnitude) * (unit === 'h' ? 60 : 1);
    return { kind: 'now', offsetMinutes: sign === '-' ? -minutes : minutes };
  }

  if (trimmed === 'input' || trimmed.startsWith('input.')) {
    return { kind: 'input', path: trimmed === 'input' ? '' : trimmed.slice('input.'.length) };
  }

  const nodeMatch = /^nodes\.([a-z][a-z0-9_]*)\.output(?:\.(.*))?$/.exec(trimmed);
  if (nodeMatch) {
    const [, nodeId, path] = nodeMatch;
    return { kind: 'node', nodeId: nodeId ?? '', path: path ?? '' };
  }

  return null;
}

export function referencedNodeIds(template: string): string[] {
  const ids: string[] = [];
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const reference = parseTemplateExpression(match[1] ?? '');
    if (reference?.kind === 'node' && !ids.includes(reference.nodeId)) ids.push(reference.nodeId);
  }
  return ids;
}

function readPath(source: unknown, path: string): unknown {
  if (path.length === 0) return source;
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

export interface TemplateScope {
  input: unknown;
  nodes: Record<string, { output: unknown }>;
  now: Date;
}

export function resolveTemplate(template: string, scope: TemplateScope): string {
  return template.replace(TEMPLATE_PATTERN, (_match, expression: string) => {
    const reference = parseTemplateExpression(expression);
    if (!reference) return '';
    switch (reference.kind) {
      case 'now':
        return new Date(scope.now.getTime() + reference.offsetMinutes * 60_000).toISOString();
      case 'input': {
        const value = readPath(scope.input, reference.path);
        return value === undefined || value === null ? '' : String(value);
      }
      case 'node': {
        const value = readPath(scope.nodes[reference.nodeId]?.output, reference.path);
        return value === undefined || value === null ? '' : String(value);
      }
      default:
        return '';
    }
  });
}

/** Resolves a mapping of field → template, coercing `[]`-ish values into arrays. */
export function resolveTemplateMap(
  mapping: Record<string, string>,
  scope: TemplateScope,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [field, template] of Object.entries(mapping)) {
    const exact = template.trim().match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (exact) {
      const reference = parseTemplateExpression(exact[1] ?? '');
      if (reference) {
        if (reference.kind === 'input') {
          const value = readPath(scope.input, reference.path);
          resolved[field] = value;
          continue;
        }
        if (reference.kind === 'node') {
          resolved[field] = readPath(scope.nodes[reference.nodeId]?.output, reference.path);
          continue;
        }
      }
    }
    resolved[field] = resolveTemplate(template, scope);
  }
  return resolved;
}
