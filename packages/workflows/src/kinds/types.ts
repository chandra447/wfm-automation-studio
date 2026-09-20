import type { z } from 'zod';
import type { EdgePort } from '../primitives.ts';
import type { Diagnostic, ValidationContext } from '../diagnostics.ts';

/**
 * What a node kind declares. Everything the platform needs to know about a kind
 * lives here: its config schema, its ports, what it is capable of, what the
 * canvas should render, and the strings that carry {{...}} references. Adding a
 * kind means writing one declaration and registering it; the validator, the
 * compiler, the catalogue, the engine dispatch, and the inspector all read this
 * shape instead of branching on the kind's name.
 */

export interface NodeCapabilities {
  /** Exactly one per definition; starts the run; nothing may target it. */
  readonly isTrigger?: boolean;
  /** Ends a path; no outgoing edges; a target for the terminal checks. */
  readonly terminal?: boolean;
  /** Satisfies the guardrail requirement for downstream mutating nodes. */
  readonly providesPolicy?: boolean;
  /** Satisfies the human-decision requirement for downstream pay-impacting nodes. */
  readonly providesApproval?: boolean;
  /** Writes to a domain service, and is therefore subject to the authority rules. */
  readonly mutatesDomain?: boolean;
  /** Downstream nodes may reference its output. */
  readonly producesOutput?: boolean;
  /** Renders a document and attaches it to the run. */
  readonly producesArtifact?: boolean;
  /** Whether this node can move pay. A kind whose answer depends on config resolves it in `capabilitiesOf`. */
  readonly payImpact?: boolean;
}

export type ControlSource =
  | 'triggerEvents'
  | 'aiOutputs'
  | 'policyChecks'
  | 'approvalDisplay'
  | 'commands'
  | 'tools'
  | 'artifactFormats'
  | 'endOutcomes'
  | 'models';

export type Control =
  | { kind: 'text'; maxLength?: number; placeholder?: string }
  | { kind: 'textarea'; maxLength?: number; rows?: number; placeholder?: string }
  | { kind: 'number'; min?: number; max?: number; integer?: boolean }
  | { kind: 'select'; options?: readonly { value: string; label: string }[]; optionsFrom?: ControlSource }
  | { kind: 'switch' }
  | { kind: 'checklist'; options?: readonly { value: string; label: string }[]; optionsFrom?: ControlSource }
  | { kind: 'conditions' }
  | {
      kind: 'templateMap';
      rows: (config: Record<string, string>) => readonly { field: string; required: boolean; description: string }[];
    };

export interface FieldSpec {
  /** Config key this control edits. */
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly control: Control;
  /** Render the {{...}} affordance for this field. */
  readonly template?: boolean;
  readonly visible?: (config: Record<string, unknown>) => boolean;
}

/** One place in a node's config where a {{...}} reference may appear. */
export interface TemplateSlot {
  /** Which config field it came from, for the diagnostic message. */
  readonly origin: string;
  readonly template: string;
  /**
   * `whole` when the template is exactly one reference, which splices the raw
   * value rather than its string form. Existing action nodes depend on this for
   * array inputs such as employeeIds.
   */
  readonly mode: 'inline' | 'whole';
}

/**
 * The shape the erased `NodeKind` interface sees. A concrete kind's node is
 * assignable to it, so the validator can call a kind's rules with any node it
 * holds without the kinds having to know the assembled union.
 */
export interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly config: unknown;
}

export interface PortRequirement {
  readonly port: EdgePort;
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
}

/** The full node schema for one kind. Kept precise so the union discriminates. */
export type NodeSchemaOf<TType extends string, S extends z.ZodObject<z.ZodRawShape>> = z.ZodObject<{
  id: z.ZodString;
  type: z.ZodLiteral<TType>;
  label: z.ZodString;
  config: S;
}>;

export interface NodeKind<TType extends string = string, S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  readonly type: TType;
  /** The config schema alone. */
  readonly schema: S;
  /** The full node schema, built by defineKind from the config schema. */
  readonly nodeSchema: NodeSchemaOf<TType, S>;
  readonly ports: readonly EdgePort[];
  readonly requiredPorts: readonly PortRequirement[];
  readonly capabilities: NodeCapabilities;
  /**
   * Resolves capabilities for one node. Kinds that declare statically leave
   * this unset; a kind whose capability depends on its config supplies it, and
   * the validator calls it before reading any capability.
   */
  readonly capabilitiesOf?: (node: NodeLike) => NodeCapabilities;
  readonly palette: { label: string; description: string; accent: string; icon: string };
  readonly defaultLabel: string;
  readonly defaultConfig: z.input<S>;
  readonly fields: readonly FieldSpec[];
  readonly summary: (config: z.output<S>) => string;
  readonly configRules: readonly ((node: NodeLike, context: ValidationContext) => readonly Diagnostic[])[];
  readonly templates: (config: z.output<S>) => readonly TemplateSlot[];
  readonly outputSchema?: z.ZodType;
}
