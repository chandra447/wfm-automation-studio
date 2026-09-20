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
- **Prefer the runtime's own clients over npm drivers.** Postgres goes through `Bun.SQL` with Drizzle
  (`drizzle-orm/bun-sql`) and Redis through `Bun.redis`, so this repo carries no database or cache
  driver of its own. The cost is real and accepted: `Bun.SQL`, `Bun.redis`, and `Bun.serve` are
  Bun-only, so the deployment target is Bun rather than "node or bun unchanged". Where a library
  insists on its own driver, the driver stays as that library's dependency: LangGraph's Postgres
  checkpointer takes a `pg` Pool, and BullMQ builds its own ioredis connections.
- Scripts may use anything Bun offers; they are tools, not the product.
