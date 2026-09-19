# ADR-0001: Bun as the runtime

**Status:** accepted

## Context

The Automation & AI role is TypeScript/Node-centric. The demo needs one runtime for services, workers,
tests, and scripts, with fast cold starts and no build step.

## Decision

Use Bun (1.3+) as the runtime, package manager, and test runner for services, workers, and packages.
Next.js runs under `bun --bun`.

## Consequences

- No transpile step: services import workspace TypeScript directly (`exports: ./src/index.ts`).
- `bun test` covers unit/integration/e2e; `bun install` resolves workspaces.
- Two runtime-compatibility risks were verified before committing to the stack (BullMQ on Redis,
  LangGraph.js Postgres checkpointer) in `tests/compat/bun-runtime.test.ts`.
- Deployment target is Node-compatible either way: the code uses no Bun-only APIs outside scripts, so
  a container can run `node` or `bun` unchanged.
