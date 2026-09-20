# Demo recording script

Building a workflow by conversation, end to end. Target length: **4 to 5 minutes**.

Everything below was run against the live stack while writing this, so the prompts are the ones
that worked, not the ones that should work. Where something is not verified it says so.

---

## Before you hit record

```bash
bun run infra:up          # postgres :5433, redis :6380
bun run seed              # demo tenant, 2 published workflows, one open timesheet
bun run dev               # rostering :4101, attendance :4102, studio-api :4103, studio-web :4104
```

Then, in the browser:

1. Open <http://127.0.0.1:4104> and sign in as **Sam Whitfield, Roster Manager**.
2. **Settings → provider**: make sure the tenant is on the platform provider with a model selected.
   If the chat answers with `HTTP 422 ... has no model provider configured`, this is why.
3. Close every other workflow tab. The workflow list should show exactly two:
   *Rescue a cancelled shift* and *Resolve a pay-affecting timesheet exception*.

Recording setup: one browser window, 1440p or larger, browser zoom at 100%, notifications off. The
chat pane and the canvas are read together, so keep the window wide enough that the docked chat pane
(380px) and a useful canvas both fit.

> **Timing you must plan for.** The model is real. A turn that adds one node takes 15 to 25 seconds;
> a turn that adds two nodes and rewires the path between them has taken over two minutes. The whole
> build below ran in about five minutes of wall clock. Either record the waiting and speed it up in
> the edit, or paste the next prompt the moment the previous turn finishes and cut between beats.

---

## The beats

### Beat 1 — The platform already works (0:00–0:25)

**Show:** the workflow list, then **Dashboard**.

**Say:** *"This is an automation platform for workforce management. Two automations are already
running here: one rescues a cancelled shift, one corrects a pay-affecting timesheet. Both are built
on the same primitives: a trigger from a domain service, a policy check, an AI decision, and a human
approval before anything touches pay."*

### Beat 2 — Open one and show what it enforces (0:25–0:50)

**Show:** open **Rescue a cancelled shift**. Point at the canvas, then at the **Validation: no errors**
pill.

**Say:** *"Every node on this canvas is a declaration: its ports, its fields, what it is allowed to
accept. The validator proves the graph before it can be published — anything that moves pay has to
sit behind a human decision, and this pill is where that is enforced."*

Then open **Runs** and click the most recent run that waited on a human, to show the timeline with
the approval in it.

### Beat 3 — Start from nothing (0:50–1:05)

**Show:** **Workflows → New workflow → Blank**. An empty canvas appears with just a trigger and an
end.

**Say:** *"Now a customer builds one. Nothing about this workflow exists in the codebase — no
template, no component, no branch in the engine. It is going to be built by describing it."*

Click the **Chat** button in the rail. The chat pane docks to the left of the canvas.

**Say:** *"This is the builder agent. It has tools to read the graph, read the node catalogue, and
propose edits. It cannot write the graph directly — every edit goes through the same validator the
canvas uses."*

---

## The prompts

Paste these in order. One message per turn, nothing typed in between. Do not paraphrase them; the
wording is what produced the results below.

> **Prompt 1**
>
> ```
> Point this workflow's trigger at the attendance.missed_break event.
> ```

**Expect:** the trigger's card changes to `attendance.missed_break`. The trail under the reply shows
`update_node`. Measured: **22s**.

**Say:** *"A missed unpaid break. That is a real event the time and attendance service emits, and the
trigger is now listening to it."*

> **Prompt 2**
>
> ```
> Add an AI decision right after the trigger, labelled 'Draft the break adjustment', that reads the timesheet and the award rule and proposes the unpaid break minutes to pay back, citing the award clause as evidence.
> ```

**Expect:** an `ai_decision` node appears between the trigger and the end, wired on both sides. Its
card shows the two declared tools and `timesheet_adjustment` as its output. Measured: **18–30s**.

**Say:** *"It reads the timesheet and the award rule, and it has to cite the clause it applied. That
is the model doing the reasoning, and it is not allowed to write anything yet — it proposes."*

> **Prompt 3**
>
> ```
> After the AI decision add a policy check labelled 'Award check' that validates the proposed adjustment against the award rules, and wire its failed path to a new end labelled 'Left for manual review'.
> ```

**Expect:** a `policy_check` node with a `passed` and a `failed` port, a new end node, and the failed
path wired to it. Measured: **30–70s**.

**Say:** *"Here is the important part, and it is the platform's rule rather than the agent's choice: a
policy check has to wire both of its ports. There is no way to build a graph where the failure path
just falls through."*

**Do not move this check before the AI decision.** It has to run on the *proposal*. Placed before it,
it judges the timesheet itself, which is a violation by definition, and every run goes straight to
the failure path and never reaches the approval.

> **Prompt 4**
>
> ```
> After the policy check's passed path, add a human approval for the roster manager showing the rationale, evidence and pay impact, then an action that applies the adjustment to the timesheet. Wire the approval's rejected path to the manual review end.
> ```

