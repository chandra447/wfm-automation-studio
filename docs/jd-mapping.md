# How this repo answers the Senior Software Engineer (Automation & AI) brief

Every requirement from the Humanforce job description, mapped to something you can open, run, or read. Line-level paths are indicative of where to look; the behaviour is what the tests assert.

## What the role asks for

| JD requirement | Where it lives here | How it is proven |
|---|---|---|
| Advanced TypeScript and Node.js | All five packages and services, strict mode, no `any`, no casts outside validation boundaries | `bun run typecheck` is part of `scripts/verify.sh` |
| React, component design, state management, data fetching | `apps/studio-web` (Next.js 15, React 19). The builder holds React Flow state, derives the DSL on save, keeps undo history, autosaves a draft, and recovers unsaved work from local storage. The inspector renders a node kind from its own field declarations, so a new kind needs no new component | `scripts/verify-features.sh` step 10, browser walkthrough |
| Designing scalable backend services and reusable platform capabilities | Two domain services plus the engine. Shared capability lives in `packages/*`: event contracts, outbox, event bus port, observability | `bun test packages` |
| Workflow, rules, orchestration or automation systems | `packages/workflows` is the kind registry, the reference mechanism, the validator, and the compiler. `services/studio-api/src/engine` is the orchestrator and graph runtime | `bun test packages/workflows` plus engine tests |
| Extensible platform capability, not one hard-coded flow | A node kind is one declaration file plus registration lines; the platform invariants are written against capabilities, so a new kind inherits pay-safety rules with no validator change. Proven by the `artifact` kind and by a contract test | `packages/workflows/tests/kinds.test.ts`, `docs/arena/kernel-synthesis.md` |
| Async processing, queues, retries, scheduling, idempotency, distributed failure modes | BullMQ job kinds for run start, run step, and approval timeout; exponential backoff; `processed_events` dedupe; `Idempotency-Key` on every command; dead letter table | `docs/design.md` §8, engine tests, `tests/e2e` replay test |
| Integrating third-party platforms, APIs, webhooks, enterprise systems | Services publish through a transactional outbox; the engine consumes from an `EventBus` port with a Redis Streams binding locally and Azure Event Hubs in production; services are called back over typed HTTP | `packages/eventbus`, `docs/adr/0004-event-backbone.md` |
| Strong API and domain modelling | Event registry as the single source of truth (`packages/contracts/src/events/registry.ts`), discriminated unions for nodes and events, DTOs per service | `bun test packages/contracts` |
| Auth, authorisation, secrets, tenant-aware design | Actor context parsed at one boundary; tenant on every row, event, run, and approval; approver role enforced server-side; audit rows name the actor | e2e test that an employee cannot approve |
| Unit, integration, contract, end-to-end testing | Unit and contract tests in `packages/*/tests`, service integration tests against a real Postgres, end-to-end scenarios in `tests/e2e` | `scripts/verify.sh` |
| Monitoring, logging, tracing, incident troubleshooting | pino logs carrying tenant, run, event, and correlation ids; `traceparent` in the envelope so a trace spans service, bus, engine, and command; the run timeline is the human-readable trace | `packages/observability`, run detail page |
| Balancing experimentation with reliability and security | The LLM is optional and never authoritative. A deterministic rules proposer runs when a tenant has no provider, and the end-to-end suite pins it so regressions stay deterministic. Policy checks and approvals gate every write that moves pay | `docs/adr/0006-llm-optional.md`, `tests/e2e/scenarios.test.ts` |
| Integrating third-party AI platforms, bring your own model | `LlmProvider` is an abstract class over raw HTTP with OpenAI-compatible and Anthropic implementations, chosen per tenant with an encrypted customer key. Only models declared in `config/models.jsonl` are offered, and an unknown model is refused at save time | `scripts/verify-features.sh` steps 1-4, `docs/adr/0011-model-provider-and-catalogue.md` |
| Cost, observability, and evaluation of model usage | Every call records the vendor's token counts and latency in `llm_calls`; the run detail, run list, and dashboard read the same rows, priced from the catalogue | `scripts/verify-features.sh` steps 5-6, `services/studio-api/tests/dashboard.test.ts` |
| Agentic workflow platforms, orchestration, human-in-the-loop | LangGraph.js graph compiled from the saved definition, `interrupt()` with a Postgres checkpointer, resume by `Command(resume=...)`, approval timeouts that escalate instead of auto-approving | engine tests, e2e scenarios |
| Knowledge management, ingest, index, search, retrieve | Not built. The award rule is read as structured data. See "What is not here" below | n/a |
| Batch, event-driven, near-real-time data pipelines | Event-driven end to end. The outbox publisher drains on a short interval; the router consumes per tenant | `scripts/verify.sh` |
| Measurable success criteria and evaluation for AI | Proposals are structured output with required evidence; the proposer is swappable, so decisions can be compared between the rules engine and a model on the same fixtures. A model that drafts something the award rule rejects is caught by the policy node, which is what happened the first time the real vendor ran the payroll scenario | engine proposer tests, `docs/decisions.tsv` |
| Evaluate when AI, conventional software, or process automation is right | Ranking, eligibility, award maths, and policy are deterministic. The model only reasons over already-eligible options and drafts an explanation | `docs/design.md` §4 |

## What the demo proves on screen

1. A customer composes a workflow on a canvas. The platform refuses to save one that could move pay without a human on every path.
2. A sick call at 06:10 starts a run. The engine ranks eligible staff, checks policy, and parks for a roster manager.
3. The manager approves in the inbox. Offers go out with an idempotency key. A replay cannot double-apply.
4. A missed break with overtime becomes a drafted adjustment with a pay impact. People Ops approves. The timesheet is corrected and the audit names the approver.
5. An employee without the role is refused, and the run stays parked.

## What is not here

- No knowledge management or retrieval service. The JD lists it; this demo does not need it, and building a shallow one would be worse than saying so.
- No Entra ID. Actor headers stand in for OIDC and the policy checks behind them are real.
- No Azure deployment. The Event Hubs binding is documented rather than shipped, because it cannot be exercised without an Azure subscription.
- No row-level security. Tenant scoping is enforced in queries and asserted by tests; RLS is the production hardening step.
- No multi-region or scale work. This is a vertical slice with the failure paths that matter for a workflow platform.
