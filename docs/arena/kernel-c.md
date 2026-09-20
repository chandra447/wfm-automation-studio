# Kernel C — capability registry, kind-agnostic rules

One file per node kind declares everything that kind is: its zod schema, its ports, its
capabilities, and (for the canvas) its field controls. Platform invariants are rules registered
against **capabilities**, not kinds, so an invariant is written once and automatically covers every
future kind that claims the capability. Template-bearing fields are declared the same way, so the
single reference parser/resolver/validator applies to every kind that opts in — including kinds the
validator has never heard of.

---

## 1. Caller usage first

### 1.1 Adding a node kind (e.g. a `notify` node that renders and sends a notification)

**File 1 — `packages/workflows/src/kinds/notify.ts`** (the only *new* file):

```ts
import { z } from 'zod';
import { defineNodeKind } from '../kinds/index.ts';

const notifyNodeSchema = z.object({
  id:    nodeIdSchema,
  type:  z.literal('notify'),
  label: z.string().min(1).max(80),
  config: z.object({
    channel: z.enum(['inbox', 'email']),
    subject: z.string().min(1).max(200),                       // template-bearing
    body:    z.string().min(1),                                // template-bearing
  }),
});

export type NotifyNode = z.infer<typeof notifyNodeSchema>;

export const notifyKind = defineNodeKind('notify', notifyNodeSchema, {
  icon: '✉',
  accent: 'lime',
  ports: {
    legal: ['always'],
  },
  capabilities: {
    produces_output: {},          // downstream may read {{nodes.<id>.output.*}}
    // NOT mutates_domain, NOT provides_policy/provides_approval, NOT terminal.
    // Because this kind claims no authority capability, the authority rules skip it.
  },
  fields: [
    { name: 'channel', control: 'select',
      options: [{ value: 'inbox', label: 'Inbox message' }, { value: 'email', label: 'Email' }] },
    { name: 'subject', control: 'text', template: true, max: 200 },
    { name: 'body',    control: 'textarea', template: true },
  ],
  summary: (node) => `${node.config.channel}: ${node.config.subject}`,
});
```

**File 2 — `services/studio-api/src/engine/nodes/notify.ts`** (executor for the kind):

```ts
export async function runNotifyNode(node: NotifyNode, scope: RunScope, deps: ExecutorDeps, state: RunStateFields) {
  const rendered = resolveDeclaredTemplates(node, scope);   // one shared resolver call
  // ... render subject/body, send, audit, return { nodes, cursor, decision }
}
```

**Registration — two one-line entries, nothing else in the repo:**

```ts
// packages/workflows/src/kinds/index.ts   ← the "one registration line" for metadata
export const nodeKinds = { trigger: triggerKind, /* …4 existing… */, notify: notifyKind } as const;
```

```ts
// services/studio-api/src/engine/nodes/index.ts  ← the "one registration line" for execution
export const executors: Record<NodeType, Executor> = {
  /* …existing… */
  notify: asExecutor('notify', runNotifyNode),   // one line; adds dispatch for the kind
};
```

Zero edits: `validate.ts`, `compile.ts`, `catalogue.ts`, `engine/graph.ts`, `inspector.tsx`,
`palette.tsx`, `state.ts`. The palette reads the registry; the inspector renders the kind's
`fields`; the validator applies its capability-keyed rules; the compiler buckets by capability.

### 1.2 Using a reference as a workflow author (unchanged syntax, wider coverage)

```jsonc
// notify node config, written in the inspector — the same syntax action nodes use today
{
  "channel": "inbox",
  "subject": "Cover {{input.payload.shiftId}} on {{nodes.rank.output.bestShiftId}}",
  "body":    "Unfilled {{input.payload.hoursUntilStart}}h before start; propose by {{now+4h}}."
}
```

Three forms, one parser, one resolver, one validator (`templates.ts`):

| Form | Resolves to | Statically checked against |
|---|---|---|
| `{{input.<path>}}` | the trigger event envelope | the trigger event's **zod payload schema** (`@wfm/contracts` event registry) for paths under `payload.` |
| `{{nodes.<id>.output.<path>}}` | an upstream node's output | node exists, is **upstream** of the referencing node, and — when the producing kind declares `outputSchema` — path existence in that schema |
| `{{now±Nm\|h}}` | a computed ISO timestamp | grammar only |

