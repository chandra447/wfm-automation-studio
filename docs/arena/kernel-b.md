# Kernel Design — Candidate B: data descriptors first, classes only where polymorphism pays

Every node kind is **one declarative descriptor object** — schema, ports, capabilities, palette
entry, inspector field list, canvas summary, kind-local config rules — held in a single registry
table. Behaviour is supplied as plain functions referenced by (or stored on) the descriptor. The
only reserved interface is the **executor boundary** in the engine, where a genuine second
implementation exists per kind and where the runtime must dispatch on something it does not
statically know.

The reference mechanism is a standalone **parser / resolver / static-checker trio** driven entirely
by which descriptor fields are marked template-bearing. Nothing about it knows what an "action"
node is.

---

## 1. Caller usage first

### 1.1 What a developer writes to add a new node kind

A `notify` kind that posts a message and never moves pay. **Two new files, two one-line
registrations, zero edits to the validator, compiler, catalogue, engine dispatch, or React
inspector.**

File 1 — the descriptor, `packages/workflows/src/kinds/notification.ts`:

```ts
import { z } from 'zod';
import { defineKind, type Field } from './types.ts';
import { commandCatalog } from '../catalogue.ts';

const configSchema = z.object({
  channel: z.enum(['email', 'webhook', 'timeline_note']),
  message: z.string().min(1),                    // template-bearing: inline strings
  recipients: z.array(z.string()).min(1),        // template-bearing: whole values
});

const fields = [
  {
    key: 'channel',
    label: 'Channel',
    control: { kind: 'select', options: [
      { value: 'email', label: 'Email' },
      { value: 'timeline_note', label: 'Run timeline note' },
    ] },
    get: (c: Config) => c.channel,
    set: (c: Config, channel: Config['channel']) => ({ ...c, channel }),
  },
  {
    key: 'message',
    label: 'Message',
    hint: 'May use {{input.payload.x}}, {{nodes.<id>.output.<path>}}, {{now+4h}}.',
    control: { kind: 'textarea', rows: 4 },
    get: (c: Config) => c.message,
    set: (c: Config, message: string) => ({ ...c, message }),
  },
  {
    key: 'recipients',
    label: 'Recipients',
    control: { kind: 'templateMap', rowsFor: (c, catalog) => recipientRowsFor(c, catalog) },
    get: (c: Config) => c.recipients,
    set: (c: Config, recipients: string[]) => ({ ...c, recipients }),
  },
] as const satisfies readonly Field<Config>[];

type Config = z.infer<typeof configSchema>;

export const notificationKind = defineKind({
  type: 'notification',
  schema: configSchema,
  ports: ['always'],
  capabilities: { producesOutput: true, templateSource: true },   // no pay, no policy, not terminal
  palette: {
    label: 'Notification',
    description: 'Sends a templated message on the channel you pick.',
    accent: 'cyan', icon: '✉', defaultLabel: 'Notify',
  },
  defaultConfig: { channel: 'timeline_note', message: '', recipients: [] },
  summary: (c) => `${c.channel} · ${c.recipients.length} recipient(s)`,
  fields,
  // Kind-local rules only — the platform invariants (authority, ports, cycles,
  // reachability, terminals, templates) are written once in validate.ts.
  configRules: [(c, ctx, report) => { /* e.g. recipients non-empty after templates */ }],
  templates: {
    slots: (c) => [
      { field: 'message', template: c.message, mode: 'inline' },
      { field: 'recipients', template: c.recipients.join(','), mode: 'whole' },
    ],
  },
});
```

The two registration lines:

```ts
// packages/workflows/src/kinds/registry.ts  (the single table)
export const kindRegistry = {
  trigger: triggerKind,
  /* …the seven existing kinds… */
  notification: notificationKind,   // ← registration line 1
};

// services/studio-api/src/engine/executors/index.ts
export const executors: ExecutorTable = {
  trigger: runTriggerNode,
  /* … */
  notification: runNotificationNode,   // ← registration line 2
};
```

That is the entire change. The compiler will refuse to build `executors` (typed as
`ExecutorTable`, a mapped type over every registered kind) until the new kind has an executor,
and the derived `WorkflowNode` union already contains the kind, so every existing generic surface
— palette, inspector, validator, compiler — picks it up.

### 1.2 What a workflow author writes to use a reference

