# ADR-0004: Event backbone is a port; Redis Streams locally, Azure Event Hubs in production

**Status:** accepted

## Context

The platform's premise is that domain services drop events onto a shared hub that the workflow engine
consumes. The team's target is Azure Event Hubs. A local demo also has to run on a laptop with one
`docker compose up`, and tests must not require a broker at all.

## Decision

Define `EventBus` as a port with two methods (`publish`, `subscribe`) and three adapters:

1. `RedisStreamsEventBus` — default local binding; consumer groups (`XREADGROUP`/`XACK`), replay,
   partition-key ordering by stream, per-group offsets, DLQ streams. It runs on Bun's own Redis
   client, so nothing we wrote depends on a Redis driver package: the typed commands cover the
   everyday ones and the stream commands go through the client's raw `send`, which is the same
   protocol and the same replies.
2. `InMemoryEventBus` — tests and single-process demos; deterministic, no I/O.
3. `EventHubsEventBus` — production binding over the AMQP SDK, using the same envelope; the demo does
   not require it to run.

## Consequences

- The architectural claim ("events land on a hub") is preserved without pretending the local broker is
  Event Hubs; the mapping is explicit and documented in the adapter.
- Semantics the engine relies on — consumer groups, at-least-once delivery, per-key ordering, dead
  lettering — exist in both bindings, so the engine has no Redis-specific code.
- Swapping bindings is a change to one factory call, covered by an adapter contract test that runs the
  same suite against in-memory and Redis.
