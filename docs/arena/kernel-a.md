# Kernel A — Abstract classes first: `NodeKind` as the unit of node extension

Candidate A in the node-kind extension kernel + reference mechanism arena.
Mandate: model each node kind as a class with an abstract base that owns the
invariants; each subclass owns its config schema, ports, inspector fields,
validation, and run-time behaviour. A registry maps kind → class, and the zod
discriminated union is *built from* the registry so the union stays a union.
The reference mechanism is designed against the same object model.

Everything below is grounded in the current sources: `packages/workflows/src/{dsl,catalogue,validate,compile,templates}.ts`,
`services/studio-api/src/engine/{graph,state}.ts` and `engine/nodes/{action,propose}.ts`,
`apps/studio-web/components/builder/{inspector,palette,state}.tsx|.ts`.

---

## 1. Caller usage first

### 1.1 The code a developer writes to add a new node kind

One new file. The class is the single home for everything about the kind —
schema, capabilities, ports, inspector field spec, catalog checks, palette
copy, run-time behaviour:

```ts
// packages/workflows/src/kinds/notify.ts          ← the ONLY new file
import { z } from 'zod';
import { NodeKind, type Diagnostic, type KindContext, type RunContext, type NodeOutcome } from './base.ts';
import { resolveTemplateScope, resolveTemplates } from '../templates.ts';
import { audienceCatalog } from './catalogue-data.ts';

const notifyConfigSchema = z.object({
  channel: z.enum(['email', 'push']),
  audience: z.string().min(1),
  // Template-bearing field. Declared once in templateFields below; the parser,
  // resolver and static validator are shared machinery, never per-kind.
  message: z.string().min(1).max(400),
});

export class NotifyKind extends NodeKind<typeof notifyConfigSchema> {
  readonly type = 'notify' as const;
  readonly configSchema = notifyConfigSchema;

  // Palette (replaces the nodePalette literal in catalogue.ts)
  readonly label = 'Notify';
  readonly description = 'Sends a templated message to a named audience when its port fires.';
  readonly accent = 'sky';
  readonly icon = '✉';
  readonly defaultConfig = { channel: 'email', audience: 'operations_lead', message: '' };

  // Capability declaration — the platform invariants read this, never `type`.
  readonly caps = { producesOutput: true };

  readonly ports = ['always'] as const;
  readonly portRequirements = [];

  // Inspector (replaces the `case 'notify':` JSX in inspector.tsx)
  readonly fields = [
    { control: 'select',   field: 'channel',  label: 'Channel', options: [{ value: 'email', label: 'Email' }, { value: 'push', label: 'Push' }] },
    { control: 'text',     field: 'audience', label: 'Audience', mono: true },
    { control: 'textarea', field: 'message',  label: 'Message',
      hint: 'Use {{input.payload.shiftId}}, {{nodes.<id>.output.<path>}}, {{now+4h}}.' },
  ] as const;

  // Which config strings carry references (drives static validation + resolution)
  readonly templateFields = [{ field: 'message', record: false }] as const;

  // Kind-specific checks beyond the zod schema. Everything cross-cutting
  // (ports, cycles, authority, template upstream-ness) lives in the base/validator.
  validateConfig(node: NodeOf<this>, context: KindContext): Diagnostic[] {
    return audienceCatalog().some((a) => a.id === node.config.audience)
      ? []
      : [{ severity: 'error', code: 'UNKNOWN_AUDIENCE', message: `Unknown audience "${node.config.audience}".`, nodeId: node.id }];
  }

  summary(node: NodeOf<this>): string {
    return `${node.config.channel} → ${node.config.audience}`;
  }

  async run(node: NodeOf<this>, ctx: RunContext, state: RunState): Promise<NodeOutcome> {
    const [message] = resolveTemplates(this, node, templateScopeOf(state));
    const result = await ctx.notifier.send(node.config.channel, node.config.audience, message);
    return outcomeOf(node.id, { output: result, summary: `${node.label}: notified ${node.config.audience}` }, 'always');
  }
}
```

And the single registration line in the registry:

```ts
// packages/workflows/src/kinds/registry.ts
export const NODE_KINDS = [
  new TriggerKind(), new ConditionKind(), new AiDecisionKind(),
  new PolicyCheckKind(), new HumanApprovalKind(), new ActionKind(),
  new EndKind(),
  new NotifyKind(),          // ← the one registration line
] as const;
```

