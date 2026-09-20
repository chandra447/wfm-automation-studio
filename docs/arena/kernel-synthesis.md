# Kernel synthesis: base, grafts, rejections, verification

Three independent design packages were produced for the same two interfaces, then judged by a
separate reviewer against a fixed rubric. Candidates and scores are in `kernel-a.md` (26/30),
`kernel-b.md` (27/30), `kernel-c.md` (28/30).

## Base

Candidate C's shape, with two grafts. A node kind is one declaration file: config schema, ports,
capabilities, canvas field specs, summary, and kind-local config rules, registered in one table.
Platform invariants are written once against capabilities rather than against kinds, so a new kind
inherits pay-safety rules without new validator code.

Why C over B: the invariant rules are the part of this system that must survive contact with kinds
nobody has written yet, and C is the only candidate that made the rules themselves extensible data
(`authorityRules`) rather than code inside `checkAuthority`. B's descriptor ergonomics are better in
places and are grafted below. A was rejected as a base because it moves executors into the DSL
package to win a one-file claim, which drags runtime ports into a package that is deliberately
runtime-free, and because its type story needs method bivariance plus an undisclosed cross-package
edit whenever a kind needs new I/O.

## Grafts

1. From B, `payImpactOf` as a capability predicate. C's static `payAffecting: boolean` on the
   `mutates_domain` capability cannot express what the platform does today, where pay impact depends
   on which command the node configured. Refined while grafting: the predicate takes the node, not
   the config, so the kind narrows its own config with its own predicate and the rule table stays
   kind-agnostic and cast-free.
2. From B, template slot modes (`inline` and `whole`). An exact single reference must splice the raw
   value, not a string, or existing `action` nodes change behaviour for array inputs like
   `employeeIds`.
3. From B, field-level `visible(config)` so the inspector can hide a control that does not apply to
   the current config, which the pay warning needs.
4. From A, the practice of disclosing costs in the design rather than after review, and a contract
   test that pins registry-to-executor pairing.

## Rejections

- Executors inside the DSL package (A's one-file claim). Rejected: it buys a file count by moving
  runtime ports into a package whose whole value is not knowing about them.
- Class hierarchies per kind, mixins, or `PayAffectingNode` base classes. Rejected: inheritance
  re-encodes capability composition as type-system magic, and the rules stop being readable as data.
- Per-kind React components in a registry. Rejected: a new kind would still need a component, and
  reader load rises. The closed control set covers all seven existing kinds.
- Side-effect self-registration to reach a literal one-line claim. Rejected: invisible import-order
  coupling for one saved line.

## Verification of the design's central claim

The judge found that both A and B assemble the runtime union with
`z.discriminatedUnion('type', Object.values(registry).map(...))`, and that this does not typecheck:
zod requires a non-empty tuple, and `.map` produces an array. Both designs would have collapsed to
`unknown` and lost per-kind narrowing while still parsing correctly at runtime, which is the worst
kind of failure because tests would pass.

I checked this against this repo's zod (4.6.5) in a throwaway strict-mode project rather than
trusting the judge's zod-3 reasoning, and the finding holds. Two assemblies were then verified to
compile, narrow, and parse:

| Assembly | Compiles | Per-kind narrowing | Rejects unknown kind and missing config |
|---|---|---|---|
| `z.discriminatedUnion('type', [explicit tuple literal])` | yes | yes | yes |
| `z.union(Object.values(registry).map(...))` plus a mapped-type union | yes | yes | yes |

The design uses the explicit tuple, because it keeps zod's discriminated parse path and therefore
the same parse behaviour and error messages as today's hand-written union. The honest cost is that
adding a kind is one new file plus one registry line plus one schema-tuple line, not the single
registration line the rubric asked for. The scratch project also verified the executor table
dispatch with a uniform signature plus a type predicate, capability predicates evaluated per node,
and derived tables built with `satisfies` rather than a cast.
