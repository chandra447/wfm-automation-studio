# ADR-0005: BullMQ for run execution, LangGraph.js for the graph

**Status:** accepted

## Context

Two different kinds of durability are in play: *workflow* durability (a graph pauses for a human for
hours and must resume exactly where it stopped) and *operational* durability (a step fails and must
be retried, rate-limited, scheduled, or parked in a DLQ without wedging a worker).

Framework options considered: Temporal (strongest durability, heaviest infrastructure, AI-agent
content is incidental), Inngest/Trigger.dev (excellent TypeScript DX, external control plane),
BullMQ alone (great queue, no graph/interrupt primitives), LangGraph.js (graph + interrupts +
checkpointing, the AI-agent story is first-class).

## Decision

Use both, deliberately split:

- **BullMQ (Redis)** owns execution: run-step jobs, attempts, exponential backoff, delayed
  approval-timeout jobs, repeatable sweeps, concurrency limits per tenant.
- **LangGraph.js + `@langchain/langgraph-checkpoint-postgres`** owns the graph: nodes, the
  `interrupt()` boundary, `Command(resume=...)`, and checkpointed state so an approval survives a
  process restart.
- **Our orchestrator owns the run record**: state machine, dedupe, retries policy, DLQ, audit, and
  the SSE timeline. Neither library is trusted to be the system of record.

## Consequences

- Retry/DLQ semantics are ours and testable; replacing the graph runtime later is contained.
- Two moving parts (Redis + Postgres) instead of one, justified by the split above.
- Approval latency is decoupled from worker lifetime; no worker is blocked while a manager sleeps.