**Expect:** a `human_approval` node and an `action` node, with approved → action and rejected → the
manual review end. Measured: **60–135s**. This is the longest turn; keep narrating over it.

**Say:** *"Nothing is paid without a person. The approval shows what the model proposed, the evidence
it cited, and what it costs — and the action only runs on the approved path."*

> **Prompt 5**
>
> ```
> After the action add an artifact that writes a markdown note naming the employee, the timesheet and the approved break minutes, then wire it into a completed end.
> ```

**Expect:** an `artifact` node after the action, wired into the completed end. Measured: **60s**.

**Say:** *"And it leaves a note behind, because a pay correction that nobody can read later is not an
audit trail."*

> **Prompt 6**
>
> ```
> Read the graph back and tell me in plain English what happens when a break is missed.
> ```

**Expect:** no graph change; a paragraph describing the path. Measured: **12s**.

**Say:** *"That is the agent reading its own work back. It is the same graph the canvas is showing —
one system of record."*

---

### Beat 4 — Publish (about 4:00)

**Show:** type a name in the **Workflow name** field at the top (the agent has no rename tool, so do
it here). Click **Publish**.

**Say:** *"Nine nodes, no validation errors, published as version 1. The version is pinned, so every
run from here is against exactly this graph."*

### Beat 5 — Run it (about 4:15)

**Show:** **Runs → Fire scenario → Payroll exception**.

**Say:** *"This drives the real domain services — the attendance service clocks someone out with no
break taken, and the event goes through its outbox to the engine."*

**Expect two runs to start**, because the seeded payroll workflow also listens to an event from this
scenario. Open the one for your new workflow. It reaches **Awaiting approval**.

Open the approval, read the rationale and the pay impact, type a short reason, and **Approve**.

**Expect:** the run resumes, the action fires, and the artifact appears on the run. Status
**succeeded**.

**Say:** *"A missed break, a proposed correction, a person's decision, and a note that says what
happened and why."*

### Beat 6 — Close (about 4:45)

**Say:** *"The workflow was described, not coded. The platform is the product: the DSL, the
validator, the engine, the provider boundary, and the canvas are all here, and the two domain
services are deliberately thin, because that is what a real integration looks like."*

---

## All six prompts, in one block

```
Point this workflow's trigger at the attendance.missed_break event.

Add an AI decision right after the trigger, labelled 'Draft the break adjustment', that reads the timesheet and the award rule and proposes the unpaid break minutes to pay back, citing the award clause as evidence.

After the AI decision add a policy check labelled 'Award check' that validates the proposed adjustment against the award rules, and wire its failed path to a new end labelled 'Left for manual review'.

After the policy check's passed path, add a human approval for the roster manager showing the rationale, evidence and pay impact, then an action that applies the adjustment to the timesheet. Wire the approval's rejected path to the manual review end.

After the action add an artifact that writes a markdown note naming the employee, the timesheet and the approved break minutes, then wire it into a completed end.

Read the graph back and tell me in plain English what happens when a break is missed.
```

---

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `HTTP 422 ... has no model provider configured` | The tenant has no provider. The e2e suite pins it to `none` deliberately. | Settings → provider → platform provider, pick a model. |
| `domain service returned 412 ... no open timesheet` when firing | The payroll scenario consumes the open timesheet, so it only fires once per seed. | `bun run seed`, then fire again. |
| The agent says a read is stale | The read tool returns the snapshot from the start of the turn. It is a known wrinkle, not a failure; the writes still landed. | Nothing. It is a good moment to say so out loud. |
| A tool call is refused with the legal alternatives | The agent guessed an illegal port or config key. This is the validator working. | Paste the next prompt; it corrects itself. |
| The turn takes longer than two minutes | The vendor stalls. The chat streams, so you can see which tool it is waiting on. | Keep narrating; it recovers. |
| The run goes straight to `Left for manual review` | The policy check is before the AI decision and judged the timesheet rather than the proposal. | Rebuild with the prompts in the order above. |

## What is verified, and what is not

Verified by running it:

- Each move in the six prompts, against the live provider, producing a graph that **publishes with no
  diagnostics**.
- The trigger change on its own: `update_node`, 22s, config becomes `attendance.missed_break`.
- The ordering rule above, by running the workflow both ways: check before the proposal fails the
  guard and never reaches the approval; check after it reaches `awaiting_approval`.
- Firing `payroll_exception` emits `attendance.missed_break` and starts a run for a workflow
  listening to it.
- The streaming turn, the focus ring on the canvas, and the tool rows opening onto their arguments
  and results.

Not verified, so watch for it:

- The six prompts as one continuous session in the order above. Each was run in a session that
  produced the same graph, but the sequence above was assembled from that run rather than recorded
  end to end.
- The approval beat after the run above: the seeded payroll workflow takes that path, and the built
  one was checked at the point where it reached the same shape.
