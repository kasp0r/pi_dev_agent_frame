/**
 * pi-agent-frame — deterministic scaffold generator.
 *
 * Pure, dependency-free helpers that turn a framed goal + agent roster + task
 * graph into the on-disk scaffold:
 *
 *   <planDir>/GOAL.md      — the framed problem statement
 *   <planDir>/ROSTER.md    — why these agents exist, what each owns, boundaries
 *   <planDir>/TODO.md      — the shared plan every agent works toward
 *   <agentsDir>/<name>/AGENT.md — one subagent definition per worker
 *
 * This module deliberately has no Pi imports so it can be unit tested with
 * plain `node`. File-system access is additive: validation always happens
 * before anything is written.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/** @typedef {"read" | "write"} Scope */

const READ_ONLY_TOOLS = "read, grep, find, ls";
const WRITER_TOOLS = "read, grep, find, ls, bash, edit, write";

/**
 * Turn arbitrary goal text into a filesystem-safe, human-readable slug.
 * @param {unknown} input
 * @param {number} [maxLen]
 * @returns {string}
 */
export function slugify(input, maxLen = 48) {
	const base = String(input ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	const words = base.split("-").filter(Boolean).slice(0, 8).join("-");
	const slug = words.slice(0, maxLen).replace(/-+$/g, "");
	return slug || "goal";
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function cleanList(list) {
	if (!Array.isArray(list)) return [];
	return list
		.map((item) => String(item ?? "").trim())
		.filter((item) => item.length > 0);
}

/**
 * @param {string} value
 * @returns {string}
 */
function inline(value) {
	return String(value ?? "")
		.replace(/\r?\n+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Emit a safe YAML scalar. JSON double-quoted strings are valid YAML scalars,
 * so this is used whenever the value could contain YAML-significant characters.
 * @param {string} value
 * @returns {string}
 */
function yamlScalar(value) {
	const text = inline(value);
	if (/^[A-Za-z0-9][A-Za-z0-9 .,/()_@+-]*$/.test(text) && !text.includes(": ")) {
		return text;
	}
	return JSON.stringify(text);
}

/**
 * @param {string} value
 * @returns {string}
 */
function bulletList(value, fallback = "_None recorded._") {
	const items = cleanList(Array.isArray(value) ? value : []);
	if (items.length === 0) return fallback;
	return items.map((item) => `- ${item}`).join("\n");
}

/**
 * @param {string} value
 * @returns {string}
 */
function checkboxList(value, fallback = "_None recorded._") {
	const items = cleanList(Array.isArray(value) ? value : []);
	if (items.length === 0) return fallback;
	return items.map((item) => `- [ ] ${item}`).join("\n");
}

/**
 * @param {string} value
 * @returns {string}
 */
function indent(text, spaces) {
	const pad = " ".repeat(spaces);
	return String(text ?? "")
		.split("\n")
		.map((line) => (line.length ? pad + line : line))
		.join("\n");
}

/**
 * Detect the first dependency cycle in the task graph.
 * @param {Array<{id: string, dependsOn?: string[]}>} tasks
 * @returns {string[] | null} the cycle path, or null when acyclic
 */
function findCycle(tasks) {
	/** @type {Map<string, string[]>} */
	const graph = new Map();
	for (const task of tasks) graph.set(String(task.id), cleanList(task.dependsOn ?? []));

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	/** @type {Map<string, number>} */
	const color = new Map();
	for (const id of graph.keys()) color.set(id, WHITE);
	/** @type {string[]} */
	const stack = [];

	/**
	 * @param {string} node
	 * @returns {string[] | null}
	 */
	function visit(node) {
		color.set(node, GRAY);
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			if (!graph.has(next)) continue;
			const state = color.get(next);
			if (state === GRAY) {
				const start = stack.indexOf(next);
				return [...stack.slice(start), next];
			}
			if (state === WHITE) {
				const found = visit(next);
				if (found) return found;
			}
		}
		stack.pop();
		color.set(node, BLACK);
		return null;
	}

	for (const id of graph.keys()) {
		if (color.get(id) === WHITE) {
			const found = visit(id);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Validate a framed plan before any file is written.
 * @param {any} plan
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validatePlan(plan) {
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];
	const source = plan ?? {};
	const agents = Array.isArray(source.agents) ? source.agents : [];
	const tasks = Array.isArray(source.tasks) ? source.tasks : [];

	if (!inline(source.goal)) errors.push("`goal` is required.");
	if (agents.length === 0) errors.push("At least one agent is required.");
	if (tasks.length === 0) errors.push("At least one task is required.");

	/** @type {Set<string>} */
	const names = new Set();
	for (const agent of agents) {
		const name = inline(agent?.name);
		if (!name) {
			errors.push("Every agent needs a `name`.");
			continue;
		}
		if (!KEBAB_RE.test(name)) {
			errors.push(`Agent "${name}" must be lower-case kebab-case (a-z, 0-9, single hyphens).`);
		}
		if (names.has(name)) errors.push(`Duplicate agent name "${name}".`);
		names.add(name);
		if (!inline(agent?.description)) errors.push(`Agent "${name}" needs a one-line \`description\`.`);
		if (!inline(agent?.systemPrompt)) errors.push(`Agent "${name}" needs a \`systemPrompt\`.`);
	}

	/** @type {Set<string>} */
	const ids = new Set();
	for (const task of tasks) {
		const id = inline(task?.id);
		if (!id) {
			errors.push("Every task needs an `id`.");
			continue;
		}
		if (ids.has(id)) errors.push(`Duplicate task id "${id}".`);
		ids.add(id);
		if (!inline(task?.title)) errors.push(`Task "${id}" needs a \`title\`.`);
		const owner = inline(task?.owner);
		if (!owner) errors.push(`Task "${id}" needs an \`owner\`.`);
		else if (!names.has(owner)) errors.push(`Task "${id}" owner "${owner}" is not a defined agent.`);
		if (!inline(task?.acceptance)) errors.push(`Task "${id}" needs \`acceptance\` criteria.`);
	}

	for (const task of tasks) {
		const id = inline(task?.id);
		for (const dep of cleanList(task?.dependsOn ?? [])) {
			if (!ids.has(dep)) errors.push(`Task "${id}" depends on unknown task "${dep}".`);
			if (dep === id) errors.push(`Task "${id}" depends on itself.`);
		}
	}

	const cycle = findCycle(tasks.map((task) => ({ id: inline(task?.id), dependsOn: task?.dependsOn })));
	if (cycle) errors.push(`Dependency cycle detected: ${cycle.join(" -> ")}.`);

	for (const name of names) {
		if (!tasks.some((task) => inline(task?.owner) === name)) {
			warnings.push(`Agent "${name}" owns no tasks.`);
		}
	}
	if (agents.length > 6) {
		warnings.push(`Roster has ${agents.length} agents; confirm each one has a distinct seam and owner boundary.`);
	}
	if (tasks.length > 25) {
		warnings.push(`Task graph has ${tasks.length} tasks; consider collapsing or pushing detail into AGENT.md.`);
	}

	return { errors, warnings };
}

/**
 * @param {any} plan
 * @param {{ slug: string, createdAt: string }} meta
 * @returns {string}
 */
export function renderGoalMd(plan, meta) {
	const framing = plan.framing ?? {};
	const title = inline(plan.title) || inline(plan.goal) || "Untitled goal";
	return `# Goal — ${title}

> Framed by \`pi-agent-frame\` on ${meta.createdAt} · slug: \`${meta.slug}\`

## Goal (verbatim)

> ${String(plan.goal ?? "").trim().replace(/\n+/g, "\n> ")}

## Problem framing

${String(framing.summary ?? "").trim() || "_No summary provided._"}

## Success criteria

${checkboxList(framing.successCriteria)}

## Constraints

${bulletList(framing.constraints)}

## Non-goals

${bulletList(framing.nonGoals)}

## Risks

${bulletList(framing.risks)}

## Open questions

${bulletList(framing.openQuestions)}

## Related artifacts

- [\`TODO.md\`](./TODO.md) — the shared work graph
- [\`ROSTER.md\`](./ROSTER.md) — agent roster, ownership, and boundaries
- Generated agents live under \`${meta.agentsDirLabel}\`
`;
}

/**
 * @param {any} plan
 * @param {{ slug: string, createdAt: string, agentsDirLabel: string }} meta
 * @returns {string}
 */
export function renderRosterMd(plan, meta) {
	const agents = Array.isArray(plan.agents) ? plan.agents : [];
	const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
	const title = inline(plan.title) || inline(plan.goal) || "Untitled goal";

	const rows = agents
		.map((agent) => {
			const name = inline(agent.name);
			const owned = tasks.filter((task) => inline(task.owner) === name).map((task) => inline(task.id));
			return `| \`${name}\` | ${inline(agent.role) || "—"} | ${inline(agent.description)} | ${
				owned.length ? owned.map((id) => `\`${id}\``).join(", ") : "—"
			} |`;
		})
		.join("\n");

	const details = agents
		.map((agent) => {
			const name = inline(agent.name);
			const owned = tasks.filter((task) => inline(task.owner) === name);
			const taskLines = owned.length
				? owned.map((task) => `- \`${inline(task.id)}\` — ${inline(task.title)}`).join("\n")
				: "- _No tasks assigned._";
			return `### \`${name}\` — ${inline(agent.role) || "worker"}

${inline(agent.description)}

**Owns:** ${inline(agent.responsibility) || "See task graph."}

**Tools:** \`${inline(agent.tools) || READ_ONLY_TOOLS}\`

**Tasks**

${taskLines}`;
		})
		.join("\n\n");

	return `# Agent roster — ${title}

> Generated by \`pi-agent-frame\` on ${meta.createdAt} · slug: \`${meta.slug}\`

The roster is intentionally minimal: every agent must own a distinct seam, and
every task must have exactly one accountable owner. Shared files are coordinated
through the task graph in [\`TODO.md\`](./TODO.md), never edited concurrently.

## At a glance

| Agent | Role | Responsibility | Tasks |
| --- | --- | --- | --- |
${rows || "| — | — | — | — |"}

## Agent briefs

${details || "_No agents defined._"}

## Coordination rules

- One writer per file or component seam at a time; serialize through the task graph.
- Read-only agents produce evidence and recommendations, not edits.
- Handoffs are explicit: a task is only complete when its acceptance criteria and evidence are recorded in \`TODO.md\`.
- Unresolved decisions escalate to the parent session instead of being guessed.
- Generated agent definitions are project-scoped and require project trust to load.
`;
}

/**
 * @param {any} plan
 * @param {{ slug: string, createdAt: string, agentsDirLabel: string }} meta
 * @returns {string}
 */
export function renderTodoMd(plan, meta) {
	const framing = plan.framing ?? {};
	const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
	const title = inline(plan.title) || inline(plan.goal) || "Untitled goal";

	/** @type {Map<string, any[]>} */
	const phases = new Map();
	for (const task of tasks) {
		const phase = inline(task.phase) || "Execution";
		if (!phases.has(phase)) phases.set(phase, []);
		phases.get(phase).push(task);
	}

	let phaseIndex = 0;
	const sections = [...phases.entries()]
		.map(([phase, phaseTasks]) => {
			phaseIndex += 1;
			const items = phaseTasks
				.map((task) => {
					const deps = cleanList(task.dependsOn ?? []);
					const meta2 = [
						`owner: \`${inline(task.owner)}\``,
						deps.length ? `depends: ${deps.map((d) => `\`${d}\``).join(", ")}` : "depends: none",
					].join(" · ");
					const evidence = inline(task.evidence) ? `\n    - Evidence: ${inline(task.evidence)}` : "";
					return `- [ ] **${inline(task.id)}** — ${inline(task.title)}\n    - ${meta2}\n    - Acceptance: ${inline(task.acceptance)}${evidence}`;
				})
				.join("\n");
			return `### Phase ${phaseIndex} — ${phase}

${items}`;
		})
		.join("\n\n");

	return `# TODO — ${title}

> Shared execution plan generated by \`pi-agent-frame\` on ${meta.createdAt} · slug: \`${meta.slug}\`

Every agent works toward this file. A task is done only when its acceptance
criteria are met and evidence is recorded. Keep the checkboxes current.

**Goal:** ${inline(plan.goal)}

## Definition of done (mission)

${checkboxList(framing.successCriteria)}

## Task graph

${sections || "_No tasks defined._"}

## Progress log

| Task | Owner | Status | Evidence / link |
| --- | --- | --- | --- |
${tasks.map((task) => `| \`${inline(task.id)}\` | \`${inline(task.owner)}\` | todo | — |`).join("\n") || "| — | — | — | — |"}

## Working agreements

1. Read \`GOAL.md\` and your \`AGENT.md\` before starting.
2. Claim a task by moving it to \`in-progress\` in the progress log; one owner at a time.
3. Do not edit another agent's owned files without an explicit handoff.
4. Attach evidence (test output, file paths, commands) when checking a task off.
5. If a decision is not covered by \`GOAL.md\`, escalate instead of guessing.
`;
}

/**
 * @param {any} agent
 * @param {any} plan
 * @param {{ slug: string, agentsDirLabel: string }} meta
 * @returns {string}
 */
export function renderAgentMd(agent, plan, meta) {
	const name = inline(agent.name);
	const tasks = (Array.isArray(plan.tasks) ? plan.tasks : []).filter((task) => inline(task.owner) === name);
	const tools = inline(agent.tools) || (tasks.some((task) => /write|edit|implement|fix|build/i.test(String(task.title)))
		? WRITER_TOOLS
		: READ_ONLY_TOOLS);

	const assignment = tasks.length
		? tasks
				.map((task) => {
					const deps = cleanList(task.dependsOn ?? []);
					const depText = deps.length ? ` _(after ${deps.map((d) => `\`${d}\``).join(", ")})_` : "";
					const evidence = inline(task.evidence) ? `\n  - Evidence: ${inline(task.evidence)}` : "";
					return `- \`${inline(task.id)}\` — ${inline(task.title)}${depText}\n  - Acceptance: ${inline(task.acceptance)}${evidence}`;
				})
				.join("\n")
		: "- _No tasks assigned yet._";

	const lines = [
		"---",
		`name: ${yamlScalar(name)}`,
		`description: ${yamlScalar(inline(agent.description))}`,
		`systemPromptMode: replace`,
		`inheritProjectContext: true`,
		`inheritSkills: false`,
		`tools: ${tools}`,
	];
	if (inline(agent.thinking)) lines.push(`thinking: ${inline(agent.thinking)}`);
	lines.push("---", "");

	const body = String(agent.systemPrompt ?? "").trim();
	const header = `# Mission assignment

You are \`${name}\`${inline(agent.role) ? `, the ${inline(agent.role)}` : ""}.

- Mission: ${inline(plan.goal)}
- Plan directory: \`${meta.planDirLabel}\`
- Shared task graph: \`${meta.planDirLabel}/TODO.md\`
- Roster and boundaries: \`${meta.planDirLabel}/ROSTER.md\`

## Your tasks

${assignment}

## Operating rules

- Work only within your ownership boundary. Escalate cross-boundary changes instead of editing them.
- Update the task status and evidence in \`TODO.md\` as you complete work.
- Do not start a task whose dependencies are not complete unless the parent approves it.
- Report a concise summary: what changed, evidence, blockers, and the next task you recommend.
`;

	return `${lines.join("\n")}${body}\n\n${header}`;
}