A kind opts in per field with `template: true` on its field descriptor (and/or a
`templates: (config) => Record<string, string>` accessor). The generic save-time check walks
**every** node, collects every declared template string, and validates it — the validator never
switches on the node kind.

---

## 2. Type sketch

### 2.1 Capabilities and kind declarations

```ts
// packages/workflows/src/kinds/capabilities.ts

/** What a node kind IS, in the only vocabulary the shared rules speak. */
export type CapabilityName =
  | 'entry'              // exactly one per definition; graph starts here; no incoming edges
  | 'terminal'           // ends a path; nothing may leave it
  | 'produces_output'    // downstream nodes may reference {{nodes.<id>.output.*}}
  | 'provides_policy'    // deterministic guardrail; satisfies the policy invariant on a path
  | 'provides_approval'  // human decision; satisfies the approval invariant on a path
  | 'mutates_domain';    // writes to a domain service; SUBJECT of the authority invariants

/** Typed per-capability data that invariant rules may read (no `any`). */
export interface CapabilityData {
  entry:             Record<string, never>;
  terminal:          Record<string, never>;
  produces_output:   { readonly outputSchema?: z.ZodType<unknown> };
  provides_policy:   Record<string, never>;
  provides_approval: Record<string, never>;
  mutates_domain:    { readonly payAffecting: boolean };
}

export type CapabilityHolding<C extends CapabilityName> = { readonly data?: CapabilityData[C] };
export type CapabilityDecls = { [C in CapabilityName]?: CapabilityHolding<C> };
```

```ts
// packages/workflows/src/kinds/index.ts

export interface NodeKind<N extends WorkflowNode> {
  readonly type: N['type'];
  readonly schema: z.ZodType<N>;
  readonly label: string;
  readonly icon: string;
  readonly accent: AccentName;
  readonly ports: {
    /** Legal outgoing edge ports. Empty = nothing may leave (terminal/entryless kinds). */
    readonly legal: readonly EdgePort[];
    /** Ports that must be wired, with the save-time error message. */
    readonly required?: ReadonlyArray<{ readonly port: EdgePort; readonly message: string }>;
    /** Ports that should be wired (warning if missing). */
    readonly soft?: ReadonlyArray<{ readonly port: EdgePort; readonly message: string }>;
  };
  readonly capabilities: CapabilityDecls;
  /** Per-kind config validation beyond the zod schema; returns diagnostics, never throws. */
  readonly validate?: (node: N, context: ValidationContext) => Diagnostic[];
  /** Canvas fields; the React inspector renders these generically. */
  readonly fields: ReadonlyArray<FieldSpec<N>>;
  readonly summary: (node: N) => string;
  readonly defaults: (id: string) => WorkflowNode;   // what "add node of this kind" creates
}

export function defineNodeKind<const T extends string>(
  type: T, schema: z.ZodObject<{ type: z.ZodLiteral<T> }> & z.ZodTypeAny, def: …
): NodeKind<NodeFor<T>> { /* registers ports/capabilities; nothing else to wire */ }

/* ── THE registration table: exactly one line per kind ─────────────────────── */
export const nodeKinds = {
  trigger:        triggerKind,
  condition:      conditionKind,
  ai_decision:    aiDecisionKind,
  policy_check:   policyCheckKind,
  human_approval: humanApprovalKind,
  action:         actionKind,
  end:            endKind,
} as const;

export type NodeType = keyof typeof nodeKinds;
export type NodeFor<T extends NodeType> = z.infer<(typeof nodeKinds)[T]['schema']>;
export type WorkflowNode = { [T in NodeType]: NodeFor<T> }[NodeType];
```

`WorkflowNode` **stays a true TypeScript discriminated union** — it is a mapped-indexed projection
of the registry, so it narrows in every `switch (node.type)` exactly as today, and a kind whose
`type` literal disagrees with its registry key fails to compile:

