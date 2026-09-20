# ADR-0012: Steering, and why human input enters the run as a message

**Status:** accepted

## Context

An approval currently returns one bit: approved or rejected. The reviewer also types a reason, but
that reason is written to the audit trail and the run never sees it. In a real operation the
interesting case is the reviewer who says yes with a condition, or no with an instruction: "approve,
but offer the shift to Marcus first", "reject, the award is wrong for a Sunday". Today that sentence
is recorded and then ignored, and the run behaves exactly as it would have if the reviewer had said
nothing.

The studio is an agentic workflow platform, so the question is where human input belongs. Options
considered:

1. **A node config field.** The approval node gains a `feedback` config the reviewer fills in and
   downstream nodes read by node id. Rejected: it makes the message a property of the graph rather
   than of the run, and it only reaches nodes that were wired to read that specific node.
2. **A second output port.** Approved-with-instruction routes to a different branch. Rejected: it
   doubles the approval surface, and the instruction still has no way to reach a model.
3. **A message on the run.** The run carries a conversation, and the feedback is appended to it.

## Decision

The run state gains a `messages` channel, and a human decision with feedback appends one message to
it. `ai_decision` nodes pass the messages to the proposer, and `{{run.feedback}}` resolves to the
most recent one, so a template can quote it.

Three details are load-bearing.

**The message is appended by the approval node, not by the decision handler.** Everything before
`interrupt()` re-executes on resume, so a write in the HTTP path and a write in the node would
double up. The node is the only writer, it reads the feedback from the decided row, and it is keyed
by the approval id, which is what makes a replayed resume idempotent.

**The reason and the feedback are different fields.** The reason is what the audit trail records for
a human reader. The feedback is what the workflow acts on. Merging them would mean every audit
sentence becomes an instruction to a model, which is exactly the failure mode this feature should
not have.

**Steering is advice, not authority.** It is an input to a model's preference, never to a policy
check's verdict. A reviewer cannot instruct their way past the rest rule or the cost cap, and the
validator's authority rules still hold: the feedback changes what the run prefers, not what it is
allowed to do.

## Consequences

- A run's state now carries conversation, so `messages` is a channel with an append reducer and the
  state is no longer a pure function of the trigger event. The checkpointer stores it with the rest
  of the state, so a parked approval keeps its history across a restart.
- The deterministic rules proposer ignores steering, and says so in the code. This is honest rather
  than elegant: a rules engine cannot interpret "prefer Marcus". A tenant that wants the sentence
  understood configures a model provider.
- Feedback is optional and bounded (1000 characters), and an empty string is rejected at the
  contract boundary so "no feedback" has one representation rather than two.
- The approval DTO, the `approval_decided` event, and the audit entry all carry it, so a reviewer can
  see what was asked next to what the run then did.
