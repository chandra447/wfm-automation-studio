# ADR-0003: Drizzle ORM, one database per service

**Status:** accepted

## Context

We need real migrations, typed queries, and transactional integrity between a domain write and its
event publication. The runtime is Bun; ORMs that depend on native binaries add install risk.

## Decision

Drizzle ORM over `postgres` (postgres.js), with `drizzle-kit` migrations. Each service owns a
database (`rostering`, `time_attendance`, `studio`) on one Postgres instance.

## Consequences

- No native binary, no query engine: works on Bun and Node identically.
- Schema-per-service keeps ownership honest; cross-service reads happen only over HTTP or events.
- The domain write and the outbox insert share one transaction, which is what makes at-least-once
  publication safe (ADR-0007).
- LangGraph's checkpointer owns its own tables in the `studio` database and is the one component
  using `pg`; it stays isolated behind `@langchain/langgraph-checkpoint-postgres`.