```ts
// kinds/index.ts — compile-time guarantee that registry keys and kind.type agree
type KindKeyMatches = { [T in NodeType]: NodeFor<T> extends { type: T } ? true : never }[NodeType];
const kindKeysMatch: KindKeyMatches = true;
```

### 2.2 Capability-keyed invariant rules (the validator's only authority logic)

```ts
// packages/workflows/src/kinds/invariants.ts

export interface AuthorityRule {
  /** Diagnostic code; existing codes are kept verbatim (ACTION_WITHOUT_POLICY, …). */
  readonly code: string;
  /** Applies to every node whose kind claims this capability. */
  readonly subject: CapabilityName;
  /** This capability must appear on every trigger→subject path. */
  readonly requires: CapabilityName;
  /** Optional filter on the subject's capability data — the ONLY place kind data enters. */
  readonly when?: (data: CapabilityData[CapabilityName]) => boolean;
  readonly message: (node: WorkflowNode) => string;
}

export const authorityRules: readonly AuthorityRule[] = [
  {
    code: 'ACTION_WITHOUT_POLICY',
    subject: 'mutates_domain',
    requires: 'provides_policy',
    message: (n) => `"${n.label}" can change domain state without a policy check on every path.`,
  },
  {
    code: 'PAY_ACTION_WITHOUT_APPROVAL',
    subject: 'mutates_domain',
    requires: 'provides_approval',
    when: (data) => data.payAffecting === true,      // pay-impact is capability DATA, not kind identity
    message: (n) => `"${n.label}" can move pay without a human approval on every path.`,
  },
];
```

The generic loop (in `validate.ts`, written once) applies all rules to all claiming nodes:

```ts
for (const node of definition.nodes) {
  const caps = capabilitiesOf(node);                       // from the registry
  for (const rule of authorityRules) {
    const data = caps[rule.subject];
    if (!data || (rule.when && !rule.when(data))) continue;
    for (const path of pathsTo(graph, node.id)) {
      if (!path.some((id) => capabilitiesOf(graph.byId[id])[rule.requires])) {
        diagnostics.push({ severity: 'error', code: rule.code, message: rule.message(node), nodeId: node.id });
      }
    }
  }
}
```

A new kind that claims `mutates_domain` inherits both rules with **zero validator code**. A new
kind that claims `provides_policy` satisfies them for everyone else with **zero validator code**.

### 2.3 The reference mechanism (one parser, one resolver, one validator)

```ts
// packages/workflows/src/templates.ts — the ONLY place the {{…}} grammar lives
export const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
export type TemplateReference =
  | { kind: 'input'; path: string }
  | { kind: 'node'; nodeId: string; path: string }
  | { kind: 'now'; offsetMinutes: number };

export function parseTemplateExpression(expression: string): TemplateReference | null { /* unchanged */ }
export function resolveTemplate(template: string, scope: TemplateScope): string { /* unchanged */ }

// NEW — path checking against the trigger event's schema (registry in @wfm/contracts)
export function validateEventPath(payloadSchema: z.ZodType, path: string): boolean {
  return walkZodShape(payloadSchema, path.split('.'));   // object .shape, array .element, optional .unwrap()
}

/** Static check used by the validator for ANY kind's declared template fields. */
export function checkTemplateStrings(nodeId: string, origin: string, templates: Iterable<string>, ctx: {
  payloadSchema?: z.ZodType;
  upstreamOf: (nodeId: string) => Set<string>;
  outputSchemaOf: (nodeId: string) => z.ZodType | undefined;
}): Diagnostic[] { /* parse each {{…}}; TEMPLATE_INVALID / TEMPLATE_EVENT_PATH / TEMPLATE_NOT_UPSTREAM / TEMPLATE_OUTPUT_PATH */ }
```

Kinds expose their template-bearing strings and their output contract:

```ts
// kinds/index.ts additions
export interface NodeKind<N extends WorkflowNode> {
  // …
  /** Every string in the node that may contain {{…}} (empty array = no templates). */
  readonly templateStrings?: (node: N) => ReadonlyArray<{ readonly origin: string; readonly template: string }>;
}
```

