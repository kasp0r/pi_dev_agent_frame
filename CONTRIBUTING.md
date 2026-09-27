# Contributing

Contributions — bug reports, fixes, docs, new workflow references — are
welcome. This package is MIT licensed; by opening a pull request you agree to
license your contribution under the same terms.

## Setup

```bash
git clone <repo-url>
cd pi-agent-frame
npm install
npm test
```

No build step: the extension is plain TypeScript loaded by pi through jiti,
and `lib/` is plain JavaScript.

## Repository layout

```text
extensions/agent-frame.ts   # Pi-facing surface: /frame, /frame-run, frame_scaffold
lib/scaffold-core.js        # deterministic generator: validation, renderers, writer
skills/agent-scaffolding/   # methodology + references injected into sessions
prompts/                    # prompt templates (e.g. /scaffold-agents)
test/                       # node --test unit + extension smoke tests
examples/                   # committed sample output (node examples/generate.mjs)
```

## Rules that will bite you if missed

- **`lib/scaffold-core.js` stays dependency-free.** No Pi imports, no npm
  dependencies — it is unit tested with plain `node`. Pi-facing code lives in
  `extensions/` only.
- **Behavior changes need tests.** Renderer or validation changes go in
  `test/scaffold-core.test.mjs`; command/tool changes go in
  `test/extension-smoke.test.mjs`, which loads the real extension through jiti
  exactly like pi does.
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
- **Path security:** Always validate that generated paths (e.g., for `planDir` or
  `agentsDir`) remain within the intended project boundaries to prevent
  directory traversal.
- **Actionable errors:** When a tool fails (like `frame_scaffold`), return error
  messages that are prescriptive—don't just say "it failed," tell the user
  *how* to fix the input or what to check in their plan.
- **Style:** tabs, JSDoc on exported helpers, and user-facing notifications
  through `ctx.ui.notify`.

## Pull requests

- One concern per PR; describe the user-visible change so it can go straight
  into `CHANGELOG.md`.
- `npm test` must pass.
- For scaffold-schema changes (new fields in the plan), update the TypeBox
  schema in `extensions/agent-frame.ts`, the validation in
  `lib/scaffold-core.js`, and the references under `skills/agent-scaffolding/`
  together.