Unchanged surface, wider reach. Any field a kind marked template-bearing accepts references:

```
{{input.payload.shiftId}}             the trigger event's payload — statically checked
{{input.eventType}}                   an envelope field (allowlisted envelope root)
{{nodes.rank_candidates.output.scores}}  an upstream node's output — must run before
{{now+4h}} | {{now-30m}}              computed timestamp
```

At save time the static checker parses every template in every declared slot of every kind and
verifies: the form exists, the referenced node exists and is upstream, the referenced kind
actually produces output, and `payload.*` paths exist on the trigger event's JSON Schema
(already published by `triggerCatalog()` in `@wfm/contracts`).

---

## 2. Type sketch

```ts
// packages/workflows/src/kinds/types.ts
import { z } from 'zod';
import type { EdgePort } from '../dsl.ts';

/** What a kind IS — the only thing platform invariants ever look at. */
export interface NodeCapabilities {
  /** Exactly one node with this flag; nothing may target it; supplies the run's input. */
  readonly isTrigger?: boolean;
  /** Ends a path; no outgoing edges; satisfies reachability/terminality. */
  readonly terminal?: boolean;
  /** Satisfies "guardrails on the path" for downstream mutators. */
  readonly providesPolicy?: boolean;
  /** Satisfies "human decided" for downstream pay-impacting mutators. */
  readonly providesApproval?: boolean;
  /** Unconditionally mutates a domain service. */
  readonly mutatesDomain?: boolean;
  /**
   * May move pay. Static `true` for kinds where it is unconditional; a function for
   * kinds (like `action`) where it depends on config (which command is chosen).
   */
  readonly payImpact?: boolean;
  readonly payImpactOf?: <C>(config: C, context: PayImpactContext) => boolean;
  /** Executors record a node output downstream references may read. */
  readonly producesOutput?: boolean;
  readonly templateSource?: boolean;
}

/** Inspector controls — a closed set, rendered by ONE generic component. */
export type Control<V> =
  | { kind: 'text' | 'textarea'; maxLength?: number; rows?: number; placeholder?: string }
  | { kind: 'number'; min?: number; max?: number; integer?: boolean }
  | { kind: 'select'; options: readonly { value: V; label: string }[] }
  | { kind: 'switch' }
  | { kind: 'checklist'; options: readonly { value: V; label: string }[] }
  | { kind: 'conditions' }                              // reuses ConditionEditor
  | { kind: 'templateMap'; rowsFor: (config: V, catalog: CatalogContext) => readonly TemplateRow[] };

export interface Field<Config> {
  readonly key: string;               // stable coalesce key
  readonly label: string;
  readonly hint?: string;
  readonly control: Control<unknown>; // narrowed per field by the satisfies check
  readonly get: (config: Config) => unknown;
  readonly set: (config: Config, value: unknown) => Config;
  readonly visible?: (config: Config) => boolean;
}

/** One resolvable slot on one kind. `whole`: exact single ref keeps the raw value. */
export interface TemplateSlot {
  readonly field: string;
  readonly template: string;
  readonly mode: 'inline' | 'whole';
}

export interface ConfigRule<Config> {
  (config: Config, context: ValidationContext, report: (d: KindDiagnostic) => void): void;
}

export interface NodeKind<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly type: string;
  /** The kind's CONFIG schema. defineKind wraps it into the full node schema. */
  readonly schema: S;
  readonly ports: readonly EdgePort[];
  readonly portPolicy: {
    readonly required?: readonly EdgePort[];      // missing → error
    readonly recommended?: readonly EdgePort[];   // missing → warning
  };
  readonly capabilities: NodeCapabilities;
  readonly palette: { label: string; description: string; accent: string; icon: string; defaultLabel: string };
  readonly defaultConfig: z.output<S>;
  readonly summary: (config: z.output<S>) => string;
  readonly fields: readonly Field<z.output<S>>[];
  readonly configRules?: readonly ConfigRule<z.output<S>>[];
  readonly templates?: { slots: (config: z.output<S>) => readonly TemplateSlot[] };
  readonly nodeSchema: z.ZodDiscriminatedUnionMember<'type'>;  // built by defineKind
}

export function defineKind<const S extends z.ZodTypeAny, T extends string>(
  kind: NodeKindInput<S, T>,
): NodeKind<S> & { type: T } {
  const nodeSchema = z.object({
    id: nodeIdSchema,
    type: z.literal(kind.type),
    label: z.string().min(1).max(80),
    config: kind.schema,
  });
  return { ...kind, nodeSchema } as const; // defineKind is the validation boundary
}
```

