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
 * This module deliberately has no Pi imports. It is loaded through jiti — by
 * pi when the extension runs, and by the unit tests / example generator — so
 * it shares one TypeScript loader across production and test. File-system
 * access is additive: validation always happens before anything is written.
 */

import { randomUUID } from "node:crypto";
import {
	access,
	link,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mapConcurrent, mapConcurrentSettled } from "./concurrency.ts";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type AgentAccess = "read-only" | "writer";

export interface AgentSpec {
	name: string;
	role?: string;
	description: string;
	responsibility?: string;
	access?: AgentAccess;
	tools?: string;
	thinking?: string;
	systemPrompt: string;
}

export interface TaskSpec {
	id: string;
	title: string;
	owner: string;
	phase?: string;
	dependsOn?: string[];
	acceptance: string;
	evidence?: string;
}

export interface FramingSpec {
	summary: string;
	successCriteria: string[];
	constraints?: string[];
	nonGoals?: string[];
	risks?: string[];
	openQuestions?: string[];
}

export interface FramedPlan {
	goal: string;
	title?: string;
	framing: FramingSpec;
	agents?: AgentSpec[];
	tasks?: TaskSpec[];
}

export interface ValidationResult {
	errors: string[];
	warnings: string[];
}

export interface ScaffoldFile {
	path: string;
	display: string;
	kind: string;
	content: string;
}

export interface BuildResult extends ValidationResult {
	files: ScaffoldFile[];
}

export interface WrittenFile {
	display: string;
	kind: string;
	path: string;
}

export interface WriteResult {
	ok: boolean;
	errors: string[];
	warnings: string[];
	files: WrittenFile[];
}

export interface ScaffoldOptions {
	cwd: string;
	planDir: string;
	agentsDir: string;
	slug?: string;
	title?: string;
	createdAt?: string;
	/** Permit output outside cwd. Both build and write validate this boundary. */
	allowOutsideCwd?: boolean;
}

export interface WriteOptions extends ScaffoldOptions {
	overwrite?: boolean;
	signal?: AbortSignal;
}

interface RenderMeta {
	slug: string;
	createdAt: string;
	planDirLabel: string;
	agentsDirLabel: string;
	title?: string;
}

const READ_ONLY_TOOLS = "read, grep, find, ls";
const WRITER_TOOLS = "read, grep, find, ls, bash, edit, write";

/**
 * Turn arbitrary goal text into a filesystem-safe, human-readable slug.
 */
