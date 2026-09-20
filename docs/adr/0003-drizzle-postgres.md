# ADR-0003: Drizzle ORM, one database per service

**Status:** accepted

## Context

We need real migrations, typed queries, and transactional integrity between a domain write and its
event publication. The runtime is Bun; ORMs that depend on native binaries add install risk.

## Decision

Drizzle ORM over Bun's built-in SQL client (`Bun.SQL`), with `drizzle-kit` migrations. Each service
owns a database (`rostering`, `time_attendance`, `studio`) on one Postgres instance.

## Consequences

- No native binary and no third-party driver: the client ships with the runtime we already deploy.
- Two driver behaviours had to be handled explicitly. Drizzle's `jsonb()` column stringifies its
  value and Bun encodes that string again, which stores a jsonb string scalar, so every jsonb column
  is declared through a `customType` that hands the driver the object instead. Postgres errors carry
  SQLSTATE on `errno` rather than on `code`, which is the field to read if anything ever branches on
  a constraint violation.
- `postgres` is not a dependency anywhere. `pg` remains, and only because the LangGraph checkpointer
  is built on it.
- Schema-per-service keeps ownership honest; cross-service reads happen only over HTTP or events.
- The domain write and the outbox insert share one transaction, which is what makes at-least-once
  publication safe (ADR-0007).
- LangGraph's checkpointer owns its own tables in the `studio` database and is the one component
  using `pg`; it stays isolated behind `@langchain/langgraph-checkpoint-postgres`.
