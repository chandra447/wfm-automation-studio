# ADR-0006: The LLM is optional and never authoritative

**Status:** accepted

## Context

The demo must run offline, in CI, and on a reviewer's laptop without an API key. More importantly,
workforce decisions touch pay, compliance, and people's rosters — a model must not be the last word.

## Decision

The proposer node has two implementations behind one interface:

- `LlmProposer` — structured output (candidate choice, adjustment draft, rationale, evidence ids),
  used when `OPENAI_API_KEY` is configured.
- `RulesProposer` — a deterministic ranking/computation over the same inputs, used otherwise and as
  the CI default.

Both emit the same `Proposal` object. Every proposal — from either proposer — passes through the
deterministic policy node and, when the action has pay or cross-employee impact, through human
approval before any command is issued.

## Consequences

- Tests assert on decisions and effects, not on model output; no flaky suites, no key in CI.
- The LLM's contribution is reasoning and explanation (evidence-linked rationale), while authority
  stays with policy + human.
- The audit record stores which proposer produced the decision and, for LLM runs, the model and
  prompt version.