`action` returns `config.input`'s values; `notify` returns `subject` and `body`; a future kind with
a prompt template returns it. The validator iterates nodes → `templateStrings(node)` →
`checkTemplateStrings`. Runtime resolution is the existing `resolveTemplate` + `resolveTemplateMap`
with one shared `TemplateScope` built by the engine (`input` = event, `nodes` = prior outputs,
`now` = run clock). Nothing else parses `{{…}}` anywhere in the repo.

### 2.4 Canvas field specs (why the inspector needs no per-kind component)

```ts
// packages/workflows/src/kinds/fields.ts
export interface FieldSpec<N extends WorkflowNode> {
  /** Config key, checked against the kind's config at declaration time. */
  readonly name: keyof N['config'] & string;
  readonly control: 'text' | 'number' | 'textarea' | 'select' | 'multiCheck' | 'conditions' | 'templateMap';
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly hint?: string;
  readonly max?: number;
  readonly template?: boolean;   // render the {{…}} hint and allow template expressions
}
```

`studio-web` ships one generic control component per `control` value (7 controls, ~200 lines,
written once) plus a dispatcher that maps `node.type → nodeKinds[node.type].fields → controls`.
The per-kind narrowing inside the kind files is real (`name` is checked against that kind's
config keys); the canvas-side reads values as `unknown` and writes through one helper.

### 2.5 Verified dispatch pattern (the one place TS forces a seam)

TypeScript will not call a union of `(node: N) => …` signatures with a `WorkflowNode` argument
(the parameter types intersect to `never` — verified against `tsc --strict`, zod 3.24, TS 5.6).
The design therefore keeps **one** uniform signature at the table and narrows per kind with a
type predicate, which compiles clean in strict mode:

```ts
// services/studio-api/src/engine/nodes/context.ts
function assertNodeKind<K extends NodeType>(type: K, node: WorkflowNode): asserts node is NodeFor<K> {
  if (node.type !== type) throw new Error(`a ${type} executor reached a ${node.type} node`);
}

type Executor = (node: WorkflowNode, scope: RunScope, deps: ExecutorDeps, state: RunStateFields)
  => Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>>;

function asExecutor<K extends NodeType>(
  type: K,
  run: (node: NodeFor<K>, scope: RunScope, deps: ExecutorDeps, state: RunStateFields) => …,
): Executor {
  return (node, scope, deps, state) => {
    assertNodeKind(type, node);       // narrows node to NodeFor<K> — no `as`, no `any`
    return run(node, scope, deps, state);
  };
}
```

```ts
// engine/graph.ts — executeNode, after the one-time rewrite
async function executeNode(node: WorkflowNode, scope: RunScope, deps: ExecutorDeps, state: RunState) {
  return executors[node.type](node, scope, deps, state);   // uniform signature → no cast
}
```

And `executors` is `Record<NodeType, Executor>` — the second registration table. Each executor
file contributes its line with its own kind literal; the guard preserves the existing
`if (node.type !== 'ai_decision') throw` semantics already present in `propose.ts`.

### 2.6 Registry-derived zod union (wire format unchanged)

```ts
// packages/workflows/src/dsl.ts
export const workflowNodeSchema: z.ZodType<WorkflowNode> = z.union(
  Object.values(nodeKinds).map((kind) => kind.schema) as [z.ZodType<WorkflowNode>, z.ZodType<WorkflowNode>, …z.ZodType<WorkflowNode>[]],
);
```

`z.union` over the per-kind schemas accepts every shape `z.discriminatedUnion` accepted before;
persisted definitions keep parsing byte-for-byte. The one `as` at the array assembly is inside the
schema module — the validation boundary. `WorkflowNodeType` remains `keyof typeof nodeKinds`, so
`edgePortSchema` and all existing enums are untouched.

---

## 3. Module map