The registry is where the discriminated union is **rebuilt**, not re-declared:

```ts
// packages/workflows/src/kinds/registry.ts
export const kindRegistry = {
  trigger: triggerKind,
  condition: conditionKind,
  ai_decision: aiDecisionKind,
  policy_check: policyCheckKind,
  human_approval: humanApprovalKind,
  action: actionKind,
  end: endKind,
};

export type NodeKindTable = typeof kindRegistry;
export type WorkflowNodeType = keyof NodeKindTable & string;

/** Assembled once; the runtime and static type come from the SAME schema object. */
export const workflowNodeSchema = z.discriminatedUnion(
  'type',
  Object.values(kindRegistry).map((kind) => kind.nodeSchema),
);

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
// → discriminated union on `type`; `node.config` narrows per member. No `any`, no casts.

/** Total lookup — replaces `legalPortsByNodeType[node.type as WorkflowNodeType]`. */
export function kindOf(node: WorkflowNode): NodeKindTable[WorkflowNodeType] {
  return kindRegistry[node.type];
}

export const legalPortsByNodeType = Object.fromEntries(
  Object.entries(kindRegistry).map(([type, kind]) => [type, kind.ports]),
) as { [K in keyof NodeKindTable]: readonly EdgePort[] };

export const nodePalette = Object.values(kindRegistry).map((kind) => kind.palette);
```

The executor boundary — the one reserved interface, because a second implementation genuinely
exists per kind:

```ts
// services/studio-api/src/engine/executors/types.ts
import type { WorkflowNode, WorkflowNodeType } from '@wfm/workflows';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from '../nodes/context.ts';

export interface NodeOutcome extends Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'> {}

export type NodeExecutor = (
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
  state: RunStateFields,
) => Promise<NodeOutcome>;

export type ExecutorTable = { [K in WorkflowNodeType]: NodeExecutor };
```

Per-kind config narrowing at the boundary without casts — a generic type-predicate helper in
`@wfm/workflows`:

```ts
export function isNode<K extends WorkflowNodeType>(
  node: WorkflowNode,
  type: K,
): node is Extract<WorkflowNode, { type: K }> {
  return node.type === type;
}

// inside an executor — narrowed config, no cast, no `any`:
export async function runNotificationNode(scope, deps, node, state): Promise<NodeOutcome> {
  if (!isNode(node, 'notification')) throw new Error(`notification executor got ${node.type}`);
  const slots = notificationKind.templates!.slots(node.config);   // config is Config
  const resolved = resolveSlots(slots, runScopeOf(state));
  // ...
}
```

Dispatch needs no narrowing and no switch, because the executor signature accepts the union:

```ts
// graph.ts — written once, never edited per kind
const executor = executors[node.type];      // total lookup, Record<WorkflowNodeType, …>
return executor(scope, deps, node, state);
```

The seven per-kind aliases (`TriggerNode`, `ActionNode`, …) stay exported, now derived:

```ts
export type ActionNode = Extract<WorkflowNode, { type: 'action' }>;
```

---

## 3. Module map

