# ADR-0002: Elysia + Eden for typed boundaries

**Status:** accepted

## Context

Services, the studio API, and the UI are all TypeScript. Hand-written client types drift from the
server, and OpenAPI codegen is a build step nobody keeps honest.

## Decision

Every HTTP boundary is an Elysia app. The studio web app consumes `studio-api` through
`@elysiajs/eden`'s treaty client, which derives call signatures and response types from the server's
route definitions at compile time.

Server-to-server calls from the engine to the domain services use `fetch` plus zod parsing of the
shared `@wfm/contracts` response schemas. Rationale: the engine must not break when a service's
internal route shape changes, and the contracts package is the single source of truth for the domain
verbs the engine is allowed to invoke.

## Consequences

- A rename or payload change in the studio API breaks `bun run typecheck` in the UI — that is the
  feature.
- The engine's dependency on services is expressed through versioned contracts rather than through
  their app types, which keeps the two deployable independently.
