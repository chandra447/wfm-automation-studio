# ADR-0013: A conversational builder that proposes operations, not definitions

**Status:** accepted

## Context

The canvas is a good editor for someone who knows what they want to draw, and a bad one for someone
who knows what they want to happen. A reviewer looking at a payroll workflow asks "can it also post
to the finance channel when overtime is over four hours", and the answer involves finding the right
node type, adding it, wiring the right port, and filling in a template path. That is four chances to
be wrong about a graph they can see.

The obvious move is a chat panel that writes the workflow. The interesting question is what the model
is allowed to write.

1. **Let the model emit a whole definition.** Rejected: a definition is a graph with ids, ports,
   config schemas, and validation rules. Asking a model to reproduce all of it every turn means every
   turn can silently rewrite a part of the graph the user did not ask about, and the failure mode is
   a plausible-looking graph that fails validation.
2. **Let the model call tools that mutate the canvas.** Rejected for the same reason plus a worse
   one: the mutation happens in the browser, so the server never sees what was applied, and there is
   no place to enforce an invariant.
3. **Let the model propose a small list of operations, applied server-side by one applier.**

## Decision

The model answers with a reply and a list of operations from a closed set: add a node, update a node,
remove a node, move a node, connect, disconnect. One applier in `@wfm/workflows` turns that list into
a definition, validates it, and reports what it accepted and what it refused.

Four decisions inside that.

**The client sends its current graph every turn.** The canvas is the system of record, including
positions the user dragged by hand. A server-side session that remembered the last graph would fight
the user for ownership of the canvas, and the failure would look like the agent undoing manual edits.

**The applier is strict about what it cannot understand.** An unknown config key is refused with the
list of keys the kind declares; an illegal port is refused with the kind's legal ports. Zod would
strip or coerce both silently, which reads to a model as success and teaches it nothing, so the
applier checks before it parses.

**A refused operation does not discard the others, but a broken graph discards the edit.** Individual
operations are independent, so a bad guess is skipped and the rest apply. The graph is not: the
studio refuses to store a draft that fails validation, so an edit that would leave more validation
errors than it started with is dropped whole and reported with the diagnostics. This forces the
model to wire a new node in the same turn it adds it, which is the behaviour a user wants anyway.

**The endpoint is stateless with respect to the definition.** It returns the new graph and the client
saves it through the ordinary debounced draft autosave. One writer for the canvas, and the chat
cannot desynchronise from what is on screen.

## Consequences

- The conversation is persisted per workflow, so a reload resumes the thread, and what the agent was
  told sits next to the graph it produced.
- The model needs the palette in its prompt, so the kind catalogue is derived from the same
  declarations the canvas uses. Adding a node kind teaches the agent about it with no prompt edit.
- Latency is the honest cost. A reasoning model can take a minute on a turn, so the UI shows elapsed
  time and the tenant can point the chat at a faster model without changing the workflow's own model.
- The operation list is a durable interface, not just a prompt format: a test, a template, or a
  future migration script can express a graph change with it, and the applier's tests hold the
  behaviour that a model depends on.
