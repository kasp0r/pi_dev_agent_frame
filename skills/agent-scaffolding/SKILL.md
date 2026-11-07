---
name: agent-scaffolding
description: Frame a goal into a minimal roster of subagent workers, generate their AGENT.md definitions, and write a shared TODO.md task graph for agentic execution. Use when the user wants to decompose a goal into agents, scaffold multi-agent execution, plan a mission, or when /frame is invoked.
---

# Agent Scaffolding

Turn an underspecified goal into an executable multi-agent scaffold: a framed
problem statement, a minimal roster of specialized workers, one `AGENT.md` per
worker, and a shared `TODO.md` that every agent works toward.

The point is **problem framing**, not ceremony. A good scaffold makes ownership
and sequencing obvious; a bad one invents agents that have nothing to do.

## Deliverables

Calling the `frame_scaffold` tool writes:

| File | Purpose |
| --- | --- |
| `<planDir>/GOAL.md` | Framed problem: verbatim goal, summary, success criteria, constraints, non-goals, risks, open questions |
| `<planDir>/ROSTER.md` | Agent roster, responsibilities, owned tasks, and coordination rules |
| `<planDir>/TODO.md` | Phase-grouped task graph with owners, dependencies, acceptance criteria, and evidence |
| `<agentsDir>/<name>/AGENT.md` | One subagent definition per worker (frontmatter + system prompt + mission assignment) |

Defaults: `<planDir>` = `.pi/frame/<slug>`, `<agentsDir>` =
`.pi/agents/<slug>`. The plan slug isolates mission-specific definitions, so
another plan can reuse an agent name without overwriting this plan's workers.
Generated agents are project-scoped and require project trust to load.

Do **not** hand-write these files. Decide the content, then call `frame_scaffold`
once. The tool validates names, owners, dependencies, and cycles before writing
and refuses to overwrite unless `overwrite: true`.

## Inputs

- The goal (verbatim), provided by the user or injected by `/frame`.
- Overrides: `planDir`, `agentsDir`, `slug`.
- The current repository/workspace, which you should inspect before designing.

## Step 1 — Recon before you design

Gather just enough context to make the roster concrete. Depending on the goal,
use `ls`, `find`, `grep`, and `read` to establish:

- What already exists (stack, entry points, tests, docs, existing agents).
- Natural seams (modules, services, layers, data boundaries).
- Hard constraints (frameworks, APIs, performance, deadlines, compliance).
- Existing agent definitions under `.pi/agents` or `~/.pi/agent/agents` to avoid
  name collisions and redundant workers.

If the codebase is large and delegation is authorized, a single `scout` subagent
is a reasonable way to summarize it. Otherwise inspect directly. Do not start
writing agent definitions before recon.

## Step 2 — Frame the goal

Produce a problem statement that a new teammate could act on:

- **summary** — 2–4 sentences: what "done" means and why it is hard.
- **successCriteria** — observable, checkable outcomes (commands, behaviors,
  artifacts). These become the mission definition of done.
- **constraints** — non-negotiable boundaries.
- **nonGoals** — explicitly out of scope, to stop scope creep.
- **risks** — what is most likely to go wrong.
- **openQuestions** — decisions that are genuinely unresolved.

If a missing answer would change the roster or sequencing, ask the user **one or
two** targeted clarifying questions. Otherwise record it under `openQuestions`
and proceed. Never invent requirements as if they were confirmed.

## Step 3 — Decide the roster

Design the **smallest** set of agents that covers every task with a distinct
owner. Each agent must own a seam; if two agents would touch the same files,
merge them or separate the work in time via the task graph.

Heuristics:

- **Read-only first.** Recon, research, and design agents produce evidence;
  writer agents implement. Set `access: "writer"` for implementation roles and
  use the default `access: "read-only"` for designers and reviewers. Do not rely
  on task-title keywords to infer write access.
- **One writer per seam.** Parallel writers on the same files are the most
  common multi-agent failure. Partition by component, not by convenience.
- **Add a gate, not a cheerleader.** Include a reviewer/verifier when correctness
  matters, with a distinct evidence standard. Avoid redundant reviewers.
- **Prefer 2–5 agents.** More than six usually means the decomposition is too
  fine or the goal is several goals. Note this in `warnings` if you exceed it.
- **Name for the seam, not the vibe.** `api-implementer`, `schema-reviewer`,
  `integration-verifier` — not `helper-2`.
