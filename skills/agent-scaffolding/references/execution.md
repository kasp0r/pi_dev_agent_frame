# Executing a framed task graph

`/frame-run` hands an existing scaffold to the parent session for execution.
The parent orchestrates; the generated agents do the work. Execution is only
authorized because the operator invoked `/frame-run` (or explicitly asked for
the scaffold to run) — never start executing a scaffold on your own initiative.

The extension performs filesystem preflight and deterministic planning before
sending the kickoff: it reads `TODO.md`, `ROSTER.md`, and `GOAL.md`, parses task
statuses, applies scope, checks dependencies and roster owners, and supplies an
authoritative launch table. Do not repeat that parsing or invent a different
plan.

## Step 1 — Runtime preflight

1. Confirm pi-subagents is available by calling
   `subagent({ action: "list" })`. If the tool or package is unavailable, stop
   and tell the operator to install pi-subagents. Never improvise another
   execution mode (foreground shell, manual edits "on behalf of" agents) as a
   silent fallback.
2. Verify every task owner in the supplied launch plan appears in the list as an
   executable project agent. Generated agents are project-scoped under
   `.pi/agents/<slug>/` and require project trust. If any owner is missing:
   - Stop and name the missing agents.
   - Suggest trusting the project or restarting the session; check
     `subagent({ action: "list", agentScope: "project" })` to confirm.
   - Never silently substitute a builtin (`worker`, `scout`, …) for a missing
     generated agent. Substitutions need explicit operator approval.

## Step 2 — Honor the computed scope

The extension's launch plan is the source of truth for the initial run:

- **Default scope:** every task not marked `done`.
- **`--phase N`:** unfinished tasks under phase N only.
- **`--from <id>`:** the named task plus every transitive dependent, excluding
  tasks already `done`. Unfinished ancestors of the named task block the run.
- **Both flags:** their scopes combine by intersection. Any unfinished
  dependency outside that intersection blocks the affected task.

Unknown phases or task ids, malformed status rows, unknown owners, cycles, and
cross-scope dependency conflicts are rejected by the command before kickoff.
If every selected task is done, the command reports that and sends no kickoff.

Re-read `TODO.md` before every launch layer — statuses change as work lands. If
its task definitions or statuses differ unexpectedly from the supplied plan,
stop and ask the operator to re-run `/frame-run`; do not silently recompute a
different scope.

## Step 3 — Use the supplied launch plan and gates

The kickoff contains one row per selected task with layer, id, title, owner, and
gate, followed by the parallel members of each layer. Tasks in one layer run in
parallel. The roster guarantees disjoint seams, so same-layer owners should
never touch the same files; if you believe two same-layer writers would,
serialize them and record why in the run summary.

Gates are extracted conservatively from a single backtick-quoted command or the
command before an em dash in Evidence. Other evidence is an artifact for the
parent to verify after the child returns. Never invent a shell gate from vague
evidence prose.

**Dry-run mode: stop here.** Present the supplied table and layer summary; do
not launch anything. End with "Re-run `/frame-run <slug>` without `--dry-run` to
execute." The read-only preflight `list` call in Step 1 is fine.

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
- `agent`: the task owner, exactly as named in the launch plan.
- `gate`: the supplied command, when present.
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
  command summary). Keep checkbox and progress status in sync.
- Failed, blocked, or evidence missing → set the row to `blocked` with a
  one-line reason, and mark its downstream dependents `blocked` as well.
  Continue independent branches; never launch a layer on failed inputs.
  Surface failures in the final report — do not loop silent retries.

Only the orchestrator edits `TODO.md` during the run. Use targeted edits so
the plan's `git diff` stays reviewable. Continue with the next supplied layer
only when all its dependencies are `done`.

## Step 6 — Stop at the scope boundary

- **`--phase N`:** when the phase's selected tasks resolve, summarize what
  landed (with evidence) and stop for review. Offer `/frame-run <slug> --phase
  N+1` when that phase exists, or plain `/frame-run <slug>` as the next step.
- **Default / `--from`:** run until the selected scope is exhausted, then deliver
  the final report: tasks done with evidence, tasks blocked with reasons,
  residual risks, and any `GOAL.md` open questions still unresolved.
- **Combined flags:** stop at the intersection; do not continue into other
  phases or unrelated dependents.

Keep per-layer chatter out of chat. The report is the deliverable; transcripts
and artifacts stay on disk under pi-subagents' run directories.
