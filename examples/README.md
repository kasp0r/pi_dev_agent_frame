# Examples

## `items-api/`

Sample output of:

```text
/frame add a rate-limited public API for items
```

framed against a small hypothetical Node service. `GOAL.md`, `ROSTER.md`, and
`TODO.md` are byte-for-byte what the `frame_scaffold` tool writes, and
`agents/*/AGENT.md` are the generated subagent definitions that pi-subagents
would discover under `.pi/agents/` in a real project.

Nothing here is wired into a runnable service — the example exists so you can
see the output before framing your own goal.

### Regenerating

The sample is produced by the real generator, not written by hand. After
changing the renderers in `lib/scaffold-core.js`, refresh it with:

```bash
node examples/generate.mjs
```

The script uses a fixed `createdAt` date so regeneration is idempotent; the
only diffs should come from intentional renderer changes.
