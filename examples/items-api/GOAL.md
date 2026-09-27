# Goal — Items API

> Framed by `pi-agent-frame` on 2026-01-15 · slug: `items-api`

## Goal (verbatim)

> Add a rate-limited public API for items: GET and POST /v2/items backed by the existing in-memory store, with a sliding-window rate limiter (100 requests/minute per IP), covered by tests.

## Problem framing

The service exposes no public read/write API for items. Add GET and POST /v2/items on the existing in-memory store, guarded by a sliding-window limiter of 100 requests per minute per IP, and prove the behavior with automated tests.

## Success criteria

- [ ] GET /v2/items returns 200 with the seeded fixture items
- [ ] POST /v2/items creates an item and returns 201
- [ ] The 101st request within one minute from one IP returns 429
- [ ] npm test passes

## Constraints

- Use the existing in-memory store; no new dependencies
- Keep the public API under /v2

## Non-goals

- Authentication or per-user quotas
- Persistent storage

## Risks

- Sliding-window bookkeeping under concurrent requests
- Test flakiness from time-based assertions

## Open questions

- Should the 429 response include a Retry-After header?

## Related artifacts

- [`TODO.md`](./TODO.md) — the shared work graph
- [`ROSTER.md`](./ROSTER.md) — agent roster, ownership, and boundaries
- Generated agents live under `examples/items-api/agents`
