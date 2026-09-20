# Verification

What this repo claims, and what was actually run to check it. The README carries the summary; this
is the evidence behind it.

Everything here runs against the real stack: Postgres, Redis, the four processes, and the model
vendor configured in `.env`. Nothing is checked against a mock, and no number below is computed
twice by the code that reports it.

## The two scripts

```bash
scripts/verify.sh            # infra, migrations, seed, typecheck, services, end-to-end scenarios
scripts/verify-features.sh   # 22 feature properties, against the real provider
```

`verify.sh` brings the infrastructure up, migrates, seeds, boots the four processes, runs the
end-to-end scenarios, and exits non-zero if any property fails. It is the definition of done for the
repo, in one command.

`verify-features.sh` assumes the stack is already up and checks the feature set itself. It spends
real tokens.

### `scripts/verify.sh`

```
  1. Infrastructure        PASS postgres and redis are healthy
  2. Migrations            PASS migrations applied
  3. Seed                  PASS demo data seeded
  4. Typecheck             PASS workspace typechecks
  5. Services              PASS rostering-service is up
                           PASS time-attendance-service is up
                           PASS studio-api is up
  6. End-to-end scenarios  PASS coverage rescue, payroll exception, idempotency, role checks
  Result                   all properties verified
```

### `scripts/verify-features.sh`

```
  1. Platform provider     PASS provider: the platform provider runs the workflow
  2. Bring your own        PASS provider: a customer-supplied provider is used
  3. Rules fallback        PASS provider: no provider configured falls back to the rules proposer
  4. Model catalogue       PASS models: every offered model is declared in config/models.jsonl
                           PASS models: a workflow naming an unknown model is rejected at save time
  5. Token accounting      PASS tokens: run detail reports the provider usage
                           PASS tokens: dashboard totals match the run detail
  6. Dashboard             PASS dashboard: run counts match SQL aggregates
  7. Run input and output  PASS run detail: the trigger payload is exposed as input
                           PASS run detail: the delivered result is exposed as output
  8. Workflow reuse        PASS reuse: a new workflow can be created from an existing one
  9. References, artifacts PASS references: a run resolves {{input.payload.*}} and context paths
 10. Node-kind extension   PASS extension: a new node kind is one file plus registration lines
 11. Domain outcome        PASS outcome: the domain service reflects the workflow action
 12. Steering             PASS steering: an approver message reaches the run and its artifacts
 13. Builder chat          PASS builder: a chat turn edits the graph through validated operations
 14. Agent node            PASS agent: a loop node runs the payroll workflow and proposes
 15. Streaming chat        PASS builder: a turn streams its prose and its tool calls before it ends
  Result                   all 22 feature properties verified
```

## What the interesting ones actually check

**Step 12, steering.** Approves a coverage run with a sentence the reviewer typed, then reads the
artifact back and asserts the approver's words are in it verbatim. That is the whole steering claim
in one check: the decision routed the graph, the reason reached the audit trail, and the feedback
reached the workflow.

**Step 13, the builder chat.** Puts a real model behind the chat, asks for a change, and asserts the
returned definition has the node it added, wired, with no validation errors. The model never writes
the definition: the write tools collect operations from a closed set and one applier validates them
against the same kind declarations the canvas uses.

**Step 14, the agent node.** Swaps a workflow's single-shot decision for an agent node, publishes it,
fires the real scenario, and reads back the tool trail and the one accounting row the loop filed. It
also asserts the loop called only the tools the node declared.

**Step 15, streaming.** Opens the streaming route and times the frames: the tool calls arrive while
the turn is still running, the prose arrives before the turn ends, and the closing frame carries the
same response the blocking route returns.

## Unit and end-to-end tests

```bash
bun test packages services apps/studio-web   # 190 tests across 28 files
bun test tests/e2e                            # 8 scenarios against the running stack
bun run typecheck                             # both projects
```

190 tests across 28 files, including one that throws an engine away mid-approval and finishes the run
on a second instance.

The end-to-end suite asserts observable state only: run rows, approval records, timeline events, and
the domain services' own API responses. The end-to-end scenarios call the configured model, so a
reasoning model makes them slow. Point `PLATFORM_LLM_MODEL` at `deepseek/deepseek-chat-v3.1` for a
fast run, or set a tenant to `none` to exercise the rules proposer.

## The parts a test cannot check

The UI was exercised in a real browser, not just built: the canvas renders the compiled graph,
deleting the approval node disables Publish with the offending node named, the approval card shows
the rationale, evidence and pay impact, and approving resumes the run to `succeeded` with the shift
moving to `offered`.

The run detail's token totals are compared against the `llm_calls` rows, not against a number the
engine computed twice. Every provider check runs against the real vendor.

## Traps in running these

- **`bun test tests/e2e` pins the tenant to `kind: none`.** The builder chat then answers
  `422 has no model provider configured` until you set the provider back.
  `scripts/verify-features.sh` restores it; the e2e suite does not, by design.
- **The payroll simulator consumes the open timesheet.** A second
  `POST /simulator/payroll_exception` without a re-seed answers `412 no open timesheet to clock out of`.
- **The vendor stalls.** Calls have taken 59 seconds, and a body read has timed out at 180. The chat
  streams, so a slow turn shows which tool it is waiting on. A slow turn is not a hung turn.
