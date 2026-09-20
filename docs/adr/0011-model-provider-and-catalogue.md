# ADR-0011: Bring your own model provider, and a catalogue that is the allow-list

**Status:** accepted

Supersedes the provider half of ADR-0006, which said the model came from `OPENAI_API_KEY` in the
process environment.

## Context

A customer evaluating this wants to point the AI decision nodes at their own vendor: an OpenAI
account, an Azure deployment, OpenRouter, a self-hosted vLLM or Ollama, or Anthropic. Some want the
studio to ship a working default so they can see the feature before they have a key. And whoever
runs this needs to know what the model calls cost, per run, in a number they can check.

## Decision

Three decisions, taken together.

**A provider is an abstraction with concrete implementations, not an SDK call.** `LlmProvider` is an
abstract class with `complete()`, implemented by `OpenAiCompatibleProvider` (raw HTTP against
`/chat/completions`) and `AnthropicProvider` (raw HTTP against `/messages`). Nothing else in the
engine knows which vendor is in use. The LangChain OpenAI SDK is gone: the feature deleted a
dependency rather than adding one.

**Settings are per tenant, and a customer key is write-only.** A tenant selects one of `platform`
(the endpoint this deployment is configured with, from `PLATFORM_LLM_*`), `openai-compatible`, or
`anthropic`, with a base URL, a model, and optionally a key. A supplied key is stored encrypted with
AES-256-GCM under `LLM_CONFIG_SECRET` and is never returned by any read; the API reports a last-four
and whether one is stored. Saving a key without a config secret fails, naming the variable.

**Only models listed in `config/models.jsonl` are offered.** Each line declares an id, a label, the
provider, the context window, whether JSON mode is supported, and the price per million tokens in
each direction. Adding a model is one line and nothing else in the code knows the list. A workflow
that names a model the file does not declare is refused at save time with a diagnostic that names
the file, rather than failing at three in the morning.

## Consequences

- A run with no provider configured falls back to the deterministic rules proposer, so CI and an
  offline laptop still exercise the whole pipeline. This is unchanged from ADR-0006.
- Every call is recorded in `llm_calls` with the provider, model, input and output tokens, latency,
  and status, taken from the vendor's own usage report. The run detail, the run list, and the
  dashboard all read that table, so the cost shown is auditable back to the call.
- The provider is resolved once per model call rather than once per process, because the setting can
  change between runs.
- Vendor behaviour is now a real input to the design. A response can carry tens of kilobytes of
  whitespace padding before the JSON while the upstream provider warms up, and the body can outlive
  a short timeout. The default timeout is 60 seconds and a stalled body is reported as a timeout
  rather than as a malformed response.
- `packages/testkit` ships a fake OpenAI-compatible server so the HTTP client has deterministic
  unit tests. It is test infrastructure, not the verification path: `scripts/verify-features.sh`
  exercises the real provider end to end.
