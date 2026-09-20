# AGENTS.md

How to work in this repo. Written for an agent that has just landed here and has to change
something without breaking it.

---

## 1. What this project is

**WFM Automation Studio** is an automation platform for workforce management. Customers compose
workflows over events from workforce systems: a shift is cancelled, a break is missed, a timesheet
crosses an award rule. Each workflow can check policy, ask a model to reason, wait for a human, then
issue a command back to the system that owns the data.

The product is the **platform**: the workflow DSL, the validator, the engine, the provider boundary,
and the canvas. The two domain services are deliberately thin scaffolding that emit realistic events
They are thin on purpose, because that is what a real integration looks like.

It is built as a demonstration for a **Senior Software Engineer, Automation and AI** interview, so
the code is meant to be read as much as run. `docs/jd-mapping.md` maps each capability to the job
description and to the file that implements it.

### Layout

| Path | What it owns |
|---|---|
| `packages/workflows` | The DSL, the node-kind registry, the validator, the reference grammar, the operation applier, the builder-chat wire contract |
| `packages/contracts` | Event schemas, the catalogue, API shapes, primitives (ids, money, actor context) |
| `packages/eventbus` | The event backbone as a port: Redis Streams locally, Azure Event Hubs in production |
| `packages/outbox` | Transactional outbox: a domain write and its event commit together |
| `packages/observability` | Structured logging, trace propagation |
| `packages/testkit` | Seeded fixtures and the ids the demo depends on |
| `services/rostering-service` | Shifts, offers, assignments. Emits `shift.*` |
| `services/time-attendance-service` | Timesheets, breaks, award rules. Emits `attendance.*`, `timesheet.*` |
| `services/studio-api` | The engine, the builder agent, the LLM provider boundary, the dashboard API |
| `apps/studio-web` | Next.js canvas, chat, runs, approvals, dashboard, trigger catalogue |

### Runtime

Bun everywhere. Elysia + Eden for typed HTTP boundaries, Postgres + Drizzle (one database per
service), BullMQ for run execution, LangGraph.js for the graph inside a run, React Flow for the
canvas, Next.js 15 + React 19 + Tailwind 4 for the app.

**Prefer the runtime's own clients over npm drivers**: `Bun.SQL` over `pg`, `Bun.redis` over
`ioredis`. ADR-0001.

### Commands

```bash
bun run infra:up      # docker: postgres :5433, redis :6380
bun run db:migrate
bun run seed          # demo tenant, 2 published workflows, one open timesheet
bun run dev           # rostering :4101, attendance :4102, studio-api :4103, studio-web :4104
bun run typecheck     # BOTH projects: root tsconfig and apps/studio-web
bun run test          # packages, services, apps/studio-web
bun run e2e           # the end-to-end scenarios (needs the stack up and seeded)
scripts/verify.sh     # the definition of done: infra → migrate → seed → boot → e2e → teardown
scripts/verify-features.sh   # 22 feature properties against the real provider
```

`scripts/verify-features.sh` is the honest one: it drives the running stack, spends real tokens
against the provider in `.env`, and prints one PASS/FAIL line per claimed property. If you add a
capability the README claims, add it there too.

---

## 2. Use ripwire before you plan, and before you call it done

This repo is indexed for `ripwire`. Reach for it **before** `Read`/`Grep`/`Glob`, and at the two
moments that leak the most value: **planning a feature**, and **finishing one**.

```bash
ripwire . --help-task="<the task in words>" --legend=compact   # not sure which verb: ask
```

### Planning a feature

| You are about to… | Run |
|---|---|
| Plan a multi-symbol feature | `ripwire . --recall="<the task>" --for="<the concept>" --seams` |
| Implement against an existing interface | `ripwire . --lego=<Interface> --legend=compact`: its contract plus every implementor to copy |
| Write one new function or class | `ripwire . --exemplar="<the sub-task>" --for="<the task>"`: the house pattern, and what already exists |
| Learn how something works | `ripwire . --for="<concept in words>"` or `--pack-task="<task>" --token-budget=N` |
| See how three or more symbols relate | `ripwire . --connect=A,B,C` |
| Fan out to subagents | `ripwire . --pack-task="<task>" --partition=N` then `--plan-lanes=N --task="…"` |

