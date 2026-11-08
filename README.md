# pi-agent-frame

<p align="center">
  <img src="./frame.jpeg" alt="pi-agent-frame" width="160">
</p>

**Frame the problem before launching agents.** `pi-agent-frame` turns a goal into
a minimal worker roster, mission-specific `AGENT.md` definitions, and a shared
`TODO.md` with explicit ownership, dependencies, acceptance criteria, and
evidence.

It is a [pi](https://pi.dev) package with two commands:

- **`/frame`** designs and writes a reviewable execution scaffold; it launches
  nothing.
- **`/frame-run`** validates an existing scaffold, computes its launch layers,
  and hands that deterministic plan to [pi-subagents](https://github.com/nicobailon/pi-subagents).

## Quick start

```bash
# From a local checkout
pi install /absolute/path/to/pi-agent-frame

# Or install a published npm/git source
pi install npm:pi-agent-frame
pi install git:github.com/<owner>/pi-agent-frame
```

Then, inside pi:

```text
# 1. Frame the goal — writes files, but executes nothing
/frame add a rate-limited public API for items

# 2. Review the generated plan and agents
#    .pi/frame/items-api/{GOAL,ROSTER,TODO}.md
#    .pi/agents/items-api/*/AGENT.md

# 3. Preview the exact launch layers without launching agents
/frame-run items-api --dry-run

# 4. Execute the reviewed plan
/frame-run items-api
```

To try the package without installing it:

```bash
pi -e /absolute/path/to/pi-agent-frame
```

## What gets generated

```text
.pi/
├── frame/
│   └── items-api/
│       ├── GOAL.md        # verbatim goal, criteria, constraints, risks, questions
│       ├── ROSTER.md      # agent roles, capabilities, ownership, and assignments
│       └── TODO.md        # phase-grouped task graph and progress log
└── agents/
    └── items-api/
        ├── api-implementer/AGENT.md
        ├── limiter-reviewer/AGENT.md
        └── integration-verifier/AGENT.md
```

Plan-scoped agent directories prevent one plan from overwriting another plan's
files. Runtime agent names still share pi-subagents' project namespace, so keep
names unique across discovered project agents.

See the generated, committed [`examples/items-api/`](./examples/items-api/)
scaffold for complete output.

## Frame a goal: `/frame`

```text
/frame
/frame add a rate-limited public API for items
/frame --out docs/plan --agents .pi/agents/items-api --name items-api "add a rate-limited API"
```

Without an inline goal, `/frame` opens a multi-line editor. In a session without
a UI, pass the goal inline. `/scaffold-agents <goal description>` is also
available as a prompt-template entry point.

The framing workflow:

1. Inspects the repository and existing agents before designing anything.
2. Records the summary, success criteria, constraints, non-goals, risks, and
   genuinely open questions.
3. Chooses the smallest roster with one accountable owner per task and one
   writer per component seam.
4. Builds an acyclic, phase-grouped graph with objective acceptance and named
   evidence.
5. Calls `frame_scaffold` to validate and persist the result.

### `/frame` flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` (alias `--plan-dir`) | `.pi/frame/<slug>` | Destination for `GOAL.md`, `ROSTER.md`, and `TODO.md` |
| `--agents <dir>` (alias `--agents-dir`) | `.pi/agents/<slug>` | Destination for `<agent>/AGENT.md` files |
| `--name <slug>` (alias `--slug`) | Derived from the goal | Stable plan slug and default directory name |
| `--allow-outside-cwd` | Off | Explicitly permit output outside the project root |

Value flags accept both `--flag value` and `--flag=value`. Quote values containing
spaces. Use `--` before a goal beginning with `--`:

```text
/frame -- --dry-run means document the behavior, not execute it
```

Unknown options, missing values, and unterminated quotes are rejected before
framing starts. Unsafe output paths are rejected before any file is written.

## Execute a plan: `/frame-run`

```text
/frame-run                       # newest plan under .pi/frame/
/frame-run items-api             # select a plan by slug
/frame-run items-api --phase 2   # execute one phase, then stop for review
/frame-run items-api --from T3   # resume at T3 plus its unfinished dependents
/frame-run items-api --dry-run   # show launch layers without launching
/frame-run --plan docs/plan      # execute a plan outside the default frame root
```

### `/frame-run` flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--phase <n>` | All phases | Select a positive integer phase, then stop at its boundary |
| `--from <task>` | — | Select a task and its transitive dependents, excluding completed tasks |
| `--dry-run` | Off | Present the computed launch table without launching subagents |
| `--plan <dir>` (alias `--plan-dir`) | `.pi/frame/<slug>` | Read a plan written to a custom `--out` directory |

When `--phase` and `--from` are combined, their scopes **intersect**. An
unfinished dependency outside the selected scope blocks execution instead of
being silently added.

### Deterministic preflight

Before sending work to the parent session, `/frame-run`:

- Reads `GOAL.md`, `ROSTER.md`, and `TODO.md`.
- Parses tasks, dependencies, owners, phases, and progress statuses.
- Rejects unknown scope targets, missing roster owners, duplicate or unknown
  dependencies, cycles, malformed task metadata, and conflicting checkbox/log
  completion states.
- Skips tasks marked `done` and reports when nothing remains.
- Computes ordered launch layers; independent tasks share a parallel layer.
- Supplies the parent with the resulting task table instead of asking the model
  to reconstruct the graph.

The parent still verifies that every owner is an executable project agent with
`subagent({ action: "list" })`. Missing agents are never silently replaced with
builtins.

### Status and evidence contract

Use these progress-log statuses:

```text
todo · in-progress · blocked · review · done
```

A task is `done` only when its acceptance criteria are met and evidence is
attached. Keep its checkbox and progress-log status in sync.

Evidence can name an artifact, report, or command. A single backtick-quoted
command, or a clear command before an em dash, becomes a conservative host-run
gate:

```text
`npm test`
npm test — items route and rate-limiter tests pass
Review report with verdict: ok or blocked   # artifact evidence; no shell gate
```

Review gates during `--dry-run`. During execution, the orchestrator alone edits
`TODO.md`; children report status and evidence instead of racing on the shared
file. Re-reads between layers make interrupted runs resumable.

### Watch or intervene

```text
/subagents-fleet                 # live run inspector
/subagent-cost                   # token and cost rollup
/subagents-steer <run-id> ...    # guide a live child
/subagents-stop <run-id>         # stop a run
```

`TODO.md` also provides a reviewable audit trail:

```bash
git diff .pi/frame/items-api/TODO.md
```

If execution stops at agent discovery, trust/restart the project and check
`subagent({ action: "list", agentScope: "project" })`. `/subagents-doctor` can
help diagnose the pi-subagents setup.

## Agent capabilities

Write access is explicit; task titles never grant tools implicitly:

- `access: "read-only"` is the default for recon, design, research, and review.
- `access: "writer"` gives implementation roles the default writer allowlist.
- `tools` can override the default allowlist when a role needs a narrower or
  specialized set.

Generated frontmatter includes a matching `acceptanceRole` for pi-subagents:

```yaml
---
name: api-implementer
description: Implements the public API seam
acceptanceRole: writer
tools: read, grep, find, ls, bash, edit, write
---
```

`access` is a generator input; generated agents expose its effect through the
tool allowlist and `acceptanceRole`. Read-only agents must not list `edit` or
`write`. See
[`skills/agent-scaffolding/references/agent-authoring.md`](./skills/agent-scaffolding/references/agent-authoring.md)
for prompt and ownership guidance.

## The `frame_scaffold` tool

The model designs the plan; `frame_scaffold` validates and writes it
deterministically. Validation covers:

- Required goal, framing summary, and success criteria.
- Unique kebab-case agent names and defined task owners.
- Stable task IDs such as `T1` and `T1.2`, known dependencies, and no cycles.
- Explicit access roles and valid thinking levels.
- Project-confined output paths and symlink escapes.
- Idle-agent and oversized-roster warnings.

Existing files require `overwrite: true`. Writes use temporary sibling files,
bounded concurrency, and atomic no-replace commits when overwrite is disabled.
Commit failures trigger rollback of targets already changed by that call;
rollback failures are surfaced. Abort signals cancel in-flight work and initiate
cleanup.

You normally do not call this tool directly. It is available for regeneration
or repair, but overwriting another plan's files still requires explicit review.
Use `allowOutsideCwd: true` only when the operator approved external paths.

## Troubleshooting

### Framing completed, but the fleet is empty

That is intentional: `/frame` never launches agents. Review the scaffold and run
`/frame-run <slug>`.

### `/frame-run` reports a malformed plan or scope

Fix the reported `TODO.md`/`ROSTER.md` mismatch, or choose a valid phase/task from
the error. If dependencies are unfinished outside the requested scope, widen
the scope or complete those dependencies first. Re-running is safe: completed
tasks are skipped.

### The command says everything is done

All selected tasks already have synchronized checked boxes and `done` progress
rows. Use a different scope or create a new frame instead of forcing a rerun.

### Generated agents are missing

Project agents require project trust and may require a restart after creation.
Confirm discovery with `subagent({ action: "list", agentScope: "project" })`.
Check for runtime-name collisions with existing project agents as well.

### The wrong plan was selected

Without a slug, the newest `TODO.md` wins. Pass the slug explicitly. For custom
output locations, use `/frame-run --plan <dir>`.

### `/frame-run` is unavailable or refused while busy

Restart/reload pi so the current extension is loaded. If the agent is mid-turn,
wait for it to finish and retry. You can test a checkout directly with
`pi -e /path/to/pi-agent-frame`.

## Requirements

- Pi `>= 0.80`.
- [pi-subagents](https://github.com/nicobailon/pi-subagents) for execution;
  version 0.84 is exercised by the package integration test.
- An interactive UI for the editor prompt, or an inline goal in non-UI mode.
- Node.js 22 or 24 for the supported development/CI matrix.

## Development

```bash
npm ci
npm run check              # strict typecheck + all tests + package dry run
npm run check:examples     # regenerate examples and verify no stale diff
```

Key sources:

```text
extensions/agent-frame.ts    # commands, schemas, and Pi-facing tool
lib/scaffold-core.ts         # indexed renderers, validation, staged writer
lib/execution-core.ts        # TODO parser, scope selection, launch planner
lib/concurrency.ts           # bounded independent-async operations
skills/agent-scaffolding/    # framing and execution methodology
scripts/pi-rpc-client.mjs    # bounded JSONL RPC client for programmatic tests
scripts/live-acceptance.mjs  # opt-in real-model acceptance workflow
test/                        # unit, smoke, and packed-runtime integration tests
```

Tests load TypeScript through jiti, matching pi's runtime loader. The packaging
test installs the tarball, parses and discovers a generated agent with real
YAML/pi-subagents code, and loads the packed extension through Pi RPC without
making model calls.

### Live acceptance (real model calls)

```bash
# Frame, validate discovery, reject an invalid phase, and verify dry-run.
# Makes provider calls, but never launches task agents.
npm run test:acceptance

# Additionally execute phase 1, stop at its boundary, resume phase 2, verify
# exact artifacts/evidence, rerun idempotently, and frame a second plan.
npm run test:acceptance -- --execute
```

The harness packs and installs the package, starts Pi RPC in a temporary project,
and uses the configured provider credentials. Use `--model <id>` or
`PI_AGENT_FRAME_ACCEPTANCE_MODEL` to select a model. Ambient extensions are
disabled for reproducibility; load a custom provider explicitly with repeatable
`--extension <path>` flags. Every live stage has a
timeout (`PI_AGENT_FRAME_ACCEPTANCE_TIMEOUT_MS`, default 240000 ms). Failures
preserve RPC transcripts and diagnostics, abort the parent, and stop active
children. Use `--keep` to retain artifacts after success.

Live acceptance is intentionally excluded from normal tests and CI because it
can incur provider charges and model behavior can vary. The offline RPC client
and harness assertions are covered by ordinary unit tests.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution rules and
[CHANGELOG.md](./CHANGELOG.md) for notable changes.

## Security

Pi packages and generated agents run with system access. Review generated
prompts, ownership boundaries, tool allowlists, and execution gates before
running them.

Output is confined to the project by default, including checks for existing
symlink ancestors and symbolic-link targets. External paths require explicit
operator approval. `/frame` does not execute generated content; shell gates run
only as part of an operator-invoked `/frame-run` workflow.

## Author

[kasp0r](https://github.com/kasp0r)

## License

[MIT](./LICENSE) — use, modify, and distribute freely. Contributions are welcome.
