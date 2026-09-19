# ADR-0010: Canvas state lives on the server, with geometry beside the definition

**Status:** accepted

## Context

A React Flow canvas has two kinds of state that look like one: the executable definition (which nodes exist, what they do, how they connect) and the presentation (where each node sits, the viewport, what is selected). Mixing them makes the definition fragile, because a drag would produce a new workflow version and every run would pin a different one.

A builder also has to survive a refresh, a crash, and a second tab.

## Decision

**Server is the system of record.** Two tables in the studio database:

- `workflows` holds identity, name, description, enabled, and pointers to the current draft and published version numbers;
- `workflow_versions` holds an immutable row per version: `definition` (the DSL), `layout` (viewport and per-node positions), `diagnostics`, `created_by`, and `status` (`draft` or `published`).

**Geometry never enters the definition.** `layout` is stored beside it and read only by the canvas. Dragging a node does not change the workflow's meaning, and the validator never sees coordinates.

**Versions are immutable and runs pin them.** Saving replaces the current draft in place; publishing snapshots it as a published version. Every run stores `workflow_version_id`, so editing a workflow cannot change a run that is mid-approval.

**Autosave plus a local safety net.** The canvas debounces a draft save on 1500ms idle, and mirrors the unsaved draft to `localStorage` keyed by workflow id. On load, if the local draft is newer than the server's, the user is offered a restore. The local copy is recovery, never the source of truth.

**Conflicts are visible.** A save carries the version number it was based on; a mismatch returns 409 and the canvas shows a conflict banner offering a reload rather than silently overwriting someone else's edit.

## Consequences

- A reviewer can open two tabs, edit in both, and see the conflict rather than a lost edit.
- Runs are reproducible: the definition that produced a decision is still readable after the workflow changes.
- The engine's `WorkflowDetail` response is the canvas's load path, so the UI has no separate persistence model.
- Cost: two tables and a version join. Worth it for the audit story, which is the point of the product.