- **Avoid colliding with builtins** (`scout`, `worker`, `reviewer`, `oracle`,
  `researcher`, `delegate`) unless you are deliberately specializing and
  overriding one; in that case say so in the responsibility.

For each agent provide:

- `name` — unique lower-case kebab-case.
- `role` — short label.
- `description` — one line, used during agent discovery.
- `responsibility` — what it owns end-to-end.
- `access` — `"read-only"` (default) or `"writer"`; writers receive edit/write
  tools by default and a matching pi-subagents `acceptanceRole`.
- `tools` — an optional strict allowlist overriding the access default.
  Read-only: `read, grep, find, ls`. Writers: `read, grep, find, ls, bash, edit, write`.
  Never combine `access: "read-only"` with `edit` or `write`.
- `thinking` — optional (`low`/`medium`/`high`/`xhigh`) for genuinely hard roles.
- `systemPrompt` — a real working prompt: mission, boundaries, method, quality
  bar, what to report, and when to escalate. See
  [agent-authoring.md](references/agent-authoring.md).

## Step 4 — Build the task graph

Decompose the work into tasks that can be independently verified, grouped into
phases. A reliable default sequence:

1. **Recon** — understand the system and constraints.
2. **Design** — decide interfaces/contracts before parallel work starts.
3. **Implement** — parallel, partitioned by seam.
4. **Verify** — test against acceptance criteria.
5. **Integrate** — assemble, resolve conflicts, run end-to-end checks.
6. **Harden** — docs, cleanup, edge cases, rollout.

For each task provide:

- `id` — stable (`T1`, `T2`, `T3.1`, …).
- `title` — imperative.
- `owner` — exactly one agent name.
- `phase` — a phase label (defaults to `Execution`).
- `dependsOn` — task ids that must finish first. Keep the graph acyclic.
- `acceptance` — objectively checkable definition of done.
- `evidence` — the artifact or command output that proves it.

Rules: every task has one owner; dependencies only point backward in time;
shared/integration work depends on the writers that feed it. See
[todo-format.md](references/todo-format.md).

## Step 5 — Persist with `frame_scaffold`

Call the tool **exactly once** with the full plan:

```
frame_scaffold({
  goal,                       // verbatim user goal
  title, slug,                // optional; slug is derived when omitted
  framing: { summary, successCriteria, constraints?, nonGoals?, risks?, openQuestions? },
  agents: [{ name, role?, description, responsibility?, access, tools?, thinking?, systemPrompt }],
  tasks:  [{ id, title, owner, phase?, dependsOn?, acceptance, evidence? }],
  planDir?, agentsDir?,       // optional overrides from /frame
  overwrite?,                 // only when the user asked to replace existing files
  allowOutsideCwd?            // only with explicit operator approval
})
```

Output paths stay inside the project unless the operator explicitly passed
`--allow-outside-cwd`; in that case set `allowOutsideCwd: true`. Writes are
staged and rolled back on failure, and support cancellation.

If the tool returns validation errors, fix the plan and call it again. Do not
fall back to writing files by hand. If it reports that files already exist, do
not silently overwrite: either choose a new `slug`/`planDir`, or ask the user
before re-running with `overwrite: true`.

## Step 6 — Verify

After the tool succeeds:

- Confirm the reported files exist and read `TODO.md` back to check the graph.
- If the `pi-subagents` package is installed, call
  `subagent({ action: "list" })` to confirm the generated agents were discovered
  with the expected names and descriptions.
- Check that no generated agent name silently overrides an existing project
  agent in a way the user did not ask for.

## Step 7 — Hand off

Close with a short summary:

- The framed goal in one sentence.
- The roster (name → one-line responsibility).
- The critical path through `TODO.md`.
- The recommended first actions, and how to execute — typically the operator
  runs `/frame-run <slug>` once they have reviewed the scaffold, which injects
  the execution workflow in [execution.md](references/execution.md) and drives
  the task graph through `pi-subagents`.
- Any open questions that need the user before execution starts.

## Anti-patterns

- Agents without tasks, or tasks without a single accountable owner.
- Giving every agent `bash, edit, write` "just in case".
- A task named "implement everything" that hides the decomposition.
- Circular dependencies or tasks that depend on work that does not exist.
- Generating a scaffold and then executing it in the same breath; the scaffold
  is a proposal for the user to review first, unless they asked to run it.
- Treating `TODO.md` as documentation instead of the shared coordination file:
  owners must update status and evidence as work lands.