**That is the entire change: 1 new file + 1 registration line.** The validator,
compiler, catalogue, engine dispatch, palette and inspector are untouched.
The only additional line anywhere is when the kind wants a brand-new *accent
colour*: one entry in the web's accent-token map (`accentVarByNodeType` —
seven existing entries keyed by accent name, not kind).

### 1.2 The code a workflow author writes to use a reference

Identical surface to today's `{{...}}` templates, now legal in every field a
kind marks as template-bearing (`templateFields`), not just `action.input`:

```ts
{
  id: 'notify_team',
  type: 'notify',
  label: 'Tell the roster manager',
  config: {
    channel: 'email',
    audience: 'operations_lead',
    message: 'Shift {{input.payload.shiftId}} still unfilled: {{nodes.rank.output.candidateIds}} (closes {{now+4h}}).',
  },
}
```

`{{input.payload.shiftId}}` is statically checked against the trigger event's
zod payload schema (`eventDefinitions[type].schema` in `@wfm/contracts`);
`{{nodes.<id>.output.<path>}}` is checked for existence, upstream-ness, and
against the upstream kind's `outputSchema` when the kind declares one.

---

## 2. Type sketch

The whole design hinges on one loop: **the concrete kind supplies a literal
`type` and a concrete `configSchema`; TypeScript derives the node union from
the registry; zod derives the runtime parser from the same registry.** One
source, two derivations, no parallel tables.

### 2.1 The abstract base (`kinds/base.ts`)

```ts
import type { z } from 'zod';
import type { EdgePort } from '../dsl.ts';
import type { CommandDescriptor, ToolDescriptor } from './catalogue-data.ts';
import type { Diagnostic } from '../diagnostics.ts';

/** What a node kind *is*, as far as the platform invariants are concerned. */
export interface NodeCapabilities {
  /** Starts the run. Exactly one per workflow; no incoming edges. */
  readonly startsRun?: boolean;
  /** Ends the run; must have no outgoing edges; `NO_TERMINAL_PATH` targets it. */
  readonly terminal?: boolean;
  /** Counts as the deterministic guardrail on a path (satisfies `requiresPolicy`). */
  readonly providesPolicy?: boolean;
  /** Counts as the human decision on a path (satisfies approval checks). */
  readonly providesApproval?: boolean;
  /** This node's every path must be guarded by a `providesPolicy` node. */
  readonly requiresPolicy?: boolean;
  /** May move pay; additionally requires a `providesApproval` node on every path. */
  readonly mayAffectPay?: boolean;
  /** Writes a run-state output other nodes may reference. */
  readonly producesOutput?: boolean;
}

/** Catalogues + trigger schemas the validator, capabilities and inspector need. */
export interface KindContext {
  readonly eventTypes: readonly string[];
  readonly commands: readonly CommandDescriptor[];
  readonly tools: readonly ToolDescriptor[];
  /** The zod payload schema for a trigger event, from `eventDefinitions`. */
  readonly eventSchemaOf: (eventType: string) => z.ZodType | undefined;
}

export type AnyNodeOf = WorkflowNode; // from ../dsl.ts (import type)

/**
 * The erased shape most of the codebase touches. Concrete `NodeKind<C>`
 * subclasses are assignable to this because these are *methods*
 * (method bivariance is intentional and safe here — see Rationale).
 */
export interface AnyNodeKind {
  readonly type: string;
  readonly ports: readonly EdgePort[];
  readonly portRequirements: readonly PortRequirement[];
  readonly caps: NodeCapabilities;
  capabilitiesOf(node: WorkflowNode, context: KindContext): NodeCapabilities;
  validateConfig(node: WorkflowNode, context: KindContext): readonly Diagnostic[];
  templatesOf(node: WorkflowNode): readonly { label: string; template: string }[];
  summary(node: WorkflowNode): string;
  emptyNode(id: string): WorkflowNode;
  run(node: WorkflowNode, ctx: RunContext, state: RunState): Promise<NodeOutcome>;
}

export interface PortRequirement {
  readonly port: EdgePort;
  readonly severity: 'error' | 'warning';
  readonly code: string;          // e.g. PORT_MISSING / PORT_MISSING_REJECTED
  readonly message: string;
}

/**
 * The abstract base. `C` pins the kind's config schema so that every derived
 * value (fields, capabilities, summary, run) sees the *narrowed* config type.
 */
export abstract class NodeKind<C extends z.ZodObject<z.ZodRawShape>> implements AnyNodeKind {
  abstract readonly type: string;            // concrete: readonly type = 'action'
  abstract readonly configSchema: C;
  abstract readonly label: string;
  abstract readonly description: string;
  abstract readonly accent: AccentName;
  abstract readonly icon: string;
  abstract readonly caps: NodeCapabilities;
  abstract readonly defaultConfig: Record<string, unknown>;

  readonly ports: readonly EdgePort[] = ['always'];
  readonly portRequirements: readonly PortRequirement[] = [];

  /** Inspector field specs; the generic renderer is the only consumer. */
  abstract readonly fields: readonly AnyFieldSpec[];

  /** Config fields whose strings carry `{{...}}` references. */
  readonly templateFields: readonly TemplateFieldSpec[] = [];

  /** Shape of the `output` this kind writes (for template path checking). */
  readonly outputSchema: z.ZodType | undefined = undefined;

  /** Per-node capabilities — override for dynamic facts (payAffecting commands). */
  capabilitiesOf(node: NodeOf<this>, _context: KindContext): NodeCapabilities {
    return this.caps;
  }

  validateConfig(_node: NodeOf<this>, _context: KindContext): readonly Diagnostic[] {
    return [];
  }

  templatesOf(node: NodeOf<this>): readonly { label: string; template: string }[] {
    return collectTemplates(this.templateFields, node.config);
  }

  summary(_node: NodeOf<this>): string { return ''; }

  emptyNode(id: string): NodeOf<this> {
    // The one sanctioned boundary: defaults are validated into existence.
    return {
      id,
      type: this.type,
      label: this.label,
      config: this.configSchema.parse(this.defaultConfig),
    } as NodeOf<this>; // validation boundary — produced by the kind's own schema
  }

  abstract run(node: NodeOf<this>, ctx: RunContext, state: RunState): Promise<NodeOutcome>;
}
```