| File | Lives there / exports | Consumers |
|---|---|---|
| `packages/workflows/src/kinds/capabilities.ts` | `CapabilityName`, `CapabilityData`, `CapabilityDecls` | kinds, validate, compile |
| `packages/workflows/src/kinds/index.ts` | `NodeKind`, `defineNodeKind`, `nodeKinds`, `NodeType`, `NodeFor`, `WorkflowNode`, `KindKeyMatches` | everyone (below) |
| `packages/workflows/src/kinds/<kind>.ts` ×7 | one file per existing kind: zod schema, ports, capabilities, fields, summary, defaults, validate, templateStrings | registry only |
| `packages/workflows/src/kinds/invariants.ts` | `AuthorityRule`, `authorityRules` | validate |
| `packages/workflows/src/kinds/fields.ts` | `FieldSpec` | studio-web inspector, palette |
| `packages/workflows/src/templates.ts` | grammar, parser, resolver, `validateEventPath`, `checkTemplateStrings` | validate, engine executors |
| `packages/workflows/src/dsl.ts` | edge/definition schemas, `workflowNodeSchema` (derived), `workflowEdgeSchema`, `WorkflowDefinition` | API, web, engine |
| `packages/workflows/src/validate.ts` | generic checks + `authorityRules` loop | engine, API |
| `packages/workflows/src/compile.ts` | `GraphSpec` (buckets via capabilities) | engine |
| `packages/workflows/src/catalogue.ts` | `commandCatalog`, `toolCatalog`, `portLabels` (palette derived from registry) | API, web |
| `services/studio-api/src/engine/nodes/index.ts` | `executors: Record<NodeType, Executor>` + `asExecutor` | graph.ts |
| `services/studio-api/src/engine/nodes/<kind>.ts` | executor per kind (unchanged shape) | executors table |
| `apps/studio-web/components/builder/controls.tsx` | 7 generic field controls (NEW, written once) | inspector |
| `apps/studio-web/components/builder/state.ts` | `accentVarByAccentName` (token map), layout helpers (kind-agnostic) | builder |

Ownership: the kind file owns that kind's rules; the invariants file owns the shared rules; nothing
duplicates anything.

---

## 4. How each consumer changes (one-time conversion only)

- **`validate.ts`** — `checkPorts` collapses to: illegal-port check (from `ports.legal`), required/soft checks (from `ports.required`/`ports.soft`), entry-capability rules (exactly one `entry` node; no incoming edges to an `entry` node — generalizing today's `TRIGGER_*` checks). `checkAuthority` becomes the §2.2 generic loop. `checkNodeConfigs` becomes: per-node `kind.schema` parse (reusing today's `NODE_CONFIG_INVALID` aggregation) + `kind.validate` hook (`UNKNOWN_EVENT`, `UNKNOWN_TOOL`, `LONG_APPROVAL_TIMEOUT` move into trigger/ai_decision/human_approval kind files as `validate` hooks). `checkTemplates` becomes kind-agnostic via `templateStrings` + `checkTemplateStrings`, and additionally validates `{{input.payload.*}}` paths against the trigger event's payload schema and `{{nodes.<id>.output.*}}` paths against the producer's `outputSchema` when declared. Cycles, reachability, terminal-reachability (walk stops at `terminal` capability), upstream-ness: unchanged algorithms.
- **`compile.ts`** — three `filter((n) => capabilitiesOf(n)[…])` calls replace the `node.type === 'end' | 'human_approval' | 'action'` filters. `GraphSpec` shape unchanged; engine consumers untouched.
- **`catalogue.ts`** — `nodePalette` becomes `Object.values(nodeKinds).map((k) => ({ type: k.type, label: k.label, description: k.description, accent: k.accent }))`; `commandCatalog`/`toolCatalog` unchanged. The API passes them through as today; the canvas reads the same exported `nodePalette`.
- **Engine dispatch (`engine/graph.ts`)** — `executeNode` collapses to `executors[node.type](…)` (§2.5). `buildRunGraph`'s END-edge special case keys off `spec.terminals` instead of `type === 'end'`. Executors themselves (`nodes/*.ts`) unchanged apart from registration lines.
- **React inspector (`inspector.tsx`)** — the ~250-line `switch (node.type)` is deleted and replaced by: header (kind icon/accent from registry), shared `Label` field, then `kind.fields.map((field) => <FieldControl …/>)`, then the shared "downstream inputs can read `{{nodes.<id>.output…}}`" note shown whenever the kind claims `produces_output`. `palette.tsx` reads `kind.icon`; `state.ts` maps accent *names* (a static 8-entry token map, no per-kind table) and `nodeSummary`/`defaultNode` call `kind.summary(node)` / `kind.defaults(id)`.

