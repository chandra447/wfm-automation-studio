# ADR-0008: Demo authentication boundary

**Status:** accepted

## Context

The engine must be tenant-aware and approvals must be authorised (only a roster manager approves a
roster change; only People Ops approves a pay-impacting adjustment). Standing up Entra ID + RBAC is
out of scope for a shareable demo, but faking authorisation entirely would hide the important part.

## Decision

Every request carries an actor context: `x-tenant-id`, `x-user-id`, `x-user-roles`,
`x-employee-id` (optional). Services and the studio API parse it through one `@wfm/contracts` helper
and enforce:

- tenant scoping on every query, event, run, and approval;
- role checks on approval decisions (`roster_manager` or `people_ops` per workflow, and the approver
  must belong to the tenant that owns the run);
- an explicit, auditable record of who approved what, with the actor id persisted.

## Consequences

- The authorisation model is visible and testable (there is a negative test: a user without the role
  cannot approve).
- Swapping in Entra ID means replacing the header parser with token validation; the policy checks and
  audit records do not change.