The reflex that matters most here: **before writing a symbol, check whether the repo already has that
shape** (`--exemplar`, `--clones`). This codebase has one way to do most things, and a second way is
the bug.

### Making a change

| You are about to… | Run |
|---|---|
| Edit an exported symbol | `ripwire . --impact=<Symbol>`: the transitive blast radius, not just direct callers |
| Finish a symbol edit | `ripwire . --edit-check=<Symbol>`: contract unchanged, or the callers that break |
| Call it done | `ripwire . --quality-delta --legend=compact`: only what you made **worse**; exit 2 means new debt |
| Know which tests to run | `ripwire . --affected=<file1>,<file2>` |
| Debug a symptom | `ripwire . --for="<symptom>"` or `--from-trace=-` with the stack trace on stdin |

**The two write-time reflexes are not optional here.** `--exemplar` before you write a symbol,
`--quality-delta` before you say done. A finding from `--quality-delta` is only half the job: the fix
is proven by `--quality-delta` (the finding is gone, nothing else regressed) → `--edit-check` (the
contract held) → `--affected` (the tests that prove it).

Skills that explain each of these: `skill://ripwire-before-you-build`, `ripwire-change-check`,
`ripwire-quality-bar`, `ripwire-navigate`, `ripwire-orient`, `ripwire-reuse-first`. Start at
`skill://ripwire-router` if unsure.

**Where ripwire does not apply:** it maps structure, not build state, and it does not read
Markdown, SQL migrations, or config. For an ADR or a doc, read the file.

---

## 3. House rules

These are not style preferences. A change that breaks one gets sent back.

**Type safety**
- No `any`. No `as` outside a validation boundary. The boundary is where untrusted bytes become a
  typed value. Parse there with Zod, then read a fully typed value everywhere else.
- A schema is the boundary for HTTP bodies, event payloads, provider responses, and stored JSON.
  `services/studio-api/src/app.ts` parses every body; the engine only ever sees parsed values.

**Comments**
- A comment explains a **why that is not obvious**: a constraint, a trap, a decision. Never narrate
  what the next line does. If the code needs narrating, rename something instead.
- A comment that argues for a choice is worth its lines. `// loop over nodes` is not.

**Shape**
- `Record` over `Map` for static string-keyed tables.
- No one-expression wrapper functions. If it has no name of its own, inline it.
- Prefer updating an existing file over adding one. A new file is a claim that nothing here fits.
- One convention per problem. A second way to do something that already has a way is the defect,
  even when the second way is fine on its own.

**The platform's own invariants**
- A node kind declares its `ports` **and** its `inputs`, its config schema, its capabilities, and
  its fields. `inputs` has no default: a new kind cannot accept edges without someone deciding it.
- Invariants are enforced against **capabilities**, not against kind names. "Anything that moves pay
  sits behind a human decision" is written against `capabilities.payImpact`, so a new kind inherits
  the rule by declaring what it is, not by being named in a list.
- One port carries one target. The engine's route map is keyed by port; a second edge on a port
  silently replaces the first and the graph will not compile.
- One rule answers whether an edge may exist (`packages/workflows/src/edge-rules.ts`), asked by the
  applier, the validator, and the canvas. Never add a second copy of an edge rule in a component.

---

## 4. Verify what you changed

Never yield a change without evidence. What counts as evidence depends on the surface:

| Change | Evidence |
|---|---|
| Engine, engine node, validator, DSL | `bun run test` plus the property in `scripts/verify-features.sh` that covers it |
| The workflow that runs end to end | `scripts/verify.sh` (boots the stack, seeds, runs the 8 e2e scenarios) |
| The canvas, the chat, any UI | Drive the real browser and look at it. A build that compiles is not a verified UI |
| A bug fix | Reproduce it first, then show the reproduction no longer fires |

**Tests earn their place or they do not exist.** A test is worth writing when a plausible bug would
fail it: a boundary, an invariant, a transition, a real error path. Do not write a test so the
change "has tests", do not assert implementation details (wiring, defaults, field copies, source
text), and do not pad a suite with rows of the same path. If you want a throwaway check, write a
throwaway script and delete it.

