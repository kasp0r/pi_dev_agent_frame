# TODO.md task-graph reference

`TODO.md` is the shared coordination file every generated agent reads. It is not
a wish list; it is the contract for who does what, in what order, and how
completion is proven.

## Structure

```markdown
# TODO — <title>

## Definition of done (mission)
- [ ] <success criterion>

## Task graph
### Phase 1 — Recon
- [ ] **T1** — <imperative title>
    - owner: `scout` · depends: none
    - Acceptance: <objectively checkable>
    - Evidence: <command / artifact>

### Phase 2 — Implement
- [ ] **T2** — <imperative title>
    - owner: `api-implementer` · depends: `T1`
    - Acceptance: <...>

## Progress log
| Task | Owner | Status | Evidence / link |
| --- | --- | --- | --- |
| `T1` | `scout` | todo | — |
```

## Authoring rules

1. **One owner per task.** The `owner` must be the name of a defined agent. If a
   task seems to need two owners, split it.
2. **Acyclic dependencies.** `dependsOn` may only reference other task ids and
   must not form a cycle. The scaffold tool rejects cycles before writing.
3. **Phases communicate sequencing.** Use `Recon → Design → Implement → Verify →
   Integrate → Harden` unless the goal demands a different shape.
4. **Acceptance is objective.** "Works well" is not acceptance. "`pnpm test`
   passes and `/v2/items` returns 200 for the fixture" is.
5. **Evidence is named up front.** Decide what proof will be attached before the
   work starts, so "done" cannot drift.
6. **Integration depends on its inputs.** Assemble/integrate tasks must depend on
   every writer that produces their inputs, keeping one writer per seam.
7. **Keep the graph small.** Roughly 6–20 tasks. Push implementation detail into
   the relevant `AGENT.md` instead of exploding the graph.

## Status vocabulary

Use one of `todo`, `in-progress`, `blocked`, `review`, `done` in the progress
log. A task is only `done` when its acceptance criteria are met and evidence is
recorded. Agents should update this file as work lands.

## Why checkboxes

The `- [ ]` markers make progress scannable in the transcript and in git diffs,
and give both humans and agents a single unambiguous completion signal.
