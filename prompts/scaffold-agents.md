---
description: Frame a goal into agent workers, AGENT.md files, and a shared TODO.md
argument-hint: "[goal description]"
---
Use the `agent-scaffolding` skill to frame a goal into an executable multi-agent
scaffold: a minimal roster of worker agents, one `AGENT.md` per worker, and a
shared `TODO.md` task graph.

Load the `agent-scaffolding` skill and follow it end to end. Decide the plan,
then persist it with the `frame_scaffold` tool — do not hand-write the generated
files.

Goal:
${@:-Ask the user for a description of the goal, then proceed.}
