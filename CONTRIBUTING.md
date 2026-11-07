# Contributing

Contributions — bug reports, fixes, docs, new workflow references — are
welcome. This package is MIT licensed; by opening a pull request you agree to
license your contribution under the same terms.

## Setup

```bash
git clone <repo-url>
cd pi-agent-frame
npm install
npm run typecheck
npm test
```

No build step: `extensions/` and `lib/` are TypeScript loaded by pi through
jiti. The unit tests and example generator use the same loader, so tests run
against the real sources with plain `node`.

## Repository layout

```text
extensions/agent-frame.ts   # Pi-facing surface: /frame, /frame-run, frame_scaffold
lib/scaffold-core.ts        # deterministic generator: indexed renderers, validation, writer
lib/execution-core.ts       # deterministic TODO parser, scope, and launch layers
lib/concurrency.ts          # bounded filesystem concurrency
skills/agent-scaffolding/   # methodology + references injected into sessions
prompts/                    # prompt templates (e.g. /scaffold-agents)
test/                       # node --test unit + extension smoke tests
examples/                   # committed sample output (node examples/generate.mjs)
```

## Rules that will bite you if missed

- **`lib/scaffold-core.ts`, `lib/execution-core.ts`, and `lib/concurrency.ts`
  stay dependency-free.** No Pi imports, no npm dependencies — they are loaded
  through jiti in tests exactly as pi loads them at runtime. Pi-facing code lives
  in `extensions/` only.
- **Behavior changes need tests.** Renderer, validation, or writer changes go in
  `test/scaffold-core.test.mjs`; execution parsing and layering go in
  `test/execution-core.test.mjs`; command/tool changes go in
  `test/extension-smoke.test.mjs`. `test/package-integration.test.mjs` packs and
  installs the artifact, exercises real YAML/pi-subagents discovery, and loads it
  through Pi RPC without model calls.
- **Regenerate the example.** If you change a renderer, run
  `node examples/generate.mjs` and commit the refreshed `examples/items-api/`.
- **Keep flag docs in sync.** `parseArgs` / `parseRunArgs`, the command
  `getArgumentCompletions` lists, and the README flag tables must agree.
- **Kickoff text is a contract.** The prompts injected by `/frame` and
  `/frame-run` are consumed by a live model mid-session; changes should stay
  concise and are covered by smoke-test assertions.
- **Argument robustness:** Ensure any changes to `parseArgs` or `parseRunArgs`
  handle edge cases like quoted strings, extra whitespace, or unexpected flags
  without crashing.
- **Path security:** `planDir` and `agentsDir` must remain inside the resolved
  project cwd, including existing symlink ancestors. External output requires
  explicit operator approval via `allowOutsideCwd`; never weaken this silently.
- **Actionable errors:** When a tool fails (like `frame_scaffold`), return error
  messages that are prescriptive—don't just say "it failed," tell the user
  *how* to fix the input or what to check in their plan.
- **Schema alignment:** Keep `AgentSpec`, `TaskSpec`, and `FramingSpec` aligned
  with the TypeBox schema, including optional fields, access roles, thinking
  levels, and stable task-id validation.
- **Style:** tabs, JSDoc on exported helpers, and user-facing notifications
  through `ctx.ui.notify`.

## Pull requests

- One concern per PR; describe the user-visible change so it can go straight
  into `CHANGELOG.md`.
- `npm run typecheck` and `npm test` must pass; CI runs both on Node 22 and 24,
  checks generated examples, and inspects the package tarball.
- For scaffold-schema changes (new fields in the plan), update the TypeBox
  schema in `extensions/agent-frame.ts`, the validation in
  `lib/scaffold-core.ts`, and the references under `skills/agent-scaffolding/`
  together.