`bun run typecheck` covers **both** projects. The root tsconfig alone once let a `ReferenceError`
reach a browser while every gate stayed green. That is why the web app has its own.

---

## 5. Docs and ADRs

The repo documents itself. Read the doc before changing the thing it describes, and update it in the
same commit as the change.

| File | What it is |
|---|---|
| `README.md` | The pitch, the verification output, the capability list, the screenshots |
| `docs/design.md` | The design: the trigger catalogue, the DSL and canvas, the invariants, the engine, the API, the provider, the dashboard, steering, the conversational builder, streaming, reliability, observability, testing |
| `docs/adr/` | Fifteen decisions with their context and trade-offs |
| `docs/jd-mapping.md` | Capability → the job description line → the file that implements it → the check that proves it |
| `docs/demo-script.md` | The recording script: beats, prompts, expected results, timings |
| `docs/loom-script.md` | The short screen-recording script |
| `docs/arena/` | A three-way design arena and its synthesis, kept because the reasoning is useful |
| `decisions.tsv` | The running decision log: timestamp, area, decision, why, where, what it cost |
| `docs/screenshots/` | What the README's gallery points at |

### The ADRs

| ADR | Decides |
|---|---|
| 0001 | Bun as the runtime |
| 0002 | Elysia + Eden for typed boundaries |
| 0003 | Drizzle ORM, one database per service |
| 0004 | The event backbone is a port: Redis Streams locally, Azure Event Hubs in production |
| 0005 | BullMQ for run execution, LangGraph.js for the graph |
| 0006 | The LLM is optional and never authoritative |
| 0007 | Transactional outbox, skinny events, idempotent commands |
| 0008 | The demo authentication boundary |
| 0009 | Workflows are a DSL the engine compiles, not code the engine contains |
| 0010 | Canvas state lives on the server, with geometry beside the definition |
| 0011 | Bring your own model provider, and a catalogue that is the allow-list |
| 0012 | Steering: why human input enters the run as a message |
| 0013 | A conversational builder that proposes operations, not definitions |
| 0014 | The builder agent runs on Deep Agents, with tools instead of one answering turn |
| 0015 | The builder chat streams its turn, and the presentation is not the transport |

**When you make a decision that someone will question later, write ADR-0016.** An ADR states the
context, the decision, and what it costs, including what was rejected and why. `0015` is a good
model: it names NDJSON as the alternative it rejected. Superseding an earlier ADR is expected; say
so in the header rather than editing the old one.

Record the smaller decisions in `decisions.tsv`: one tab-separated row, timestamp, area, decision,
why, where, and what it cost. It is the fastest way for the next agent to learn what was already
tried.

---

## 6. Traps this repo has already paid for

- **`bun test tests/e2e` pins the tenant to `kind: none`.** The chat then answers
  `422 has no model provider configured` until you set the provider back (Settings, or
  `PUT /provider-settings`). `scripts/verify-features.sh` restores it; the e2e suite does not, by
  design.
- **The payroll simulator consumes the open timesheet.** A second `POST /simulator/payroll_exception`
  without a re-seed answers `412 no open timesheet to clock out of`. Re-seed before firing again.
- **A workflow on the same event as a seeded one means one fire, two runs.** That is the engine
  working, not a bug.
- **The builder agent's read tool returns the snapshot from the start of the turn.** It will say a
  read looks stale; the writes still landed. Known, not fixed.
- **The builder agent cannot rename a workflow.** It has no rename tool. The name is edited in the
  canvas header.
- **A policy check belongs after the proposal it judges.** Placed before an AI decision, a check like
  `award_validity` judges the timesheet, which is a violation by definition on a violation trigger,
  and every run takes the failure path.
- **`agent-browser drag` cannot drive React Flow** (HTML5 DnD against pointer events). Node and
  handle drags do not move; a control drag proved it. Verify canvas behaviour by clicking, and by
  reading state, not by dragging.
- **`caffeinate -u -t N` is needed for React Flow to paint in headless verification.**
- **The vendor stalls.** Calls have taken 59s, and a body read has timed out at 180s. The chat
  streams, so you can see which tool it is waiting on. Do not read a slow turn as a hang.
