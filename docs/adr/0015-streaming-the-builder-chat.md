# ADR-0015: The builder chat streams its turn, and the presentation is not the transport

**Status:** accepted

## Context

The builder chat answered a turn in one blocking call. That was correct and it was the wrong shape
for the thing it wraps: a turn is a conversation with a model that makes several calls, reads the
graph, edits it, and takes anywhere from ten seconds to a minute and a half to answer. While it ran,
the pane showed nothing. The user watched a still screen and could not tell a working agent from a
hung one, which matters here because the vendor really does stall: a `rank_candidates` call has taken
59 seconds, and a body read has timed out at 180.

The transcript also had a second, quieter problem. The agent's work was reported after the fact, as a
list of tool names (`steps`) attached to the finished message. A reader could see that something was
read, never what was read or what it answered.

## Decision

**A turn is a stream of events, and the blocking route stays.**

The builder chat gained `POST /workflows/:workflowId/chat/stream`, framed as SSE over `fetch` — the
pattern `/runs/:runId/stream` and `subscribeToRun` already established, chosen there because
EventSource cannot send actor headers. NDJSON was considered and rejected: a second streaming
convention beside a working one is a second thing to learn for no gain.

The events are `token`, `tool`, `focus`, `done`, `error`, defined once in
`packages/workflows/src/builder/chat.ts` and imported by both halves. `done` carries exactly the
`BuilderChatResponse` the blocking route returns, so the two routes cannot drift: they share the
turn's finalisation, and a client that only wants the result can ignore everything before `done`.
The blocking route stays because the e2e suite and `verify-features` use it, and because a caller
that wants one answer should not have to reassemble one.

**A token names the model run that produced it.**

One turn makes several model calls: a preamble alongside the tool calls, and — since ADR-0014's
harness writes one — a summary when the conversation is long. Only the last call is the answer. The
server therefore tags each `token` with its run, and the client renders the run currently arriving,
discarding the previous run's text when a new one starts. Without this the transcript would fill with
text the reader never asked for, which is the failure mode that makes people distrust an agent UI.

**Token streaming reaches the vendor, not just the graph.**

Streaming the graph's own steps would still have delivered each model answer in one piece, so the
provider boundary gained `stream(request): { deltas, completion }`: deltas as the vendor sends them,
and a completion identical to what `complete()` returns, so accounting, error mapping and callers are
unchanged. The default implementation is concrete — one delta carrying the whole body — because a
provider with no streaming protocol still satisfies the contract, and Anthropic needed no new code.
Only the OpenAI-compatible provider overrides it, reading SSE and asking for `stream_options:
{ include_usage: true }` so the tokens recorded are the vendor's own report.

**AI Elements is presentation, and the transport stays ours.**

The chat is rendered with the AI Elements components (Conversation, Message, Tool, Prompt Input),
copied in through the shadcn registry. They are a presentation layer over `ai`'s types: the
dependency is type-only, and no AI SDK runtime, `useChat`, or AI SDK transport is used. The reason is
that our transport is not negotiable — it carries actor headers, it validates each frame against the
frozen contract, and it is the same shape as the run stream. Adopting the AI SDK's data-stream
protocol would have replaced a working boundary to gain components we can use as they are.

Their Workflow section is a React Flow wrapper, which is the library this canvas already uses. The
canvas is therefore untouched: its node cards are generated from each kind's declaration, and their
generic cards would have discarded the extension story the platform is built on.

## Consequences

The pane shows the turn as it happens: prose as it is written, each tool call when the model asks for
it and its result when the tool answers, and the canvas reacting to a focus request while the agent
is still working.

Streaming makes a stalled vendor visible rather than faster. A call that hangs still hangs; the
reader can now see that it is hanging on a named tool rather than on nothing.

Usage is recorded once per model call, from the final streamed frame. A client that disconnects
mid-stream leaves that call unaccounted for, which is accepted: the alternative is recording a number
the vendor never sent.
