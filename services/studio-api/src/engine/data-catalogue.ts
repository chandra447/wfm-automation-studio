import { triggerCatalog, type DataCatalogue } from '@wfm/contracts';

/**
 * The paths a workflow author can insert into a template field, with a sample
 * value for each. The trigger root is derived from the event's published JSON
 * Schema and sample, so it always matches what the save-time checker accepts.
 */

interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, unknown>;
  items?: unknown;
  $ref?: string;
  $defs?: Record<string, unknown>;
}

const asSchema = (value: unknown): JsonSchemaNode | null =>
  typeof value === 'object' && value !== null ? (value as JsonSchemaNode) : null;

function dereference(schema: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  if (schema.$ref === undefined) return schema;
  const name = schema.$ref.replace(/^#\/\$defs\//, '');
  return asSchema(root.$defs?.[name]) ?? schema;
}

function typeLabel(schema: unknown): string {
  const node = asSchema(schema);
  if (node === null) return 'value';
  if (node.type !== undefined) return node.type;
  if (node.$ref !== undefined) return 'object';
  return 'value';
}

function sampleOf(sample: unknown, path: readonly string[]): string {
  let current: unknown = sample;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined || current === null) return '';
  return typeof current === 'object' ? JSON.stringify(current).slice(0, 120) : String(current);
}

interface PathEntry {
  path: string;
  label: string;
  type: string;
  sample: string;
}

function walk(schema: JsonSchemaNode, root: JsonSchemaNode, sample: unknown, prefix: readonly string[], into: PathEntry[]): void {
  const resolved = dereference(schema, root);
  if (resolved.properties === undefined) return;

  for (const [key, child] of Object.entries(resolved.properties)) {
    const childSchema = asSchema(child);
    if (childSchema === null) continue;
    const path = [...prefix, key];
    const resolvedChild = dereference(childSchema, root);
    const dotted = path.join('.');
    into.push({ path: dotted, label: key, type: typeLabel(resolvedChild), sample: sampleOf(sample, path) });
    if (into.length > 60) return;
    if (resolvedChild.properties !== undefined) walk(resolvedChild, root, sample, path, into);
    if (resolvedChild.type === 'array' && resolvedChild.items !== undefined) {
      const items = asSchema(dereference(asSchema(resolvedChild.items) ?? {}, root));
      if (items !== null && items.properties !== undefined) {
        into.push({
          path: `${dotted}.0`,
          label: `${key}[0]`,
          type: 'object',
          sample: sampleOf(sample, [...path, '0']),
        });
      }
    }
  }
}

export function buildDataCatalogue(eventType: string): DataCatalogue {
  const descriptor = triggerCatalog().find((entry) => entry.eventType === eventType);
  const payloadPaths: PathEntry[] = [];
  if (descriptor !== undefined) {
    const root = asSchema(descriptor.jsonSchema);
    if (root !== null) walk(root, root, descriptor.sample, ['payload'], payloadPaths);
  }

  return {
    eventType,
    roots: [
      {
        name: 'input',
        label: 'Trigger event',
        description: `Fields the ${eventType} event carries.`,
        paths: [
          { path: 'input.eventType', label: 'eventType', type: 'string', sample: eventType },
          { path: 'input.eventId', label: 'eventId', type: 'string', sample: '' },
          { path: 'input.occurredAt', label: 'occurredAt', type: 'string', sample: '' },
          ...payloadPaths.map((entry) => ({ ...entry, path: `input.${entry.path}` })),
        ],
      },
      {
        name: 'run',
        label: 'This run',
        description: 'Identity of the run the workflow is executing.',
        paths: [
          { path: 'run.runId', label: 'runId', type: 'string', sample: '' },
          { path: 'run.workflowName', label: 'workflowName', type: 'string', sample: '' },
          { path: 'run.workflowId', label: 'workflowId', type: 'string', sample: '' },
          { path: 'run.tenantId', label: 'tenantId', type: 'string', sample: '' },
          { path: 'run.correlationId', label: 'correlationId', type: 'string', sample: '' },
          { path: 'run.triggerEventId', label: 'triggerEventId', type: 'string', sample: '' },
        ],
      },
      {
        name: 'now',
        label: 'Time',
        description: 'Resolved when the node runs.',
        paths: [
          { path: 'now', label: 'now', type: 'string', sample: '' },
          { path: 'now+1h', label: 'in one hour', type: 'string', sample: '' },
          { path: 'now+24h', label: 'in one day', type: 'string', sample: '' },
          { path: 'now-30m', label: 'half an hour ago', type: 'string', sample: '' },
        ],
      },
    ],
  };
}
