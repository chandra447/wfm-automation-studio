import { z } from 'zod';
import { nodeIdSchema } from '../primitives.ts';
import type { EdgePort } from '../primitives.ts';
import type { Diagnostic, ValidationContext } from '../diagnostics.ts';
import type { FieldSpec, InputSpec, NodeCapabilities, NodeKind, NodeLike, PortRequirement, TemplateSlot } from './types.ts';

/** The node a kind's own rules and capability resolver are handed. */
export type NodeOfKind<TType extends string, S extends z.ZodObject<z.ZodRawShape>> = {
  id: string;
  type: TType;
  label: string;
  config: z.output<S>;
};

export interface KindDefinition<TType extends string, S extends z.ZodObject<z.ZodRawShape>> {
  ports: readonly EdgePort[];
  /**
   * Required, not defaulted: a kind that accepted edges without anyone
   * deciding it would be a shape nobody chose. `trigger` declares none.
   */
  inputs: readonly InputSpec[];
  requiredPorts?: readonly PortRequirement[];
  capabilities: NodeCapabilities;
  capabilitiesOf?: (node: NodeOfKind<TType, S>) => NodeCapabilities;
  palette: { label: string; description: string; accent: string; icon: string };
  defaultLabel: string;
  defaultConfig: z.input<S>;
  fields: readonly FieldSpec[];
  summary: (config: z.output<S>) => string;
  configRules?: readonly ((node: NodeOfKind<TType, S>, context: ValidationContext) => readonly Diagnostic[])[];
  templates?: (config: z.output<S>) => readonly TemplateSlot[];
  outputSchema?: z.ZodType;
}

/**
 * The one place a node kind is assembled. The `const T` type parameter is load
 * bearing: it keeps the discriminant a literal so `WorkflowNode` stays a
 * discriminated union and every `switch (node.type)` still narrows.
 */
export function defineKind<const T extends string, S extends z.ZodObject<z.ZodRawShape>>(
  type: T,
  configSchema: S,
  definition: KindDefinition<T, S>,
): NodeKind<T, S> {
  const nodeSchema = z.object({
    id: nodeIdSchema,
    type: z.literal(type),
    label: z.string().min(1).max(80),
    config: configSchema,
  });

  return {
    type,
    schema: configSchema,
    nodeSchema,
    ports: definition.ports,
    inputs: definition.inputs,
    requiredPorts: definition.requiredPorts ?? [],
    capabilities: definition.capabilities,
    // The registry pairs a kind with its own nodes, so this narrowing is the
    // contract defineKind exists to enforce. It is the one cast in the kernel.
    ...(definition.capabilitiesOf === undefined
      ? {}
      : {
          capabilitiesOf: (node: NodeLike) =>
            definition.capabilitiesOf?.(node as NodeOfKind<T, S>) ?? definition.capabilities,
        }),
    palette: definition.palette,
    defaultLabel: definition.defaultLabel,
    defaultConfig: definition.defaultConfig,
    fields: definition.fields,
    summary: definition.summary,
    configRules: (definition.configRules ?? []).map(
      (rule) => (node: NodeLike, context: ValidationContext) => rule(node as NodeOfKind<T, S>, context),
    ),
    templates: definition.templates ?? (() => []),
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
  };
}
