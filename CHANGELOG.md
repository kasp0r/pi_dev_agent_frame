# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-08

### Added

- Deterministic `lib/execution-core` planner: parses generated plans, validates
  statuses and roster owners, intersects `--phase`/`--from` scope, and computes
  parallel topological layers and conservative evidence gates before kickoff.
- Explicit agent `access: read-only | writer`, matching `acceptanceRole`
  frontmatter, stable task-id validation, and validated thinking levels.
- Strict TypeScript checking, pinned development dependencies and lockfile,
  Node 22/24 CI, and a packed-package integration test covering YAML parsing,
  real pi-subagents discovery, and extension loading through Pi RPC.
- Opt-in `npm run test:acceptance` live harness with real framing/dry-run,
  optional execution and phase-boundary resume, artifact assertions, bounded
  timeouts, child cleanup, and preserved failure diagnostics. Offline fake-RPC
  tests cover the client without provider calls.

### Changed

- Default generated agents now live under `.pi/agents/<slug>/`, isolating
  mission-specific definitions so plans can reuse names without overwriting.
- Bounded independent plan-discovery and scaffold filesystem operations,
  deduplicated directory creation, indexed task ownership for rendering, and
  deterministic newest-plan ordering.
- `/frame` and `/frame-run` now share a stricter argument parser with quoted
  values, `--flag=value`, option aliases, and `--` positional delimiter support.
- Scaffold writes are staged and rolled back on commit failure, honor abort
  signals, and stay inside the project by default. External paths require
  `--allow-outside-cwd` or `allowOutsideCwd: true`.

### Fixed

- Reject unknown flags, missing option values, unterminated quotes, and
  non-positive `--phase` values before starting work; preserve apostrophes in
  ordinary goal text.
- Escape Markdown table cells and YAML frontmatter scalars so pipes, comment
  markers, and other punctuation cannot corrupt generated scaffold structure.
- Use atomic no-replace hard links and exclusive staging when `overwrite` is
  false, closing the overwrite race between conflict preflight and writing;
  reject symbolic-link targets and directory escapes.

## [0.1.0] - 2026-09-27

### Added

- `/frame` command: frames a goal into a minimal agent roster and task graph,
  persisted via the deterministic `frame_scaffold` tool as `GOAL.md`,
  `ROSTER.md`, `TODO.md`, and one `AGENT.md` per worker.
- `frame_scaffold` tool: validates unique kebab-case agent names, single-task
  ownership, known and acyclic dependencies before writing; refuses to
  overwrite existing files unless called with `overwrite: true`.
- `/frame-run` command: hands a framed task graph back to the session for
  execution through pi-subagents, following
  `skills/agent-scaffolding/references/execution.md`. Supports `[slug]`,
  `--phase <n>`, `--from <task>`, `--dry-run`, and `--plan <dir>`.
- `agent-scaffolding` skill with references for agent authoring, the TODO.md
  task-graph format, and orchestrated execution.
- `/scaffold-agents` prompt template for scripted or non-interactive use.
- `examples/items-api/`: committed sample scaffold produced by the real
  generator (`node examples/generate.mjs`).

### Changed

- `lib/scaffold-core` converted from JavaScript (JSDoc) to TypeScript with
  exported domain types (`AgentSpec`, `TaskSpec`, `FramedPlan`). Tests and the
  example generator load it through jiti — the same loader pi uses at runtime.
  No build step and no new dependencies.