/**
 * Resolve a possibly-relative path against a base directory.
 * @param {string} base
 * @param {string} target
 * @returns {string}
 */
function resolveFrom(base, target) {
	return resolve(base, target);
}

/**
 * Check whether a path exists.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the full set of files for a plan without touching disk.
 * @param {any} plan
 * @param {{ cwd: string, planDir: string, agentsDir: string, slug: string, title?: string, createdAt?: string }} options
 * @returns {{ errors: string[], warnings: string[], files: Array<{ path: string, display: string, kind: string, content: string }> }}
 */
export function buildScaffold(plan, options) {
	const validation = validatePlan(plan);
	const cwd = options.cwd;
	const slug = slugify(options.slug || plan.title || plan.goal);
	const planDir = resolveFrom(cwd, options.planDir);
	const agentsDir = resolveFrom(cwd, options.agentsDir);
	const createdAt = options.createdAt ?? new Date().toISOString().slice(0, 10);
	const planDirLabel = relative(cwd, planDir) || ".";
	const agentsDirLabel = relative(cwd, agentsDir) || ".";

	const meta = {
		slug,
		createdAt,
		planDirLabel,
		agentsDirLabel,
	};
	const planMeta = { ...meta, title: options.title };

	/** @type {Array<{ path: string, display: string, kind: string, content: string }>} */
	const files = [];
	if (validation.errors.length === 0) {
		files.push({
			path: join(planDir, "GOAL.md"),
			display: `${planDirLabel}/GOAL.md`,
			kind: "goal",
			content: renderGoalMd(plan, planMeta),
		});
		files.push({
			path: join(planDir, "ROSTER.md"),
			display: `${planDirLabel}/ROSTER.md`,
			kind: "roster",
			content: renderRosterMd(plan, planMeta),
		});
		files.push({
			path: join(planDir, "TODO.md"),
			display: `${planDirLabel}/TODO.md`,
			kind: "todo",
			content: renderTodoMd(plan, planMeta),
		});
		for (const agent of plan.agents ?? []) {
			const name = inline(agent.name);
			files.push({
				path: join(agentsDir, name, "AGENT.md"),
				display: `${agentsDirLabel}/${name}/AGENT.md`,
				kind: "agent",
				content: renderAgentMd(agent, plan, planMeta),
			});
		}
	}

	return { errors: validation.errors, warnings: validation.warnings, files };
}

