# Executing a framed task graph

`/frame-run` hands an existing scaffold to the parent session for execution.
The parent orchestrates; the generated agents do the work. Execution is only
authorized because the operator invoked `/frame-run` (or explicitly asked for
the scaffold to run) — never start executing a scaffold on your own initiative.

The kickoff message supplies the plan directory, slug, mode (execute |
dry-run), and scope (all | phase | from task). Paths below are inside the plan
directory unless absolute.

## Step 1 — Preflight

1. Read `TODO.md`, `ROSTER.md`, and `GOAL.md` — in that order.
2. Confirm pi-subagents is available by calling
   `subagent({ action: "list" })`. If the tool or package is unavailable, stop
   and tell the operator to install pi-subagents. Never improvise another
   execution mode (foreground shell, manual edits "on behalf of" agents) as a
   silent fallback.
3. Verify every task owner in scope appears in the list as an executable
   project agent. Generated agents are project-scoped under `.pi/agents` and
   require project trust. If any owner is missing:
   - Stop and name the missing agents.
   - Suggest trusting the project or restarting the session; check
     `subagent({ action: "list", agentScope: "project" })` to confirm.
   - Never silently substitute a builtin (`worker`, `scout`, …) for a missing
     generated agent. Substitutions need explicit operator approval.

## Step 2 — Determine scope

Read task statuses from the `TODO.md` progress log. Re-read `TODO.md` before
every launch layer — statuses change as work lands.

- **Default scope:** every task not marked `done`.
- **`--phase N`:** only tasks under `### Phase N — …`. If headers are not
  numbered, count phase sections in order of appearance. No matching phase →
  list the phases that exist and stop.
- **`--from <id>`:** the named task plus every task that transitively depends
  on it, excluding tasks already `done`. Unknown id → list the known ids and
  stop. If the named task has unfinished dependencies of its own, report the
  conflict and stop — do not silently pull them into scope.
- If everything in scope is already `done`, say so and launch nothing.

## Step 3 — Build the launch plan

Topologically layer the in-scope tasks: a task joins the earliest layer whose
`dependsOn` ids are all `done` or placed in earlier layers.

- Tasks in one layer run in parallel. The roster guarantees disjoint seams,
  so same-layer owners should never touch the same files; if you believe two
  same-layer writers would, serialize them and record why in the run summary.
- For each task, decide its gate: when the Evidence field names one clearly
  extractable shell command (e.g. `npm test`), that command becomes a host-run
  `gate`. Artifact evidence (a report file, a fixture) has no gate — the
  parent verifies it after the child returns.

**Dry-run mode: stop here.** Present the plan as a table — one row per task
with layer, id, title, owner, gate — plus one line per layer noting what runs
in parallel. End with "Re-run `/frame-run <slug>` without `--dry-run` to
execute." Do not launch anything (the read-only preflight `list` call in
Step 1 is fine).

## Step 4 — Launch, one layer at a time

Use one async `workflowScript` per layer: `runs.all([...])` over the layer's
tasks, awaited, results returned. Per-layer scripts — not one giant script for
the whole graph — keep `TODO.md` current and give the operator natural
checkpoints. Yield while a layer runs; pi-subagents wakes the parent on
completion, so do not poll.

Each child item:

- `key`: the lower-cased task id (e.g. `t2`).
- `label`: short verb + behavior from the task title
  (e.g. `Implement items endpoint`).
- `agent`: the task owner, exactly as named in `ROSTER.md`.
- `gate`: the extracted command, when Step 3 identified one.
- `task`: a compact brief containing, in order:
  1. the task id and title,
  2. the absolute plan-directory path,
  3. the acceptance criteria, verbatim from `TODO.md`,
  4. the evidence required,
  5. context inherited from earlier layers (prior outputs, contracts,
     decisions) — children start fresh and cannot see sibling results,
  6. this override, verbatim in meaning: **"The orchestrator owns `TODO.md`
     for this run. Do not edit `TODO.md` yourself; report status and evidence
     in your final message."**

The last point overrides the stock instruction in generated `AGENT.md` files
("update the task status in `TODO.md` as you complete work"). Concurrent
children would race on that shared file, so the parent records results.

Keep default async/background behavior and default models. Do not put hard
tool budgets on writer agents. Use `subagent({ action: "status" })` for
spot checks and `steer`/`stop` when a child genuinely needs intervention.

## Step 5 — Record results between layers

As each layer returns, update `TODO.md` for every child:

- Acceptance met with evidence → check the `- [ ]` box, set the progress-log
  row to `done`, and attach the evidence (gate result, artifact path, or
  command summary).
- Failed, blocked, or evidence missing → set the row to `blocked` with a
  one-line reason, and mark its downstream dependents `blocked` as well.
  Continue independent branches; never launch a layer on failed inputs.
  Surface failures in the final report — do not loop silent retries.

Only the orchestrator edits `TODO.md` during the run. Use targeted edits so
the plan's `git diff` stays reviewable.

## Step 6 — Stop at the scope boundary

- **`--phase N`:** when the phase's tasks resolve, summarize what landed (with
  evidence) and stop for review. Offer `/frame-run <slug> --phase N+1` or
  plain `/frame-run <slug>` as the next step.
- **Default / `--from`:** run until the scope is exhausted, then deliver the
  final report: tasks done with evidence, tasks blocked with reasons,
  residual risks, and any `GOAL.md` open questions still unresolved.

Keep per-layer chatter out of chat. The report is the deliverable; transcripts
and artifacts stay on disk under pi-subagents' run directories.
