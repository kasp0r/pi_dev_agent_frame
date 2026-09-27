# pi-agent-frame

<p align="center">
  <img src="./frame.jpeg" alt="frame" width="160">
</p>

Frame a goal into an executable multi-agent scaffold: a minimal roster of
specialized workers, one `AGENT.md` per worker, and a shared `TODO.md` that all
of them work toward.

`pi-agent-frame` is a [pi](https://pi.dev) package. It exists to help you **frame
the problem** before you run agents, then hand you ready-to-load subagent
definitions and a concrete task graph.

## What it does

When triggered, it:

1. **Asks for the goal** — a multi-line editor prompt (or an inline argument).
2. **Decides the workers** — following the `agent-scaffolding` skill, the agent
   inspects the workspace and designs the smallest roster that covers the work.
3. **Generates subagents** — one `AGENT.md` per worker under `.pi/agents/`, ready
   for [pi-subagents](https://github.com/nicobailon/pi-subagents) discovery.
4. **Writes `TODO.md`** — a phase-grouped task graph with a single owner,
   dependencies, acceptance criteria, and evidence for every task.

## Install

```bash
# From a local checkout
pi install /absolute/path/to/pi-agent-frame

# Or from npm / git once published
pi install npm:pi-agent-frame
pi install git:github.com/<owner>/pi-agent-frame
```

Try it without installing:

```bash
pi -e /absolute/path/to/pi-agent-frame
```

## Trigger

```text
/frame
```

Opens an editor asking for the goal. You can also pass it inline:

```text
/frame add a rate-limited public API for items
/frame --out docs/plan --agents .pi/agents --name items-api "add a rate-limited API"
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` | `.pi/frame/<slug>` | Where `GOAL.md`, `ROSTER.md`, and `TODO.md` go |
| `--agents <dir>` | `.pi/agents` | Where `<name>/AGENT.md` files go |
| `--name <slug>` | derived from the goal | Plan slug |

There is also a prompt-template entry point for scripted or non-TUI use:

```text
/scaffold-agents <goal description>
```

## Execute

`/frame` only frames; nothing runs yet. Once you have reviewed `TODO.md` and
`ROSTER.md`, hand the task graph to pi-subagents:

```text
/frame-run                       # newest plan under .pi/frame/
/frame-run items-api             # pick a plan by slug
/frame-run items-api --phase 2   # run one phase, then stop for review
/frame-run --from T3             # resume from a task id (plus its dependents)
/frame-run --dry-run             # print the launch plan without launching
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--phase <n>` | all phases | Run only phase N of the task graph, then stop for review |
| `--from <task>` | — | Resume from a task id and its unfinished dependents |
| `--dry-run` | off | Show the planned launch order without launching |
| `--plan <dir>` | `.pi/frame/<slug>` | Point at a plan written to a custom `--out` directory |

`/frame-run` resolves the plan, injects the execution workflow from
`skills/agent-scaffolding/references/execution.md`, and the parent session
orchestrates: preflight agent discovery, topological launch layers, host-run
`gate` commands from task Evidence fields, and `TODO.md` status updates
between layers. During an orchestrated run the parent owns `TODO.md` edits —
children report status instead of racing on the shared file.

## Generated layout

```text
.pi/
├── frame/
│   └── items-api/
│       ├── GOAL.md        # framed problem: goal, success criteria, constraints, risks
│       ├── ROSTER.md      # why each agent exists, what it owns, boundaries
│       └── TODO.md       # the shared task graph every agent works toward
└── agents/
    ├── api-implementer/AGENT.md
    ├── limiter-reviewer/AGENT.md
    └── integration-verifier/AGENT.md
```

Agents written to `.pi/agents/**/AGENT.md` are discovered by `pi-subagents`
(project scope, requires project trust). Check them with:

```text
subagent({ action: "list" })
```

A committed sample scaffold (generated, not hand-written) lives in
[`examples/items-api/`](./examples/items-api/) if you want to see the output
before framing your own goal.

## Worked example: frame → run → watch

```text
# 1. Frame the goal — writes the scaffold, executes nothing
/frame add a rate-limited public API for items

#    … review .pi/frame/items-api/{GOAL,ROSTER,TODO}.md and .pi/agents/*/AGENT.md …

# 2. Preview the launch plan, then execute for real
/frame-run items-api --dry-run
/frame-run items-api
```

Once `/frame-run` injects the execution kickoff, the parent session launches
the first dependency layer as background subagents. While they work:

```text
/subagents-fleet     # live inspector of this session's runs:
                     #   ↑/↓ select a child · Enter opens its transcript
                     #   s steers a live child (acknowledged) · D stops it
/subagent-cost       # token and cost rollup for the session
```

To intervene from the prompt instead of the inspector, take the run id from
the fleet view (or ask the session: "what's the status of the items-api
run?" — it will call `subagent({ action: "status" })`):

```text
/subagents-steer <run-id> add a 429 retry test before finishing    # guide a live child
/subagents-stop <run-id>                                           # stop one run; no id = picker
```

Watching progress without touching pi-subagents at all also works: the
orchestrator checks off tasks in `TODO.md` between layers, so
`git diff .pi/frame/items-api/TODO.md` is a reviewable audit trail of what
landed, with evidence.

Resuming after an interruption or a `--phase` stop is the same command again —
`/frame-run items-api` skips tasks already marked `done` and continues with
the first unfinished layer. If `/subagents-fleet` is unexpectedly empty after
executing, run `/subagents-doctor` to check the pi-subagents setup and project
trust.

## The `frame_scaffold` tool

The model decides the plan; the `frame_scaffold` tool writes it deterministically.
It validates the plan **before** touching disk:

- unique kebab-case agent names,
- every task owned by a defined agent,
- unique task ids and known dependencies,
- an acyclic dependency graph,
- warnings for idle agents and oversized rosters.

It refuses to overwrite existing files unless called with `overwrite: true`.
You normally do not call this tool yourself — `/frame` drives it — but it is
available to any session for re-generating or repairing a scaffold.

## How the workflow decides the roster

The bundled `agent-scaffolding` skill is the methodology:

1. **Recon** the workspace before designing anything.
2. **Frame** the goal: summary, success criteria, constraints, non-goals, risks,
   open questions.
3. **Decide the roster**: smallest set of agents, one writer per seam, read-only
   roles stay read-only, names describe the seam not the vibe.
4. **Build the task graph**: phases (`Recon → Design → Implement → Verify →
   Integrate → Harden`), one owner per task, acyclic dependencies, objective
   acceptance and named evidence.
5. **Persist** via `frame_scaffold`, then verify and hand off.

See `skills/agent-scaffolding/` for the full instructions and references.

## Troubleshooting

**I ran `/frame` and `/subagents-fleet` shows an empty board.**
By design — framing only writes files; no subagent is ever launched. Execute
the plan with `/frame-run <slug>` (see the worked example above).

**I ran `/frame-run` and nothing happened until I re-ran it.**
Two common causes. First, `/frame-run` refuses to run while the agent is
mid-turn ("Agent is busy…") — retry once the current turn finishes. Second,
the kickoff is a prompt the session must process; if the run stopped at
preflight (for example because the generated agents were not yet discovered),
the session will say so — fix the reported blocker and re-run. Re-running is
always safe: tasks already marked `done` in `TODO.md` are skipped.

**The generated agents are not discovered / execution stops at preflight.**
Agents under `.pi/agents/` are project-scoped and require project trust. Trust
the project when prompted (or restart the session), then confirm with
`subagent({ action: "list" })` before running `/frame-run` again.

**`/frame-run` is not recognized.**
The command is newer than your installed copy. Restart pi so the extension
reloads, or run the checkout directly with `pi -e /path/to/pi-agent-frame`.

**"No framed plan …" warning.**
The notification lists the plans found under `.pi/frame/`; pass one of those
slugs. A plan directory must contain a `TODO.md` to count. Plans written to a
custom `/frame --out` directory need `/frame-run --plan <dir>`.

**With several plans and no slug, the wrong one was chosen.**
Without a slug, the plan with the newest `TODO.md` wins — usually the most
recently framed or executed one. Pass the slug explicitly to be sure.

## Requirements

- Pi `>= 0.80` (uses `ctx.ui.editor`, `pi.sendUserMessage`, and custom tools).
- [pi-subagents](https://github.com/nicobailon/pi-subagents) recommended, so the
  generated agents are immediately usable for execution.
- Interactive (`tui`) mode for the editor prompt. In non-interactive/print mode,
  pass the goal inline: `/frame <goal>`.

## Package contents

```text
extensions/agent-frame.ts        # /frame + /frame-run commands and the frame_scaffold tool
lib/scaffold-core.js             # deterministic renderers, validation, writer
skills/agent-scaffolding/        # the methodology, references, and template
prompts/scaffold-agents.md       # /scaffold-agents prompt template
examples/items-api/              # committed sample scaffold (node examples/generate.mjs)
test/                            # unit + extension smoke tests
```

## Development

```bash
npm install
npm test
```

The test suite covers the scaffold generator (validation, rendering, overwrite
protection) and loads the real extension through jiti to exercise `/frame`,
`/frame-run`, and `frame_scaffold` end to end. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for the development rules and [CHANGELOG.md](./CHANGELOG.md) for notable
changes.

## Security

Pi packages run with full system access. `pi-agent-frame` only writes files
inside the plan and agent directories (relative to the project unless absolute
paths are supplied) and never executes generated content. Review the generated
`AGENT.md` files before delegating work to them.

## Author

[kasp0r](https://github.com/kasp0r)

## License

[MIT](./LICENSE) — you are free to use, modify, and distribute this package,
and contributions (issues, pull requests) are welcome.