```
packages/workflows/src/
  dsl.ts                 nodeIdSchema, edgePortSchema, workflowEdgeSchema,
                         workflowDefinitionSchema, NODE_WIDTH/HEIGHT.
                         LOSES: workflowNodeTypeSchema, the 7 kind schemas, the union,
                         legalPortsByNodeType. Reads: nothing new.
  kinds/
    types.ts             NodeKind, NodeCapabilities, Field, Control, TemplateSlot,
                         defineKind, isNode. Read by: every kind file, validate,
                         compile, engine executors.
    registry.ts          kindRegistry (THE table), workflowNodeSchema,
                         WorkflowNode, WorkflowNodeType, legalPortsByNodeType
                         (derived), nodePalette (derived).
                         Read by: validate.ts, compile.ts, catalogue re-export,
                         @wfm/workflows index → API, engine, canvas.
    trigger.ts … end.ts  7 descriptor files. Each: config schema, ports, portPolicy,
                         capabilities, palette entry, defaultConfig, summary,
                         inspector fields, configRules, template slots.
                         Read by: registry.ts only.
  references/
    grammar.ts           TEMPLATE_PATTERN, parseTemplateExpression, TemplateReference,
                         parseSlots, referencedNodeIds. Read by: resolve, static-check,
                         engine executors. (The body of today's templates.ts, split.)
    resolve.ts           TemplateScope, buildRunScope(state), resolveSlots (generalises
                         resolveTemplateMap + resolveTemplate). Read by: engine executors,
                         canvas preview.
    static-check.ts      validateReferences(node, kind, graph, ctx): form validity,
                         node existence, upstream-ness, source-produces-output,
                         payload-path-vs-trigger-JSON-Schema. Read by: validate.ts.
  validate.ts            Platform invariants ONLY, written once against capabilities:
                         ports (via portPolicy), cycles, reachability, terminals,
                         authority (mutatesDomain / providesPolicy / providesApproval /
                         payImpact), templates (delegates to static-check for every
                         kind with slots), schema-parse errors, trigger-count.
                         LOSES: the per-kind if-chains and the action-only template gate.
  compile.ts             GraphSpec producer. One-time edit: capability-driven filters.
                         Reads: registry capabilities.
  catalogue.ts           CommandDescriptor/ToolDescriptor catalogues (domain data, not
                         kind metadata — read by ValidationContext, the action kind's
                         rowsFor, ai_decision configRules) + portLabels.
                         LOSES: nodePalette, kind-specific label tables.
  index.ts               Public surface; unchanged imports for all consumers.
```

Engine:

```
services/studio-api/src/engine/
  executors/types.ts     NodeOutcome, NodeExecutor, ExecutorTable.
  executors/index.ts     THE engine map; one line per kind.
  executors/<kind>.ts    today's nodes/*.ts run* functions, moved; the manual
                         `node.type !== 'x'` guard becomes isNode().
  graph.ts               addNode wiring unchanged; dispatch = executors[node.type];
                         the `specNode.type === 'end'` special case becomes
                         kindRegistry[specNode.type].capabilities.terminal.
```

Studio web:

```
apps/studio-web/components/builder/
  inspector.tsx          ~120 lines: header, label field, delete, then ONE generic
                         <FieldRenderer> loop over kind.fields, capability-driven
                         footer hints (producesOutput → reference hint;
                         payImpact → approval warning). LOSES the 7-arm switch.
  field-renderer.tsx     NEW, written once: renders the closed Control set
                         (text, textarea, number, select, switch, checklist,
                         conditions, templateMap) with typed get/set.
  state.ts               LOSES: accentVarByNodeType (→ derived from palette.accent),
                         nodeSummary (→ kind.summary), defaultNode (→ registry).
                         KEEPS: layout, draft persistence, edge helpers.
  palette.tsx            LOSES paletteIcons (→ palette.icon from the descriptor).
```

---

## 4. How each consumer changes

### `validate.ts`

Every `node.type === 'x'` chain is replaced by a registry lookup. Concrete rewrites:

- `checkPorts`: `legal` comes from `kind.ports` (kills the `as WorkflowNodeType` cast and the
  `as never` includes-check). The condition/policy "must wire both ports" arms become
  `kind.portPolicy.required` loops; the approval `rejected` warning becomes `recommended`.
  `end` no-outgoing → `capabilities.terminal && usedPorts.length > 0`;
  `trigger` no-incoming → `capabilities.isTrigger && incoming > 0`. Messages keep their codes.
- `checkAuthority` becomes: for every node whose kind has `mutatesDomain`, enumerate
  trigger→node paths and require `providesPolicy` on every path (today's
  `ACTION_WITHOUT_POLICY` — every action is a mutator, behaviour identical), and require
  `providesApproval` on every path when `payImpactOf(node, ctx)` is true (today's
  `PAY_ACTION_WITHOUT_APPROVAL`). The `UNKNOWN_COMMAND` / `MISSING_INPUT` tails move into the
  action kind's `configRules` — they are kind-local concerns (which catalogue an action reads).
- `checkTemplates` becomes a loop over nodes whose kind declares `templates`, delegating to
  `references/static-check.ts`; the upstream-cache walk is unchanged. New capability check:
  a reference to a node whose kind has `producesOutput !== true` is an error
  (`TEMPLATE_SOURCE_INVALID`).
