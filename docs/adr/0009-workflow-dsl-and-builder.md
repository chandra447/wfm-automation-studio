# ADR-0009: Workflows are a DSL the engine compiles, not code the engine contains

**Status:** accepted

## Context

The requirement is a studio where customers compose their own workflows by dragging and dropping nodes. A single hard-coded graph per use case would satisfy the two demo scenarios and fail the actual product. The platform also has to keep invariants that a customer cannot be trusted to preserve, because the actions in question move pay and change people's rosters.

## Decision

Workflows are data with three parts, all in `packages/workflows`:

- a **DSL**: nodes (trigger, condition, ai_decision, policy_check, human_approval, action, end) and edges labelled with the port they leave from;
- a **validator** that encodes the platform's invariants, run on the client for feedback and on the server as the authority;
- a **compiler** that turns a validated definition into a `GraphSpec`, which the engine maps onto a LangGraph `StateGraph` built at run time.

The engine holds node executors, not workflows. Adding a workflow is a row, not a deployment.

Enforced invariants: a pay-affecting action must have a `human_approval` on every path from the trigger; every action must have a `policy_check` on its path; referenced events, commands, roles, and template paths must exist; no unreachable nodes; no cycles; branching nodes must wire their required ports. Diagnostics carry node ids so the canvas can highlight the offender.

## Consequences

- Customer freedom and platform safety stop being in tension. The customer arranges nodes; the validator refuses arrangements that would let a model or a retry move money unsupervised.
- The validator is the most valuable file in the repo and the most testable: each invariant has a test that fails when the rule is removed.
- A new command or tool is added in one catalogue and immediately available to the canvas, the inspector, and validation.
- The engine's graph runtime is replaceable: the compiler emits a runtime-neutral spec.
- Cost: a DSL is a language, and languages need versioning. The definition is stored per version, so an old run keeps executing the definition it started with.
