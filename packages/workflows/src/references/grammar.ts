/**
 * The {{...}} grammar. Three forms are supported, and this module is the only
 * place that knows them:
 *
 *   {{input.payload.shiftId}}            the trigger event
 *   {{nodes.<nodeId>.output.<path>}}     an upstream node's output
 *   {{run.workflowName}}                 run metadata: id, tenant, workflow, name
 *   {{now}} | {{now+4h}} | {{now-30m}}    a timestamp, optionally offset from now
 */
export const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

const WHOLE_PATTERN = /^\{\{\s*([^}]+?)\s*\}\}$/;

export type TemplateReference =
  | { kind: 'input'; path: string }
  | { kind: 'node'; nodeId: string; path: string }
  | { kind: 'run'; path: string }
  | { kind: 'now'; offsetMinutes: number };

export function parseTemplateExpression(expression: string): TemplateReference | null {
  const trimmed = expression.trim();

  if (trimmed === 'now') return { kind: 'now', offsetMinutes: 0 };

  const nowMatch = /^now\s*([+-])\s*(\d+)([mh])$/.exec(trimmed);
  if (nowMatch) {
    const [, sign, magnitude, unit] = nowMatch;
    const minutes = Number(magnitude) * (unit === 'h' ? 60 : 1);
    return { kind: 'now', offsetMinutes: sign === '-' ? -minutes : minutes };
  }

  if (trimmed === 'input' || trimmed.startsWith('input.')) {
    return { kind: 'input', path: trimmed === 'input' ? '' : trimmed.slice('input.'.length) };
  }

  if (trimmed === 'run' || trimmed.startsWith('run.')) {
    return { kind: 'run', path: trimmed === 'run' ? '' : trimmed.slice('run.'.length) };
  }

  const nodeMatch = /^nodes\.([a-z][a-z0-9_]*)\.output(?:\.(.*))?$/.exec(trimmed);
  if (nodeMatch) {
    const [, nodeId, path] = nodeMatch;
    return { kind: 'node', nodeId: nodeId ?? '', path: path ?? '' };
  }

  return null;
}

/** True when the template is exactly one reference, which splices the raw value. */
export function isWholeReference(template: string): boolean {
  const whole = WHOLE_PATTERN.exec(template.trim());
  return whole !== null && parseTemplateExpression(whole[1] ?? '') !== null;
}

export function referencedNodeIds(template: string): string[] {
  const ids: string[] = [];
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const reference = parseTemplateExpression(match[1] ?? '');
    if (reference?.kind === 'node' && !ids.includes(reference.nodeId)) ids.push(reference.nodeId);
  }
  return ids;
}

/** Every reference in a template, for the save-time checks. */
export function referencesIn(template: string): Array<{ expression: string; reference: TemplateReference | null }> {
  const found: Array<{ expression: string; reference: TemplateReference | null }> = [];
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const expression = match[1] ?? '';
    found.push({ expression, reference: parseTemplateExpression(expression) });
  }
  return found;
}