All of this is the one-time cost of the conversion; afterwards, new kinds touch none of it.

---

## 5. Rationale

**Why capabilities are not a pass-through layer.** A pass-through layer is one where a consumer
must write a shim whose only job is forwarding to the next layer — it adds indirection without
removing branches. This design does the opposite, and the arithmetic is checkable in the source
tree today:

- It **deletes** five `if (node.type === …)` chains (`checkPorts`, `checkNodeConfigs`, the palette,
  the inspector, plus the `legalPortsByNodeType` table) rather than adding a layer in front of
  them. Each deleted branch's *content* (a message, a threshold, a port list) moves into the kind's
  declaration, where it was already implicit; nothing forwards anywhere.
- The indirection has exactly one hop and one consumer per rule: rule → capability data. There is
  no "capability service", no base class, no virtual dispatch — `authorityRules` is a flat array of
  three-field records that `checkAuthority` iterates. A maintainer reads §2.2 and knows everything.
- The test for "is this a pass-through" is: does a new kind that reuses existing capabilities write
  any capability code? No — it names them in an object literal. Pass-through layers charge that
  toll; this design's toll is zero.
- The alternative reading — capabilities as a second table that must be kept in sync with kinds —
  is blocked structurally: capabilities, their data types, and the rules are one module; a kind
  claiming an untyped capability fails to compile (`CapabilityDecls` is keyed by `CapabilityName`).

**Alternatives rejected.**

1. *Keep per-kind zod schemas + `z.discriminatedUnion`, add a `capabilities` map beside it.* Two
   parallel tables (kind list in the union, kind list in the capability map) that drift exactly the
   way the six-today places drift. Rejected: the registry must be one table.
2. *Class hierarchy: `abstract class NodeKind` with `validate()`, `ports()`, `execute()`.* Satisfies
   the same rubric lines but adds `instanceof`-shaped indirection, forces the engine to know about
   base-class lifecycle, and can't express the cross-cutting authority rules as data — they'd stay
   methods, i.e. per-kind code. Rejected: more machinery, no fewer branches.
3. *Config-driven predicates (`when`) per rule reading `node.config` directly.* Would put
   `node.config.command` back inside the "kind-agnostic" rule file — the very leak the mandate
   forbids. Rejected: `when` reads only `CapabilityData[subject]`, so pay-impact stays the
   `mutates_domain` kind's own datum (`payAffecting` from `commandCatalog`).
4. *One generic map-over-everything registry entry (`{ schema, run, fields, … }` per kind in a
   single god-file).* Same data, but the file count per kind is 1 edit in a shared file —
   merge-conflict hub, and the kind's executor can't live in the engine package. Rejected.
5. *Validator hooks only (`kind.validate` doing everything).* Would let each new kind re-implement
   the authority rules — precisely what the rubric forbids. The `validate` hook is therefore
   restricted to kind-local config rules; cross-node invariants are capability rules only.
6. *Full-blown event-path JSON Schema validation of `{{nodes.*.output.*}}` for every producer.*
   Deferred unless the producer declares `outputSchema`; tool nodes get theirs from `toolCatalog`
   (zod schemas already exist in `@wfm/contracts`). Mandatory now only where the data already
   exists.

**Backward compatibility.** Per-kind schemas are byte-identical; only the union *wrapper* changes
(`z.discriminatedUnion` → registry `z.union`), and the wire format of a node is unchanged, so every
persisted definition parses exactly as before. Diagnostic codes are preserved verbatim
(`ACTION_WITHOUT_POLICY`, `PAY_ACTION_WITHOUT_APPROVAL`, `PORT_NOT_ALLOWED`, …), so existing tests
and API consumers see the same codes; the existing `validate.test.ts` suite should pass with only
import-path updates if any test imports moved symbols. Migration: none.

**Known accepted friction (stated, not hidden).** (a) Two seams carry a single documented cast
each: the registry `z.union` array assembly (schema module = validation boundary) and
`commitConfig` in the canvas draft path (a draft is *transiently* invalid by design; save-time
`workflowNodeSchema.safeParse` + `assertValidWorkflow` gate persistence). (b) `asExecutor` per
kind is one line, caused by TypeScript's union-call limitation — verified, not assumed. (c) A new
accent color requires one line in the web token map (`accentVarByAccentName`) — a fixed 8-entry
theme table, not a per-kind table.

