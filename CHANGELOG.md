# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