The `NodeOf<this>` extraction is what keeps per-kind narrowing alive inside
subclass bodies and at call sites:

```ts
// dsl.ts — derived, hand-written once
export type NodeOf<K extends AnyNodeKind> = Extract<WorkflowNode, { type: K['type'] }>;
```

Because each concrete kind declares `readonly type = 'action' as const` (a
literal), `NodeOf<ActionKind>` resolves to `Extract<WorkflowNode, { type: 'action' }>`
— i.e. the same narrowed `ActionNode` type developers have today, obtained
from the union instead of from a hand-maintained alias. Inside
`ActionKind.run`, `node.config.command` type-checks with zero casts.

### 2.2 The registry and the derived union (`kinds/registry.ts`, `dsl.ts`)

```ts
// kinds/registry.ts — THE registration point
export const NODE_KINDS = [
  new TriggerKind(), new ConditionKind(), new AiDecisionKind(),
  new PolicyCheckKind(), new HumanApprovalKind(), new ActionKind(), new EndKind(),
] as const;

export type AnyNodeKindClass = (typeof NODE_KINDS)[number];

// erased runtime lookup, typed by the derived union
export const kindByType: Readonly<Record<WorkflowNodeType, AnyNodeKind>> =
  Object.fromEntries(NODE_KINDS.map((kind) => [kind.type, kind]));
```

```ts
// dsl.ts — schemas are DERIVED from the registry; only the wrapper shape stays here
import { NODE_KINDS, kindByType } from './kinds/registry.ts';

export const nodeIdSchema = z.string().min(1).max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'node ids are lower_snake_case');

const nodeSchemaOf = <K extends AnyNodeKind>(kind: K) =>
  z.object({
    id: nodeIdSchema,
    type: z.literal(kind.type),        // per-kind literal → discriminator
    label: z.string().min(1).max(80),
    config: kind.configSchema,
  });

const MEMBER_SCHEMAS = NODE_KINDS.map(nodeSchemaOf);      // tuple, one per kind

export const workflowNodeSchema = z.discriminatedUnion('type', ...MEMBER_SCHEMAS);

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowNodeType = WorkflowNode['type'];      // ← the enum, derived
export type TriggerNode = Extract<WorkflowNode, { type: 'trigger' }>;  // etc.

export function isNodeType(value: string): value is WorkflowNodeType {
  return value in kindByType;
}

// Runtime enum shim for the two `z.enum` call sites (catalogue accencts, tests).
// Built from the same literals; no second list to keep in sync.
export const workflowNodeTypeSchema = z.enum(MEMBER_TYPES); // literal tuple via NODE_KINDS mapping

// Ports stay shared vocabulary — see Rationale for why this is NOT per-kind.
export const edgePortSchema = z.enum(['always','true','false','passed','failed','approved','rejected']);
export const workflowEdgeSchema = z.object({ from: nodeIdSchema, to: nodeIdSchema, port: edgePortSchema.default('always') });
export const workflowDefinitionSchema = z.object({ /* unchanged */ });
```