- `checkNodeConfigs`: the zod schema-parse stays (assembled union). The per-kind if-blocks
  (unknown tool, long-approval warning) move into `ai_decision` / `human_approval`
  `configRules`. `UNKNOWN_EVENT` stays — trigger config is checked against
  `context.eventTypes`, driven by the trigger kind's `configRules`.
- New kinds never appear in this file again. A hypothetical `bulk_reschedule` kind that declares
  `mutatesDomain: true` inherits the policy/approval coverage invariants with zero new validator
  code; a `notify` kind declares nothing and inherits none.

### `compile.ts`

One-time edits, none per kind:

- `terminals` = nodes whose kind `capabilities.terminal` (was `type === 'end'`).
- `approvalNodeIds` = nodes whose kind `capabilities.providesApproval` (was `human_approval`).
- `actionNodeIds` = nodes whose kind `capabilities.mutatesDomain` (was `type === 'action'`);
  renamed conceptually to "mutatorNodeIds" with `actionNodeIds` kept as the exported field name
  so the API contract is untouched.

### `catalogue.ts` / API surface

`commandCatalog` and `toolCatalog` stay exactly as they are — they are domain data, and the
`action`/`ai_decision` descriptors read them (`rowsFor` for the templateMap control,
`configRules` for unknown-tool checks). `nodePalette` moves to the registry (it is a projection
of `kind.palette`); `@wfm/workflows` index keeps exporting the name so the canvas import is
untouched. The engine's trigger scan in `orchestrator.ts` (`node.type === 'trigger'`) switches to
`kindRegistry[node.type].capabilities.isTrigger` — a one-time conversion, not per-kind.

### Engine dispatch (`graph.ts`, `executors/`)

- The `executeNode` switch is deleted; dispatch is `executors[node.type](scope, deps, node, state)`
  inside the `addNode` callback. `ExecutorTable` is a mapped type over `WorkflowNodeType`, so a
  registered kind without an executor is a **compile error**, not a runtime surprise — the two
  registration lines check each other.
- `if (specNode.type === 'end') { graph.addEdge(id, END) }` becomes
  `if (kindRegistry[specNode.type].capabilities.terminal) { graph.addEdge(id, END) }`.
- `runProposeNode`'s hand-rolled tool switch (`shift.get`, `timesheet.get`, …) does not need to
  change in this design; when it does, it is a per-tool concern inside `executors/ai_decision.ts`,
  reached only by editing that one file. The action executor's `resolveTemplateMap` call becomes
  `resolveSlots(actionKind.templates.slots(node.config), buildRunScope(state))` — same semantics,
  including whole-value splicing and array coercion.

### React inspector and palette

