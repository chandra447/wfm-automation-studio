# Demo script (5 minutes, screen recording)

Record at 1440x900, dark UI, no window chrome. Have `scripts/verify.sh` already run once so the data is seeded. Speak in short sentences and let the screen carry the detail.

## 0:00 to 0:40 — the problem

Show `docs/design.md` §1.

> "Humanforce has a large estate of services. Rostering, time and attendance, awards, payroll. They all change state. This is a workflow platform over those events, where customers compose the workflows and a human keeps authority over anything that touches pay."

## 0:40 to 2:00 — the builder

Open `/builder`, load the coverage rescue template.

> "A workflow is data. A trigger, an AI decision, a policy check, a human approval, an action. The customer drags these onto the canvas."

Point at the validation panel.

> "The platform enforces invariants. Every path to a pay-affecting action must pass through a policy check and a human approval. Here I will delete the approval node."

Delete it, show the error on the action node, and show that Save is blocked with the reason.

> "That is the difference between a script and a platform. The customer gets freedom, the platform keeps the rules."

Restore the node, then publish.

## 2:00 to 3:20 — the run and the human

Open the overview and press "Sick call before a shift".

> "That cancels a shift on the rostering service 7.5 hours before it starts. The service writes the change and the event in one transaction. The event lands on the backbone."

Open the run.

> "The engine resolved the shift, ranked eligible staff, checked the rest rule, and computed a cost delta. It is parked, waiting for a roster manager."

Open the timeline. Point at the proposal's rationale and evidence, then the pay impact.

> "The model reasoned, it did not decide. The policy check is deterministic, and nothing has been written yet."

Open `/approvals`, approve with a reason.

> "Approving resumes the graph from its checkpoint. Offers go out with an idempotency key."

Switch to the shift and show the offers exist. Then show the replay attempt.

> "Approving twice cannot apply twice. That is the idempotency key, not a hope."

## 3:20 to 4:20 — the payroll-safe path

Press "Missed break with overtime" on the overview.

> "Marcus clocked out of an 8.25 hour shift without taking his unpaid break. The award requires one after five hours."

Open the run, then the approval.

> "The engine read the timesheet and the award rule, drafted the adjustment, and computed the pay impact. It is positive, so the employee was underpaid. This goes to People Ops, always, because it moves pay."

Approve as People Ops. Show the timesheet now reads adjusted with the new total.

> "The audit row names the approver, the rule, the evidence, and the command."

## 4:20 to 5:00 — the engineering

Show `scripts/verify.sh` output, then `docs/jd-mapping.md`.

> "One command proves it. Outbox with at-least-once delivery, dedupe on event id, retries with backoff, dead letters, approvals that survive a restart because the graph is checkpointed in Postgres, and every command idempotent."

Close on `docs/adr/` .

> "Nine decisions with their trade-offs, including what I deliberately did not build."

## Things to avoid saying

- Do not call it a Humanforce product. It is a demo built on their public domain model.
- Do not claim the LLM path is used in the recording unless an API key is set. The rules proposer is a supported mode, not a fallback.
- Do not claim production readiness. Say "production mapping" and point at the ADR.