/**
 * Validate, then write the scaffold. Nothing is written when validation fails
 * or when a target exists and `overwrite` is false.
 *
 * @param {any} plan
 * @param {{ cwd: string, planDir: string, agentsDir: string, slug?: string, title?: string, overwrite?: boolean, createdAt?: string }} options
 * @returns {Promise<{ ok: boolean, errors: string[], warnings: string[], files: Array<{ display: string, kind: string, path: string }> }>}
 */
export async function writeScaffold(plan, options) {
	const built = buildScaffold(plan, options);
	if (built.errors.length > 0) {
		return { ok: false, errors: built.errors, warnings: built.warnings, files: [] };
	}

	if (!options.overwrite) {
		/** @type {string[]} */
		const conflicts = [];
		for (const file of built.files) {
			if (await exists(file.path)) conflicts.push(file.display);
		}
		if (conflicts.length > 0) {
			return {
				ok: false,
				errors: [
					`Refusing to overwrite existing files: ${conflicts.join(", ")}. Pass overwrite=true to replace them.`,
				],
				warnings: built.warnings,
				files: [],
			};
		}
	}

	for (const file of built.files) {
		await mkdir(dirname(file.path), { recursive: true });
		await writeFile(file.path, file.content, "utf8");
	}

	return {
		ok: true,
		errors: [],
		warnings: built.warnings,
		files: built.files.map((file) => ({ display: file.display, kind: file.kind, path: file.path })),
	};
}