- `inspector.tsx` loses its 7-arm switch and every per-kind UI block. It renders: header (accent
  + type name + delete), the shared Label field, then `kind.fields.map(f => <FieldRenderer …>)`
  where `FieldRenderer` is one generic component with a closed `Control` discriminated union and
  typed `get`/`set`. Footer hints become capability-driven: `producesOutput` → the
  "downstream can read {{nodes.<id>.output…}}" hint; `payImpact === true` → the approval warning
  banner (today this is the `command.payAffecting` paragraph; for `action` the banner is driven
  by `payImpactOf(config, catalog)` inside a field's `visible`).
- Coverage proof that the closed control set is sufficient: walking today's inspector arm by arm,
  all seven kinds decompose into the eight controls — trigger (select + conditions), condition
  (text + conditions), ai_decision (textarea + checklist + select + switch), policy_check
  (checklist + number + switch), human_approval (text ×2 + number + checklist), action (select +
  templateMap), end (select). No new React component per kind.
- `palette.tsx`'s `paletteIcons` table dies; the icon lives in `kind.palette.icon`.
  `builder-node.tsx`'s `typeLabels` and `nodeSummary` switch in `state.ts` are replaced by
  `kind.palette.defaultLabel` and `kind.summary(config)`. `accentVarByNodeType` in `state.ts`
  becomes a projection `var(--color-node-${kind.palette.accent})`, so `canvas.tsx`'s lookup name
  survives unchanged.
- `defaultNode` in `state.ts` collapses to `{ ...kind.defaultNode(id) }` — the default label and
  config come from the descriptor.

### Persisted data

The registry-assembled union contains exactly the current seven members with identical shapes
(`id` / `type` / `label` / `config`), so **no migration is required**: every stored workflow
definition parses byte-for-byte as before. `z.toJSONSchema` of the assembled definition is
unchanged. Later kinds are pure union *additions* — older data still parses. The only visible
delta is one diagnostic code: the approval "no rejected path" warning generalises to
`PORT_MISSING_RECOMMENDED` (no test pins the old code).

---

## 5. Rationale — alternatives considered and rejected

**Class hierarchy per kind (abstract `NodeKind` base, subclasses override).** Rejected. The
descriptor is static, declarative, tree-shaped data — inheritance adds a construction protocol
(`super()` calls for schema composition), a name-shadowing hazard (`this.ports` vs the table),
and an extra indirection between "where is the schema" and "here". A table entry with function
fields gives identical polymorphism at the two points that actually dispatch on kind (the
generic inspector and the capability-driven validator) with zero ceremony. The one place where
*many implementations behind one contract* genuinely exists is execution, so that is the one
place an interface is reserved — as a function type, not a class, because executors have no
state or lifecycle of their own.

**Per-kind React components registered in a map.** Rejected. It satisfies "no switch" but fails
rubric #1 in spirit: a new kind still means authoring a component, and reader load goes *up*
(N files of JSX instead of one field list). The closed control set covers all seven existing
kinds (verified arm-by-arm above), which is the evidence that the declarative field list is the
right granularity. If a future kind truly needs a bespoke editor, the `Control` union can gain a
`{ kind: 'custom'; render: … }` member — one generic renderer change, not a registry of
components — but I did not add it now because no current kind needs it.

**Zod metadata (`z.string().meta({ template: true })`) to mark template-bearing fields.**
Rejected. The marker is invisible at the call site, survives transforms unpredictably, and makes
"which fields resolve templates" ungreppable. An explicit `templates.slots(config)` function on
the descriptor is typed, greppable, and testable — it also lets a kind derive slots from *other*
config (action derives its whole map from the chosen command's `inputs`), which a path-based
annotation cannot express.

**String-path field access (`'config.input'`) with a `get(config, path)` helper.** Rejected —
it needs `any` or casts to type-check, which the constraints forbid. Typed accessors (`get`/
`set` closures) are slightly more verbose per field but keep strict mode honest, and they are
the same shape the existing inspector already uses when it spreads `{ ...node.config, field }`.

**Deriving `WorkflowNode` from the mapped registry type instead of `z.infer` of the assembled
union.** Both work; I chose `z.infer` because it makes the runtime schema and the static type
literally the same object — the discriminated-union guarantee cannot drift from the validator's
schema-parse step. The mapped-type derivation would have been one less runtime dependency but
creates a second thing to keep in sync, which is exactly the disease this design removes.

**Keeping `checkAuthority`'s "every action needs a policy check" as an action-specific rule.**
Rejected in favour of the capability reading (`mutatesDomain` ⇒ guardrails on every path). The
behaviour for existing data is identical — action is the only `mutatesDomain` kind — and a new
mutating kind inherits the invariant for free, which is the entire point of rubric #3. The
kind-specific *identity* checks that are NOT platform invariants (unknown tool, unknown command,
missing required input) stay with the kind as `configRules`, because generalising them (a
generic "referencedCatalog" pointer table) would add a parallel table to keep in sync — the
thing rubric #5 forbids.

**Single registration line via runtime self-registration (side-effectful `registerKind()`
imports).** Rejected. It trades one visible table line for invisible import-order coupling, and
it breaks tree-shaking and test isolation. Two adjacent, statically checked lines — one in the
workflows table, one in the engine map — are the honest minimum given that the descriptor and
its executor live in different deployment units (the workflows package deliberately knows
nothing about Redis, Postgres, or domain clients).

**Residual honesty on rubric #1's "one file":** the literal claim "one new file plus one
registration line" cannot be true across a two-package boundary without either a side-effect
registration hack (rejected above) or leaking engine types into the DSL package (rejected by
the repo's own architecture comment). The design gets **2 new files + 2 one-line registrations,
0 edits elsewhere**; the rubric's numbers hold *per package*.

---

## 6. Rubric self-check

**1. File count.** Adding a node kind = 2 new files (`kinds/<kind>.ts` descriptor,
`executors/<kind>.ts` executor) + 2 one-line registrations (`kinds/registry.ts` table line,
`executors/index.ts` map line). Zero edits to `validate.ts`, `compile.ts`, `catalogue.ts`,
`graph.ts` (dispatch and terminal routing are both capability-driven lookups written once),
`inspector.tsx`, `palette.tsx`, `state.ts`. The lines that make dispatch edit-free:
`executors[node.type](scope, deps, node, state)` and
`kindRegistry[specNode.type].capabilities.terminal` in `graph.ts`; the inspector is
`kind.fields.map(<FieldRenderer>)`. Missing executor = compile error via
`type ExecutorTable = { [K in WorkflowNodeType]: NodeExecutor }`.

**2. Type safety.** `WorkflowNode = z.infer<typeof workflowNodeSchema>` where the union is
assembled from `kindRegistry` — a discriminated union on `type` with per-member `config`
narrowing derived from each kind's zod schema. No `any`; the only former casts
(`node.type as WorkflowNodeType`, `port as never`, inspector's manual `raw === 'x' || …`
narrowing) are eliminated by total registry lookup, `EdgePort[]` typing, and typed
select/checklist options. Crossing the executor boundary is cast-free via the
`isNode(node, 'notification')` type predicate (`node is Extract<WorkflowNode, {type: K}>`).

**3. Capability-driven invariants.** `checkAuthority` reads only `mutatesDomain`,
`providesPolicy`, `providesApproval`, and `payImpact`/`payImpactOf`; `checkPorts` reads
`ports`/`portPolicy`/`terminal`/`isTrigger`; `checkTerminals`, compile's group filters, and
`graph.ts`'s END routing read `terminal`. A new kind declaring `mutatesDomain: true` inherits
policy-approval coverage with no new validator code.

**4. Single-sourced references.** One parser (`grammar.ts`), one resolver (`resolve.ts`,
`resolveSlots` generalising `resolveTemplateMap`), one static checker (`static-check.ts`) that
any kind with `templates.slots` gets automatically. `payload.*` paths are validated against the
trigger event's JSON Schema, which `ValidationContext` sources from `triggerCatalog()` (already
publishes `jsonSchema` per event — verified in `packages/contracts/src/catalog.ts`).

**5. Reader load.** Today, understanding one kind end-to-end means opening 7 files
(`dsl.ts`, `catalogue.ts`, `validate.ts` — two separated if-chains, `graph.ts`,
`inspector.tsx` — up to ~100 lines inside a 624-line file, `state.ts` — three switches,
plus the executor). After: **2 files** — the descriptor, which contains the schema, ports,
capabilities, palette entry, inspector fields, summary, and kind-local rules in reading order;
and the executor. "Where do this kind's rules live?" → the descriptor file.
"How do I add one?" → copy a descriptor, add two lines. No parallel tables remain: `nodePalette`,
`paletteIcons`, `legalPortsByNodeType`, `nodeSummary`, `defaultNode`, `typeLabels`, and the
inspector switch are all deleted or derived.

**6. Diff accounting.** (Line counts for existing files are measured; future counts are
estimates and marked.) **Today**, adding a kind touches 8 files: `dsl.ts` (enum + schema +
union + exports + legalPorts, ~35 lines), `catalogue.ts` (~10), `validate.ts` (~15–30 across
three functions), `graph.ts` (~4), `inspector.tsx` (~60–100), `state.ts` (~40 across three
switches), `palette.tsx` (~8), plus the new executor file — roughly **170–240 scaffolding
lines** across 7 edited + 1 new files. **After the design:** 2 new files, 2 lines, ~0 other
lines — the descriptor is *all* payload, no dispatch scaffolding. **Converting the seven
existing kinds:** ~18 files — `dsl.ts` shrinks (~−80), `validate.ts` (~−90), `compile.ts`
(~−6, +4), `catalogue.ts` (~−60), `templates.ts` → `references/` 3 files (~+20 net), 7 new
descriptor files (+~450, mostly transplanted content), `kinds/types.ts` + `registry.ts`
(+~200), engine `executors/` reorganisation (~±0), `inspector.tsx` (624 → ~150, −~470),
`field-renderer.tsx` (+~180), `state.ts` (−~100), `palette.tsx`/`builder-node.tsx` (−~30).
Net ≈ **−150 to −250 lines** while removing all seven kind-specific branch sites — the
conversion is net code deletion, which is the strongest available signal that the machinery
earns its place.