export function slugify(input: unknown, maxLen = 48): string {
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
const TASK_ID_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

function cleanList(list: unknown): string[] {
	if (!Array.isArray(list)) return [];
	return list
		.map((item) => inline(item))
		.filter((item) => item.length > 0);
}

function inline(value: unknown): string {
	return String(value ?? "")
		.replace(/\r?\n+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Emit a safe YAML scalar. JSON double-quoted strings are valid YAML scalars,
 * so this is used whenever the value could contain YAML-significant characters.
 */
function yamlScalar(value: string): string {
	const text = inline(value);
	if (/^[A-Za-z0-9][A-Za-z0-9 .,/()_@+-]*$/.test(text) && !text.includes(": ")) {
		return text;
	}
	return JSON.stringify(text);
}

/** Render one line of arbitrary text inside a Markdown table cell. */
function tableCell(value: unknown): string {
	return inline(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function bulletList(value: unknown, fallback = "_None recorded._"): string {
	const items = cleanList(value);
	if (items.length === 0) return fallback;
	return items.map((item) => `- ${item}`).join("\n");
}

function checkboxList(value: unknown, fallback = "_None recorded._"): string {
	const items = cleanList(value);
	if (items.length === 0) return fallback;
	return items.map((item) => `- [ ] ${item}`).join("\n");
}

interface PlanIndex {
	agents: AgentSpec[];
	tasks: TaskSpec[];
	tasksByOwner: Map<string, TaskSpec[]>;
}

/** Index a plan once instead of rescanning every task for every agent. */
function indexPlan(plan: FramedPlan): PlanIndex {
	const agents = Array.isArray(plan.agents) ? plan.agents : [];
	const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
	const tasksByOwner = new Map<string, TaskSpec[]>();
	for (const task of tasks) {
		const owner = inline(task.owner);
		const owned = tasksByOwner.get(owner);
		if (owned) owned.push(task);
		else tasksByOwner.set(owner, [task]);
	}
	return { agents, tasks, tasksByOwner };
}

function effectiveAccess(agent: AgentSpec): AgentAccess {
	if (agent.access) return agent.access;
	const tools = inline(agent.tools).split(",").map((tool) => tool.trim());
	return tools.some((tool) => tool === "edit" || tool === "write") ? "writer" : "read-only";
}

/**
 * Detect the first dependency cycle in the task graph.
 * Returns the cycle path, or null when acyclic.
 */
function findCycle(tasks: Array<{ id: string; dependsOn?: string[] }>): string[] | null {
	const graph = new Map<string, string[]>();
	for (const task of tasks) graph.set(String(task.id), cleanList(task.dependsOn ?? []));

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const id of graph.keys()) color.set(id, WHITE);
	const stack: string[] = [];

	function visit(node: string): string[] | null {
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
 */
export function validatePlan(plan: FramedPlan | null | undefined): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const source = (plan ?? {}) as FramedPlan;
	const agents = Array.isArray(source.agents) ? source.agents : [];
	const tasks = Array.isArray(source.tasks) ? source.tasks : [];

	if (!inline(source.goal)) errors.push("`goal` is required.");
	if (!inline(source.framing?.summary)) errors.push("`framing.summary` is required.");
	if (cleanList(source.framing?.successCriteria).length === 0) {
		errors.push("At least one `framing.successCriteria` entry is required.");
	}
	if (agents.length === 0) errors.push("At least one agent is required.");
	if (tasks.length === 0) errors.push("At least one task is required.");

	const names = new Set<string>();
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
		if (agent?.access !== undefined && agent.access !== "read-only" && agent.access !== "writer") {
			errors.push(`Agent "${name}" access must be "read-only" or "writer".`);
		}
		if (agent?.access === "read-only" && /(?:^|,)\s*(?:edit|write)\s*(?:,|$)/.test(inline(agent.tools))) {
			errors.push(`Agent "${name}" is read-only but its tools include edit or write.`);
		}
		if (agent?.thinking && !/^(?:off|minimal|low|medium|high|xhigh|max)$/.test(inline(agent.thinking))) {
			errors.push(`Agent "${name}" has unknown thinking level "${inline(agent.thinking)}".`);
		}
	}

	const ids = new Set<string>();
	for (const task of tasks) {
		const id = inline(task?.id);
		if (!id) {
			errors.push("Every task needs an `id`.");
			continue;
		}
		if (ids.has(id)) errors.push(`Duplicate task id "${id}".`);
		ids.add(id);
		if (!inline(task?.title)) errors.push(`Task "${id}" needs a \`title\`.`);
		if (!TASK_ID_RE.test(id)) {
			errors.push(`Task "${id}" must use letters, digits, and single dot, underscore, or hyphen separators.`);
		}
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

	const taskOwners = new Set(tasks.map((task) => inline(task.owner)));
	for (const name of names) {
		if (!taskOwners.has(name)) {
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

export function renderGoalMd(plan: FramedPlan, meta: RenderMeta): string {
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

export function renderRosterMd(plan: FramedPlan, meta: RenderMeta): string {
	const { agents, tasksByOwner } = indexPlan(plan);
	const title = inline(plan.title) || inline(plan.goal) || "Untitled goal";

	const rows = agents
		.map((agent) => {
			const name = inline(agent.name);
			const owned = tasksByOwner.get(name) ?? [];
			return `| \`${tableCell(name)}\` | ${tableCell(agent.role) || "—"} | ${effectiveAccess(agent)} | ${tableCell(agent.description)} | ${
				owned.length ? owned.map((task) => `\`${tableCell(task.id)}\``).join(", ") : "—"
			} |`;
		})
		.join("\n");

	const details = agents
		.map((agent) => {
			const name = inline(agent.name);
			const owned = tasksByOwner.get(name) ?? [];
			const taskLines = owned.length
				? owned.map((task) => `- \`${inline(task.id)}\` — ${inline(task.title)}`).join("\n")
				: "- _No tasks assigned._";
			return `### \`${name}\` — ${inline(agent.role) || "worker"}

${inline(agent.description)}

**Owns:** ${inline(agent.responsibility) || "See task graph."}

**Tools:** \`${inline(agent.tools) || (effectiveAccess(agent) === "writer" ? WRITER_TOOLS : READ_ONLY_TOOLS)}\`

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

| Agent | Role | Access | Responsibility | Tasks |
| --- | --- | --- | --- | --- |
${rows || "| — | — | — | — | — |"}

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

export function renderTodoMd(plan: FramedPlan, meta: RenderMeta): string {
	const framing = plan.framing ?? {};
	const { tasks } = indexPlan(plan);
	const title = inline(plan.title) || inline(plan.goal) || "Untitled goal";

	const phases = new Map<string, TaskSpec[]>();
	for (const task of tasks) {
		const phase = inline(task.phase) || "Execution";
		if (!phases.has(phase)) phases.set(phase, []);
		phases.get(phase)?.push(task);
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
${tasks.map((task) => `| \`${tableCell(task.id)}\` | \`${tableCell(task.owner)}\` | todo | — |`).join("\n") || "| — | — | — | — |"}

## Working agreements

1. Read \`GOAL.md\` and your \`AGENT.md\` before starting.
2. Claim a task by moving it to \`in-progress\` in the progress log; one owner at a time.
3. Do not edit another agent's owned files without an explicit handoff.
4. Attach evidence (test output, file paths, commands) when checking a task off.
5. If a decision is not covered by \`GOAL.md\`, escalate instead of guessing.
`;
}

function renderAgentMdWithTasks(agent: AgentSpec, plan: FramedPlan, meta: RenderMeta, tasks: TaskSpec[]): string {
	const name = inline(agent.name);
	const access = effectiveAccess(agent);
	const tools = inline(agent.tools) || (access === "writer" ? WRITER_TOOLS : READ_ONLY_TOOLS);

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
		`acceptanceRole: ${access}`,
		`tools: ${yamlScalar(tools)}`,
	];
	if (inline(agent.thinking)) lines.push(`thinking: ${yamlScalar(inline(agent.thinking))}`);
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

export function renderAgentMd(agent: AgentSpec, plan: FramedPlan, meta: RenderMeta): string {
	const tasks = indexPlan(plan).tasksByOwner.get(inline(agent.name)) ?? [];
	return renderAgentMdWithTasks(agent, plan, meta, tasks);
}

/**
 * Check whether a path exists.
 */
async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isPathInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function nearestRealPath(path: string): Promise<string> {
	let current = path;
	while (true) {
		try {
			return await realpath(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

/** Resolve existing ancestors and reject links that redirect output outside cwd. */
async function validateRealWritePaths(
	built: BuildResult,
	options: WriteOptions,
): Promise<string[]> {
	if (options.allowOutsideCwd) return [];
	const cwd = resolve(options.cwd);
	const realCwd = await realpath(cwd);
	const roots = [...new Set(built.files.map((file) => dirname(file.path)))];
	const errors = await mapConcurrent(roots, async (root) => {
		const actual = await nearestRealPath(root);
		return isPathInside(realCwd, actual)
			? undefined
			: `Output directory "${root}" resolves outside the project through a symbolic link.`;
	});
	return errors.filter((error): error is string => error !== undefined);
}

async function rejectSymbolicLinkTargets(files: ScaffoldFile[]): Promise<string[]> {
	const errors = await mapConcurrent(files, async (file) => {
		try {
			const stats = await lstat(file.path);
			return stats.isSymbolicLink() ? `Target "${file.display}" is a symbolic link; choose a regular file path.` : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	});
	return errors.filter((error): error is string => error !== undefined);
}

/**
 * Build the full set of files for a plan without touching disk.
 */
export function buildScaffold(plan: FramedPlan, options: ScaffoldOptions): BuildResult {
	const validation = validatePlan(plan);
	const cwd = resolve(options.cwd);
	const slug = slugify(options.slug || plan.title || plan.goal);
	const planDir = resolve(cwd, options.planDir);
	const agentsDir = resolve(cwd, options.agentsDir);
	const createdAt = options.createdAt ?? new Date().toISOString().slice(0, 10);
	const planDirLabel = relative(cwd, planDir) || ".";
	const agentsDirLabel = relative(cwd, agentsDir) || ".";
	const errors = [...validation.errors];
	if (!options.allowOutsideCwd) {
		if (!isPathInside(cwd, planDir)) errors.push("`planDir` must stay inside the project cwd.");
		if (!isPathInside(cwd, agentsDir)) errors.push("`agentsDir` must stay inside the project cwd.");
		if (errors.length > validation.errors.length) {
			errors.push("Use allowOutsideCwd=true only when the operator explicitly approved external output paths.");
		}
	}
	const index = indexPlan(plan);

	const meta: RenderMeta = {
		slug,
		createdAt,
		planDirLabel,
		agentsDirLabel,
		title: options.title,
	};

	const files: ScaffoldFile[] = [];
	if (errors.length === 0) {
		files.push({
			path: join(planDir, "GOAL.md"),
			display: `${planDirLabel}/GOAL.md`,
			kind: "goal",
			content: renderGoalMd(plan, meta),
		});
		files.push({
			path: join(planDir, "ROSTER.md"),
			display: `${planDirLabel}/ROSTER.md`,
			kind: "roster",
			content: renderRosterMd(plan, meta),
		});
		files.push({
			path: join(planDir, "TODO.md"),
			display: `${planDirLabel}/TODO.md`,
			kind: "todo",
			content: renderTodoMd(plan, meta),
		});
		for (const agent of index.agents) {
			const name = inline(agent.name);
			files.push({
				path: join(agentsDir, name, "AGENT.md"),
				display: `${agentsDirLabel}/${name}/AGENT.md`,
				kind: "agent",
				content: renderAgentMdWithTasks(agent, plan, meta, index.tasksByOwner.get(name) ?? []),
			});
		}
	}

	return { errors, warnings: validation.warnings, files };
}

interface OriginalFile {
	content: Buffer;
	mode: number;
}

async function snapshotFile(file: ScaffoldFile, signal?: AbortSignal): Promise<OriginalFile | undefined> {
	try {
		const stats = await lstat(file.path);
		if (!stats.isFile()) throw new Error(`Target "${file.display}" is not a regular file.`);
		return { content: await readFile(file.path, { signal }), mode: stats.mode };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function removeTemporaryFiles(entries: Array<{ temporaryPath: string }>): Promise<void> {
	await mapConcurrentSettled(entries, (entry) => rm(entry.temporaryPath, { force: true }));
}

/**
 * Validate, stage, then commit the scaffold. Validation and conflict failures
 * write nothing; a failed commit restores every target changed by this call.
 */
export async function writeScaffold(plan: FramedPlan, options: WriteOptions): Promise<WriteResult> {
	options.signal?.throwIfAborted();
	const built = buildScaffold(plan, options);
	if (built.errors.length > 0) {
		return { ok: false, errors: built.errors, warnings: built.warnings, files: [] };
	}

	const pathErrors = [
		...(await validateRealWritePaths(built, options)),
		...(await rejectSymbolicLinkTargets(built.files)),
	];
	if (pathErrors.length > 0) {
		return { ok: false, errors: pathErrors, warnings: built.warnings, files: [] };
	}

	if (!options.overwrite) {
		const conflicts = (
			await mapConcurrent(built.files, async (file) => ((await exists(file.path)) ? file.display : undefined))
		).filter((display): display is string => display !== undefined);
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

	options.signal?.throwIfAborted();
	const directories = [...new Set(built.files.map((file) => dirname(file.path)))];
	await mapConcurrent(directories, (directory) => mkdir(directory, { recursive: true }));
	options.signal?.throwIfAborted();

	const originals = new Map<string, OriginalFile | undefined>();
	if (options.overwrite) {
		await mapConcurrent(built.files, async (file) => originals.set(file.path, await snapshotFile(file, options.signal)));
	}

	const entries = built.files.map((file) => ({
		file,
		temporaryPath: join(dirname(file.path), `.${basename(file.path)}.agent-frame-${process.pid}-${randomUUID()}.tmp`),
	}));
	const staged = await mapConcurrentSettled(entries, (entry) =>
		writeFile(entry.temporaryPath, entry.file.content, {
			encoding: "utf8",
			flag: "wx",
			mode: originals.get(entry.file.path)?.mode,
			signal: options.signal,
		}),
	);
	const stagingFailure = staged.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (stagingFailure) {
		await removeTemporaryFiles(entries);
		throw stagingFailure.reason;
	}

	const committed: typeof entries = [];
	try {
		for (const entry of entries) {
			options.signal?.throwIfAborted();
			if (options.overwrite) {
				await rename(entry.temporaryPath, entry.file.path);
			} else {
				// A same-directory hard link atomically refuses a target created after
				// preflight, unlike rename(), which would replace it on POSIX.
				await link(entry.temporaryPath, entry.file.path);
				committed.push(entry);
				await unlink(entry.temporaryPath);
			}
			if (options.overwrite) committed.push(entry);
		}
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		for (const entry of committed.reverse()) {
			const original = originals.get(entry.file.path);
			try {
				if (original) await writeFile(entry.file.path, original.content, { mode: original.mode });
				else await rm(entry.file.path, { force: true });
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		await removeTemporaryFiles(entries);
		if (rollbackErrors.length > 0) {
			throw new AggregateError([error, ...rollbackErrors], "Scaffold commit failed and rollback was incomplete.");
		}
		throw error;
	}
	await removeTemporaryFiles(entries);

	return {
		ok: true,
		errors: [],
		warnings: built.warnings,
		files: built.files.map((file) => ({ display: file.display, kind: file.kind, path: file.path })),
	};
}
