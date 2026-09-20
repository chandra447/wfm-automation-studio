# ADR-0014: The builder agent runs on Deep Agents, with tools instead of one answering turn

**Status:** accepted

Supersedes the "one call, one JSON answer" half of ADR-0013. The operation list, the applier, and
the client-sends-its-graph rules stand.

## Context

ADR-0013 gave the model one turn: the whole graph and the whole palette went into the prompt, and it
answered with a reply and a list of operations. That was cheap, deterministic and easy to test, and
it has two limits that showed up the moment the feature was used in anger.

The first is that the model had to be told everything whether it needed it or not. A question like
"which step waits on a human?" cost the same as an edit, and the palette text was re-sent on every
turn.

The second is that it could not look. Asked to explain a graph or check its own work, the model had
only what the last prompt contained, and a bad edit was discovered by the applier after the turn had
already been reported to the user.

## Decision

Rebuild the builder chat on `deepagents`, with tools, and keep the applier as the only authority.

**Tools, in three groups.** Reads (`read_workflow`, `get_node`, `list_node_kinds`,
`read_data_catalogue`) answer questions about the graph and the platform. Selections (`select_nodes`,
`select_edges`) ask the canvas to point at something and change nothing. Writes (`add_node`,
`update_node`, `remove_node`, `move_node`, `connect`, `disconnect`) do not touch the graph at all:
they append to an operation list.

**The applier still decides.** At the end of the turn the collected list goes through the same
`applyOperations` the server has always used, so an agent with tools still cannot produce a
definition the DSL rejects. What changes is when the agent learns: each write tool answers with the
applier's verdict on the plan so far, so a refusal is corrected inside the turn rather than reported
after it.

**A refused call and an unfinished graph are different things.** A mistake in the call itself — a
port the kind does not have, a config key it does not take, a duplicate id, an unknown node — is
refused immediately with the legal alternatives. An incomplete graph is *recorded* with what is not
valid yet, because a node is added before it is wired and a turn is allowed to be half-finished in
the middle. An earlier version judged the whole plan on every call; the first refusal then stayed in
the list and every later call reported it, so the agent spent the turn fixing something it had
already fixed.

**The provider learned to carry a conversation.** The first working version flattened the message
list into one prose user turn, and the model answered by continuing the transcript — it emitted JSON
that looked like a tool call instead of making one. Two things were wrong and both were ours: a tool
result must arrive as a tool turn, or the model cannot tell it from something the user said, and JSON
mode must not be requested on a call that declares tools, because a model constrained to one JSON
object cannot choose to call anything.

## Consequences

- The chat needs a model that actually calls tools. `config/models.jsonl` now declares `toolCalls`
  per model, measured rather than assumed: the default model returns tool calls, and the two others
  in the catalogue answer in prose. The catalogue is already the allow-list, so this is one more
  thing it is allowed to say.
- A turn is several model calls. Measured on the real vendor: a "read the graph, add a node, wire it,
  check it" turn took 14 calls and 70 seconds, 137k input tokens and 3.6k out. That is the honest
  cost of an agent that looks before it writes, and it is the reason the panel counts seconds. The
  prompt is re-sent on every call; a cheaper model for the read calls is the obvious next lever.
- The turn stays stateless with respect to the harness. The conversation lives in `builder_messages`
  and the recent turns are handed over in the prompt, so there is one record of what was said rather
  than a checkpointer's copy and ours drifting apart.
- Deep Agents brings its own always-on tools — `write_todos`, the filesystem, and the `task`
  subagent — which cannot be removed. Planning is visible and useful; the filesystem sits in agent
  state and never touches disk.
- `deepagents` required no upgrade to the run engine: every `@langchain/*` peer was already
  satisfied, and the engine's LangGraph usage is unchanged.