Note what disappeared from `dsl.ts`: the seven hand-written config schema
objects (moved into the kind files), the seven `z.infer` alias exports
(derived via `Extract`), and `legalPortsByNodeType` (derived from
`kindByType[nodeType].ports` — web's `legalPortsFor` reads the registry).
`EdgePort` stays a shared enum in `dsl.ts`: a port is a *routing vocabulary*
shared by edges, canvas handles, and the runtime, not private to one kind.

### 2.3 Capability-driven invariants (`validate.ts`)

The invariant engine keeps every existing diagnostic code; only the
kind-dispatching bodies change, and they change once, generically:

```ts
function checkAuthority(graph: Graph, context: ValidationContext, diagnostics: Diagnostic[]): void {
  for (const node of Object.values(graph.byId)) {
    const caps = kindByType[node.type].capabilitiesOf(node, context);
    if (!caps.requiresPolicy) continue;                 // action-like kinds only

    const paths = pathsTo(graph, node.id);
    if (!paths) { /* GRAPH_TOO_COMPLEX — unchanged */ continue; }

    for (const path of paths) {
      const pathNodes = path.map((id) => graph.byId[id]!).filter(Boolean);
      const provided = (capability: keyof NodeCapabilities) =>
        pathNodes.some((n) => kindByType[n.type].capabilitiesOf(n, context)[capability] === true);

      if (!provided('providesPolicy')) {
        diagnostics.push({ severity: 'error', code: 'ACTION_WITHOUT_POLICY', /* unchanged message */ });
      }
      if (caps.mayAffectPay && !provided('providesApproval')) {
        diagnostics.push({ severity: 'error', code: 'PAY_ACTION_WITHOUT_APPROVAL', /* unchanged message */ });
      }
    }
  }
}
```

`ActionKind.capabilitiesOf` is where `payAffecting` becomes dynamic — one
override, one line, and the invariant generalises for free:

```ts
override capabilitiesOf(node: NodeOf<this>, context: KindContext): NodeCapabilities {
  const command = context.commands.find((c) => c.id === node.config.command);
  return { ...this.caps, mayAffectPay: command?.payAffecting ?? false };
}
```

### 2.4 Reference mechanism (`templates.ts` — one parser, one resolver, one validator)

`templates.ts` keeps `TEMPLATE_PATTERN`, `parseTemplateExpression`,
`resolveTemplate`, `resolveTemplateMap` exactly as they are (they already
single-source the syntax). Three additions, all generic over kinds:

```ts
/** What a kind declares about its template-bearing config fields. */
export interface TemplateFieldSpec {
  /** Key within config. */
  field: string;
  /** true when the field is `Record<string,string>` (like action.input). */
  record: boolean;
}

/** Static validation of one reference — the single validator, shared by all kinds. */
export function validateTemplateReference(
  reference: TemplateReference,
  node: WorkflowNode,
  graph: Graph,
  context: ValidationContext,
  diagnostics: Diagnostic[],
): void {
  switch (reference.kind) {
    case 'input': {
      // {{input.payload.x.y}} — walk the trigger event's zod payload schema.
      const schema = context.eventSchemaOf(graph.trigger.config.eventType);
      if (schema && !schemaHasPath(schema, reference.path)) {
        diagnostics.push({ severity: 'error', code: 'TEMPLATE_PATH_UNKNOWN',
          message: `"${reference.path}" is not a field of the ${graph.trigger.config.eventType} payload.`, nodeId: node.id });
      }
      break;
    }
    case 'node': {
      // existence + upstream-ness (existing codes TEMPLATE_NODE_UNKNOWN / TEMPLATE_NOT_UPSTREAM)
      // + path shape when the upstream kind declares an outputSchema:
      const upstream = graph.byId[reference.nodeId];
      const outSchema = upstream && kindByType[upstream.type].outputSchema;
      if (outSchema && !schemaHasPath(outSchema, reference.path)) { /* TEMPLATE_OUTPUT_PATH */ }
      break;
    }
    case 'now': break; // always resolvable
  }
}
```

`schemaHasPath` walks zod shapes (`ZodObject.shape`, unwrap
`Optional/Nullable/Default`, `ZodArray.element`, any-member of unions). It is
~40 lines, lives once in `templates.ts`, and is the entire price of
rubric item 4. Run-time resolution needs *no* new machinery: kinds call the
existing `resolveTemplate(s)` with the existing `TemplateScope` built from
the run state; `ActionKind.run` does exactly what `runActionNode` does today.

---

## 3. Module map

| File | Contains | Exported to |
|---|---|---|
| `packages/workflows/src/kinds/base.ts` | `NodeKind` abstract class, `NodeCapabilities`, `AnyNodeKind` (erased interface), `PortRequirement`, `TemplateFieldSpec`, `RunContext`/`RunState`/`NodeOutcome` ports, `withFieldValue` | validate, compile, catalogue, engine, kind files |
| `packages/workflows/src/kinds/registry.ts` | `NODE_KINDS` tuple (the registration line), `kindByType` | dsl, validate, compile, catalogue, engine graph, web state |
| `packages/workflows/src/kinds/trigger.ts … end.ts` (7 files) | One per kind: config schema, caps, ports, fields, `validateConfig`, `summary`, `run` (executor body moved in from `engine/nodes/*.ts`) | registry only |
| `packages/workflows/src/kinds/catalogue-data.ts` | `commandCatalog`, `toolCatalog` and their descriptors — **pure data, imports nothing from kinds/** (breaks the would-be cycle kinds → catalogue → registry) | validator, kinds, web |
| `packages/workflows/src/dsl.ts` | Derived: `workflowNodeSchema` (union from registry), `WorkflowNode`, `WorkflowNodeType`, `Extract` aliases, `nodeIdSchema`, `edgePortSchema`, `workflowEdgeSchema`, `workflowDefinitionSchema`, `NodeOf` | everything |
| `packages/workflows/src/templates.ts` | Unchanged parser/resolver + `TemplateFieldSpec` collection, `schemaHasPath`, `validateTemplateReference`, `resolveTemplates(kind, node, scope)` | validate, kinds, engine |
| `packages/workflows/src/validate.ts` | Generic structural rules (graph build, cycles, reachability, terminals, upstream-ness) + capability-driven `checkAuthority` + per-node `kind.validateConfig` fan-out | compile, engine, API |
| `packages/workflows/src/compile.ts` | `GraphSpec` built via capability queries | engine, API |
| `packages/workflows/src/catalogue.ts` | Re-exports `commandCatalog`/`toolCatalog`; `nodePalette` **derived** from `NODE_KINDS` (`{ type, label, description, accent }`) | API, web palette |
| `packages/workflows/src/diagnostics.ts` | `Diagnostic` interface (breaking the base→validate cycle) | base, validate, kinds |
| `packages/workflows/src/index.ts` | Public surface (unchanged names, so consumers' imports keep working) | API, web |
| `services/studio-api/src/engine/graph.ts` | LangGraph wiring; `executeNode` switch **replaced** by registry dispatch; edge wiring keyed on `capabilitiesOf(node).terminal` | — |
| `services/studio-api/src/engine/domain-clients.ts` | Implements the `RunContext.clients` port (structural, no new imports) | kinds at run time |
| `apps/studio-web/components/builder/inspector.tsx` | Generic field renderer + `withFieldValue` commit helper; zero per-kind switches | canvas |
| `apps/studio-web/components/builder/palette.tsx` | Reads derived `nodePalette`; icons from kind `icon` | canvas |
| `apps/studio-web/components/builder/state.ts` | `nodeSummary` → `kindByType[node.type].summary(node)`; `defaultNode` → `kindByType[t].emptyNode(id)` | builder |

Dependency direction stays one-way: `kinds/*` → (base, templates, catalogue-data,
diagnostics) ; `dsl` → `kinds/registry` ; `validate/compile/catalogue` → `dsl + kinds`
(erased). The engine and web depend on the package as before. The `NodeOf`
type lives in `dsl.ts`, so the two type-only cycles (`kinds/base` ↔ `dsl`) are
`import type` only — erased at runtime.

---

## 4. How each consumer changes

### 4.1 `packages/workflows/src/validate.ts`
- **Deleted:** the per-kind branches in `checkPorts` (condition/policy_check/
  human_approval/end/trigger special cases), the `if (node.type !== 'action') continue;`
  guard in `checkAuthority`, the `action`-only guards in `checkNodeConfigs`
  and `checkTemplates`, the `UNKNOWN_EVENT`/`UNKNOWN_TOOL`/`LONG_APPROVAL_TIMEOUT`/
  `UNKNOWN_COMMAND`/`MISSING_INPUT` blocks.
- **Replaced by:** `TRIGGER_COUNT` from the `startsRun` capability;
  `TRIGGER_HAS_INCOMING`/`END_HAS_OUTGOING` from `startsRun`/`terminal`;
  per-port requirements from `kind.portRequirements` (both severities, all codes
  preserved verbatim); authority from capabilities (§2.3); config checks by
  fan-out `for (const node of nodes) diagnostics.push(...kindByType[node.type].validateConfig(node, context))`;
  template validation by fan-out over `kind.templatesOf(node)` →
  `validateTemplateReference`. `ValidationContext` gains `eventSchemaOf`
  (one line, fed from `@wfm/contracts` `eventDefinitions`).
- New kinds never touch this file; platform invariants are written once.

### 4.2 `packages/workflows/src/compile.ts`
`approvalNodeIds = nodes.filter((n) => kindByType[n.type].capabilitiesOf(n, ctx).providesApproval)`,
same shape for `actionNodeIds` (`requiresPolicy` — nodes the audit/dry-run
treat as writing to a domain service) and `terminals` (`terminal`). Because
`capabilitiesOf` is dynamic, a future pay-capable kind lands in
`approvalNodeIds`/`actionNodeIds` automatically. `GraphSpec`'s shape is
unchanged, so the LangGraph runtime and the approvals service are untouched.

### 4.3 `catalogue.ts` + API
`nodePalette` becomes `NODE_KINDS.map((k) => ({ type: k.type, label: k.label, description: k.description, accent: k.accent }))`.
`commandCatalog`/`toolCatalog` move verbatim to `catalogue-data.ts` and are
re-exported, so the API's imports do not change. The per-enum label maps
(`policyCheckLabels`, `aiOutputLabels`, `portLabels`) move beside the enums
they describe (kind files / `dsl.ts`).

### 4.4 Engine dispatch (`engine/graph.ts`)
```ts
async function executeNode(node, ctx: RunContext, state): Promise<...> {
  return kindByType[node.type].run(node, ctx, state);
}
```
and the `specNode.type === 'end'` special case becomes
`kindByType[specNode.type].caps.terminal`. `ExecutorDeps` is adapted once into
the `RunContext` port (logger/db/bus/clients/proposer) — the engine's concrete
implementations satisfy it structurally. The seven `engine/nodes/*.ts` bodies
move into the kind classes (their `if (node.type !== 'x') throw` guards become
unnecessary — the registry guarantees the pairing — but keeping one guard is
fine and I recommend keeping it as a cheap runtime tripwire). After conversion
those files are deleted: one executor per kind now lives in the kind file.

### 4.5 React inspector + palette
`inspector.tsx` collapses to: header/delete/label shell (unchanged) + a
generic field renderer driven by `kind.fields`. Five control primitives cover
all seven kinds today — `text`, `textarea`, `number`, `select`, `toggles`
(checkbox list over a string array) — plus the shared `ConditionEditor`
exposed as a `conditions` control and `conditions`-like needs never spawn a
new component until a genuinely new control appears (a platform-level
addition, like a new port). The action node's pay-impact warning becomes a
`notices?: (node, ctx) => readonly string[]` hook; the "downstream nodes can
read `{{nodes.<id>.output…}}`" footer is keyed off the `producesOutput`
capability. Select options that come from runtime data (trigger events) are
declared as `optionsSource: 'eventTypes' | 'commands' | 'tools' | static`,
resolved from the props the Inspector already receives. The palette reads the
derived `nodePalette`; icons/accents come from kind metadata, so a new kind
needs **no** React edit (unless it introduces a new accent colour — one line
in the accent-token map). `state.ts`: `nodeSummary` and `defaultNode` become
one-line registry lookups; `emptyDefinitionFor`, `nextNodeId`, draft parsing
are unchanged — persisted definitions parse exactly as before.

---

## 5. Rationale

**Why abstract classes (mandate) — and what they genuinely buy.** The unit of
extension is a *thing people reason about* ("the action kind") rather than a
scatter of records. Colocating schema + capabilities + ports + inspector spec
+ validation + executor in one file means a reviewer auditing a new kind reads
one file, and `git grep NotifyKind` finds every fact about it. The registry
also collapses the three dispatch switches (`checkPorts` chains,
`checkNodeConfigs` chains, `executeNode` switch, inspector switch) into data
lookups, which is the actual mechanism behind rubric item 1 — that would be
true of a table design too, and I say so below.

**Rejected: executors stay in `engine/nodes/*` with a second registry.** This
is the alternative shape I weighed hardest, because it keeps
`packages/workflows` free of run-time ports. It fails rubric item 1 as
stated: a new kind is two files and two registrations (kind in workflows,
executor in engine), and the two halves of one kind can drift (a kind whose
`outputSchema` disagrees with what its executor actually writes). Colocating
the executor costs a `RunContext` port interface in the workflows package —
ports, not implementations; the engine's clients satisfy them structurally —
and that is the price I chose to pay, with eyes open.

**Rejected: class-per-kind *subclassing chains* (deeper hierarchies,
`PayAffectingNode` base classes, mixins).** Invariants compose as capabilities,
not as inheritance; `human_approval extends DecisionKind extends NodeKind`
would re-encode today's kind-driven rules as type-system magic and make
"which rule applies to whom" harder to answer, not easier. One flat abstract
base + capability flags is the least machinery that satisfies rubric item 3.

**Rejected: keeping `WorkflowNode` as hand-written aliases + separate
`z.enum`.** Deriving `WorkflowNodeType` from the built union
(`WorkflowNode['type']`) removes the first of the six edit sites for free and
makes it impossible for the enum and the union to drift. The runtime zod enum
is rebuilt from the same literal tuple — one derivation, not two lists.

**Honest costs of this shape (asked for explicitly).**
1. *The bivariance trick is the subtlest part.* `AnyNodeKind` erases `C`, and
   concrete `NodeKind<C>` methods take `NodeOf<this>`; that only type-checks
   because methods are bivariant under `strictFunctionTypes`. It is safe at
   runtime (the registry guarantees kind/node pairing) and pinned by a
   contract test, but a maintainer meeting `NodeOf<this>` for the first time
   needs one paragraph of explanation. A data-table design has no analogous
   subtlety — this is the strongest argument against the mandate, and I want
   it on the record.
2. *Pure-data kinds are ceremony.* `EndKind` is a class wrapping ~10 lines of
   facts. The class container is a uniform tax; a table design charges it
   nowhere. What tips it: the kinds that matter (`action`, future
   prompt-bearing kinds) all carry behaviour and templates, and one shape for
   all kinds is worth more to reader-load than exempting two trivial ones.
3. *Layering.* `RunContext` ports in the workflows package is a mild
   inversion — the DSL package now names its ports (logger, db, bus, clients,
   proposer) without knowing their implementations. I judge this correct
   (ports belong to the contract layer), but it is a real move of ~6
   interface declarations, not a free lunch.
4. *Ports stay a shared enum.* A brand-new port name (`'notified'`) is a
   one-line `edgePortSchema` + `portLabels` edit — honest, deliberate:
   ports are edge-routing vocabulary shared by the canvas and the runtime, so
   they are platform vocabulary, not kind-private data. Any design that
   pretends otherwise moves the same edit, it just hides it.
5. *`schemaHasPath` walks zod internals.* `.shape`, optionality unwrapping and
   union members need zod's introspection surface; it is contained in one
   helper and one narrowly-typed boundary, but it is the most fragile ~40
   lines in the package. If `@wfm/contracts` already exports JSON Schema per
   event, switching the checker to JSON Schema is a drop-in improvement later.

**Why not build the union with `.extend` on a shared `baseNodeSchema`.**
Same result, but extending in the class forces the config schema to be a
constructor parameter rather than a declared field, which loses the concrete
`typeof configSchema` on the instance — the narrowing this design depends on.
Declared class fields keep every derived type concrete.

**Migration.** None. The registry-built union produces byte-identical parse
behaviour to today's hand-written union (same objects, same fields, same
defaults), so every persisted definition keeps parsing unchanged. The
conversion is mechanical and is verified by the existing suite
(`tests/validate.test.ts` passes untouched — its seeded workflows and codes
are the compatibility contract).

---

## 6. Rubric self-check

**R1 — one file + one line, zero consumer edits.**
- New file: `kinds/notify.ts` (§1.1) — schema, caps, ports, fields,
  `validateConfig`, `summary`, `run`.
- Registration: one array element in `kinds/registry.ts` `NODE_KINDS`.
- Zero edits: `validate.ts` (invariants are capability/`validateConfig`
  driven, §4.1), `compile.ts` (capability filters, §4.2), `catalogue.ts`
  (palette derived, §3), `engine/graph.ts` (`kindByType[node.type].run`,
  §4.4), `inspector.tsx` (generic renderer, §4.4). Only conditional extra
  line: a brand-new accent colour, one entry in the web accent-token map
  (§4.4).
- **Claim: 2 files touched — 1 created, 1 edited with one line.**

**R2 — type safety survives.**
- `WorkflowNode = z.infer<typeof workflowNodeSchema>` where
  `workflowNodeSchema = z.discriminatedUnion('type', ...MEMBER_SCHEMAS)` built
  from `NODE_KINDS` (§2.2) — a genuine discriminated union; narrowing at
  `node.type === 'action'` works as today.
- Per-kind narrowing inside the class: `NodeOf<this> = Extract<WorkflowNode,
  { type: K['type'] }>` (§2.1); `ActionKind.run(node: NodeOf<this>)` sees
  `config.command: string` with no cast, no `any`, no `as` at call sites.
  Call-site typing flows through the erased `AnyNodeKind` via method
  bivariance; the registry construction makes runtime pairing total.
- Known `as`-free-by-construction helpers: `withFieldValue` (typed
  `next[field] = value` assignment, no cast); the single sanctioned
  boundary-cast is `NodeKind.emptyNode`'s assembly, immediately re-validated
  by the kind's own `configSchema.parse`.

**R3 — capability-driven invariants.** `NodeCapabilities` (§2.1) is the whole
vocabulary: `startsRun`, `terminal`, `providesPolicy`, `providesApproval`,
`requiresPolicy`, `mayAffectPay`, `producesOutput`. Every existing validator
rule and compile-time grouping is expressed as a query over these (§2.3,
§4.1, §4.2). A new kind that "produces pay impact" declares
`{ requiresPolicy: true }` and dynamic `mayAffectPay` from its command —
`ACTION_WITHOUT_POLICY` and `PAY_ACTION_WITHOUT_APPROVAL` then apply to it
with zero validator code.

**R4 — single-sourced references.** One parser (`parseTemplateExpression`),
one resolver (`resolveTemplate`/`resolveTemplates`), one static validator
(`validateTemplateReference`), fanned out over `kind.templatesOf(node)` for
every kind that declares fields (§2.4). Trigger-root paths are checked
against `context.eventSchemaOf(trigger.config.eventType)` — the zod schema
from `eventDefinitions` (§2.4); upstream output paths against the upstream
kind's `outputSchema` when declared.

**R5 — reader load.** "Where do this kind's rules live?" → one file:
`kinds/<kind>.ts` (plus base for cross-kind invariants). "How do I add one?"
→ copy a kind file, change facts, add one registry line. No parallel tables:
the palette, ports, type enum, and union are all derived from the registry;
`catalogue-data.ts` is data-only and cannot drift against behaviour.

**R6 — honest diff accounting.**
- *Today*, adding a node kind touches **9 files** (1 new executor + 8 edits):
  `dsl.ts` (enum + schema + union + aliases + legal-ports entry, ~20 ln),
  `catalogue.ts` (palette entry, ~6), `validate.ts` (4 sites: ports,
  authority, configs, templates, ~40), `compile.ts` (if a GraphSpec group
  applies, ~4), `engine/graph.ts` (import + case, ~4), **new**
  `engine/nodes/<kind>.ts` (~60–150), `inspector.tsx` (switch case, ~30–60),
  `palette.tsx` (icon entry), `state.ts` (summary + default, ~20) —
  **≈ 180–320 lines**, depending on the kind.
- *After this design*: **2 files** — new `kinds/notify.ts` (~70–120 ln,
  including the executor body that today would be a separate engine file)
  + the one registry line. ≈ 80–120 lines.
- *Converting the seven existing kinds*: **≈ 21 files** — new: `kinds/`
  (base, registry, runtime ports, 7 kind files, `catalogue-data.ts` split);
  edited: `dsl.ts` (rewrite to derivations, ≈ −120), `validate.ts`
  (≈ −60), `compile.ts` (≈ ±6), `catalogue.ts` (−~70 palette literal),
  `engine/graph.ts` (−~20), `engine/domain-clients.ts` (implements ports),
  `engine/state.ts` + `engine/nodes/*` (7 files **deleted**, bodies moved),
  `inspector.tsx` (≈ −400: hand JSX → generic renderer), `palette.tsx`
  (−~10), `state.ts` (−~40), `index.ts` (re-exports). Net LOC: clearly
  negative (the inspector collapse dominates); the exact figure belongs to
  the implementation PR, these are scoped estimates from the line counts of
  the files I read.
