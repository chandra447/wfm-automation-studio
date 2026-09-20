import type { z } from 'zod';
import type { Diagnostic } from '../diagnostics.ts';
import { referencesIn } from './grammar.ts';

/**
 * Save-time checks for {{...}} references. The trigger payload is checked
 * against the event's published JSON Schema, which is the same artifact the
 * triggers page shows, so the checker never reaches into the validation
 * library's internals. A schema that does not describe the path is treated as
 * permissive: this check catches typos, it does not prove the data exists.
 */

interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
  $ref?: string;
  $defs?: Record<string, unknown>;
  anyOf?: unknown[];
  oneOf?: unknown[];
  additionalProperties?: unknown;
}

const asSchema = (value: unknown): JsonSchemaNode | null =>
  typeof value === 'object' && value !== null ? (value as JsonSchemaNode) : null;

function dereference(schema: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  if (schema.$ref === undefined) return schema;
  const name = schema.$ref.replace(/^#\/\$defs\//, '');
  return asSchema(root.$defs?.[name]) ?? schema;
}

/** Whether a dotted path exists in a JSON Schema. Permissive when unsure. */
export function schemaHasPath(schema: unknown, path: string): boolean {
  const root = asSchema(schema);
  if (root === null || path === '') return true;

  let current: JsonSchemaNode | null = root;
  for (const segment of path.split('.')) {
    if (current === null) return true;
    const resolved = dereference(current, root);

    const branch = [...(resolved.anyOf ?? []), ...(resolved.oneOf ?? [])]
      .map(asSchema)
      .find((candidate) => candidate?.properties?.[segment] !== undefined);
    if (branch !== undefined && branch !== null) {
      current = asSchema(dereference(branch, root).properties?.[segment]);
      continue;
    }

    if (resolved.type === 'array' || resolved.items !== undefined) {
      if (!/^\d+$/.test(segment)) return false;
      current = asSchema(dereference(asSchema(resolved.items) ?? {}, root));
      continue;
    }

    const properties = resolved.properties;
    if (properties === undefined) return true;
    if (!(segment in properties)) return false;
    current = asSchema(properties[segment]);
  }
  return true;
}

export interface TemplateCheckContext {
  /** Ids of nodes that can reach this node, never including itself. */
  upstreamOf: (nodeId: string) => ReadonlySet<string>;
  nodeExists: (nodeId: string) => boolean;
  triggerEventType: string | undefined;
  eventSchemaOf: (eventType: string) => unknown;
  outputSchemaOf: (nodeId: string) => z.ZodType | undefined;
}

export function checkTemplateStrings(
  nodeId: string,
  templates: ReadonlyArray<{ origin: string; template: string }>,
  context: TemplateCheckContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const upstream = context.upstreamOf(nodeId);
  const payloadSchema =
    context.triggerEventType === undefined ? undefined : context.eventSchemaOf(context.triggerEventType);

  for (const { origin, template } of templates) {
    for (const { expression, reference } of referencesIn(template)) {
      if (reference === null) {
        diagnostics.push({
          severity: 'error',
          code: 'TEMPLATE_INVALID',
          message: `Input "${origin}" uses an unsupported expression "{{${expression}}}".`,
          nodeId,
        });
        continue;
      }
      if (reference.kind === 'node') {
        if (!context.nodeExists(reference.nodeId)) {
          diagnostics.push({
            severity: 'error',
            code: 'TEMPLATE_NODE_UNKNOWN',
            message: `Input "${origin}" references node "${reference.nodeId}", which does not exist.`,
            nodeId,
          });
          continue;
        }
        if (reference.nodeId === nodeId || !upstream.has(reference.nodeId)) {
          diagnostics.push({
            severity: 'error',
            code: 'TEMPLATE_NOT_UPSTREAM',
            message: `Input "${origin}" references "${reference.nodeId}", which does not run before this node.`,
            nodeId,
          });
        }
        continue;
      }
      if (reference.kind === 'input' && payloadSchema !== undefined) {
        // `input` is the event envelope, and the published schema describes its
        // payload. Paths outside `payload.` address envelope fields, which the
        // schema does not describe, so only payload paths are checked.
        const prefix = 'payload.';
        if (!reference.path.startsWith(prefix)) continue;
        const payloadPath = reference.path.slice(prefix.length);
        if (schemaHasPath(payloadSchema, payloadPath)) continue;
        diagnostics.push({
          severity: 'error',
          code: 'TEMPLATE_EVENT_PATH',
          message: `Input "${origin}" reads "{{${expression}}}", which the "${context.triggerEventType ?? 'trigger'}" event does not carry.`,
          nodeId,
        });
      }
    }
  }
  return diagnostics;
}