---

## 6. Rubric self-check

**R1 — one file + one registration line, zero edits to the five consumers.** Adding a kind:
new `packages/workflows/src/kinds/<kind>.ts` (schema, ports, capabilities, fields — §1.1) + new
engine executor file + **two one-line table entries** (`nodeKinds` in `kinds/index.ts`,
`executors` in `engine/nodes/index.ts`). Zero edits to `validate.ts` (rules are
capability-keyed, §2.2), `compile.ts` (capability filters, §4), `catalogue.ts` (palette derives,
§4), `engine/graph.ts` (`executors[node.type]`, §2.5), `inspector.tsx` (field-driven, §2.4).
Honest file count: **2 new files + 2 registration lines**; the rubric's "one file plus one
registration line" holds for the metadata side, and the executor cannot live inside the workflows
package (it depends on `ExecutorDeps`), so I state the split rather than hide it.

**R2 — type safety survives.** `WorkflowNode` is computed as `{ [T in NodeType]: NodeFor<T> }[NodeType]`
(§2.1) — a genuine discriminated union; verified in strict TS that `switch (node.type)` narrows
config per kind with no casts, `nodeKinds[node.type]` resolves legally for read-only metadata,
and the registry key/type agreement is compile-checked via `KindKeyMatches`. The only place the
union must collapse is dispatch, handled by the verified `asserts node is NodeFor<K>` guard
(§2.5) — narrowing by predicate, not by `as`.

**R3 — capability-driven invariants.** `authorityRules` (§2.2) is written once against
`CapabilityName`; a kind declaring `mutates_domain`/`provides_policy`/`provides_approval`/
`terminal`/`produces_output`/`entry` is governed by all existing invariants with no new validator
code. Pay-impact is capability *data* (`payAffecting`), resolved from `commandCatalog` inside the
action kind's declaration, so the rule file stays kind-agnostic.

**R4 — single-sourced references.** One grammar (`TEMPLATE_PATTERN`), one parser
(`parseTemplateExpression`), one resolver (`resolveTemplate`/`resolveTemplateMap`), one static
validator (`checkTemplateStrings`), applied to every kind that declares `templateStrings`; paths
under the trigger root are checked against the event registry's zod payload schema
(`validateEventPath`, §2.3), and producer paths against a declared `outputSchema` when present.

**R5 — reader load.** "Where do this kind's rules live?" → its own file: ports, capabilities,
`validate`, `fields` are sections of one object literal (§1.1). "How do I add one?" → §1.1 is the
whole answer. No table exists that lists kinds a second time — `nodeKinds` is the only kind
list, and it is the thing the kind file registers into.

**R6 — honest diff accounting.**

| | Files touched | Lines (approx) |
|---|---|---|
| Add a kind **today** (e.g. `notify`) | 8: `dsl.ts` (enum + union + schema + ports), `validate.ts` (ports/config/template branches), `catalogue.ts` (palette), `compile.ts` (if a new GraphSpec bucket), `engine/graph.ts` (case + import), new `engine/nodes/notify.ts`, `state.ts` (accent/summary/defaults), `inspector.tsx` (~40-line case), `palette.tsx` (icon) | ~150–200, plus a new kind file |
| Add a kind **after this design** | 2 new files + 2 one-line registrations | ~90 (metadata ~60, executor ~30) |
| Convert the 7 existing kinds | 12: 7 new kind files; `dsl.ts` (delete schemas + `legalPortsByNodeType`, derive union), `validate.ts` (generic rules/ports/hooks), `compile.ts` (capability filters), `catalogue.ts` (palette derives), `engine/graph.ts` + new `engine/nodes/index.ts` (executors), `state.ts` (accent map by name; summary/defaults from registry), `inspector.tsx` (switch → field renderer), `palette.tsx` (icons from registry) | net **negative** in the packages: ~250 inspector lines and ~120 validator/DSL branch lines deleted, ~350 lines of kind declarations added |
