# ADR-0007: Transactional outbox, skinny events, idempotent commands

**Status:** accepted

## Context

Publishing to a broker from inside a request is the classic dual-write bug: the database commits and
the publish fails (or vice versa), and the platform's downstream workflows silently diverge from
domain truth. Separately, at-least-once delivery means every consumer and every command must tolerate
repeats.

## Decision

**Producers.** A domain write and its outbox rows are written in one Postgres transaction. A publisher
loop claims due rows with `FOR UPDATE SKIP LOCKED`, publishes them, and marks them sent. Delivery is
at-least-once; ordering per aggregate is preserved by writing rows in commit order and publishing
serially per stream.

**Payloads.** Events carry identity and immutable facts only (skinny). Consumers re-read current state
from the owning service before deciding. This matches Humanforce HR's existing skinny webhooks, so the
platform's contract is consistent with what the estate already does.

**Consumers and commands.** Dedupe on `eventId`; runs are unique per `(workflow_id, event_id)`. Every
mutation the engine performs carries an `Idempotency-Key` derived from `runId + step`, and services
persist keyed responses so a retry replays rather than re-applies.

## Consequences

- A broker outage delays events but cannot lose them; the outbox is the queue of record until sent.
- Publisher lag and DLQ depth are the two metrics that matter operationally; both are exposed.
- Command handlers must be written to be idempotent — a requirement that is enforced by an e2e test
  that replays the same approval decision twice and asserts a single effect.
