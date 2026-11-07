/**
 * Deterministic parser and launch planner for generated TODO.md files.
 *
 * This module deliberately has no Pi imports. It parses the stable scaffold
 * format, applies --phase/--from scope, and returns topological launch layers.
 */

export type TaskStatus = "todo" | "in-progress" | "blocked" | "review" | "done";

export interface ExecutionTask {
	id: string;
	title: string;
	owner: string;
	phase: string;
	phaseNumber: number;
	dependsOn: string[];
	acceptance: string;
	evidence?: string;
	status: TaskStatus;
	checkboxDone: boolean;
	gate?: string;
}

export interface ExecutionPlanInput {
	todo: string;
	roster?: string;
	phase?: string | number;
	from?: string;
}

export interface ExecutionPlan {
	errors: string[];
	warnings: string[];
	allTasks: ExecutionTask[];
	tasks: ExecutionTask[];
	layers: ExecutionTask[][];
	phases: Array<{ number: number; label: string }>;
}

const STATUSES = new Set<TaskStatus>(["todo", "in-progress", "blocked", "review", "done"]);

function inline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function tableCell(value: string): string {
	return inline(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Extract a single conservative host gate from structured evidence text. */
export function extractGate(evidence: string | undefined): string | undefined {
	if (!evidence) return undefined;
	const backticks = [...evidence.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1].trim());
	const dashed = evidence.match(/^(.+?)\s+[—–]\s+.+$/);
	const candidate = backticks.length === 1 ? backticks[0] : dashed?.[1]?.trim();
	if (!candidate || /[\r\n;&|<>]/.test(candidate)) return undefined;
	if (
		!/^(?:(?:npm|pnpm|yarn|bun|deno|node|python|python3|pytest|cargo|go|make|npx|git)\b|\.?\/\S+)/.test(
			candidate,
		)
	) {
		return undefined;
	}
	return candidate;
}

/** Parse the canonical agent brief headings in ROSTER.md. */
export function parseRosterAgents(roster: string): string[] {
	const names = new Set<string>();
	for (const line of roster.split(/\r?\n/)) {
		const match = line.match(/^### `([a-z0-9]+(?:-[a-z0-9]+)*)`(?:\s|$)/);
		if (match) names.add(match[1]);
	}
	return [...names];
}

function parseTodo(todo: string): { tasks: ExecutionTask[]; errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	const tasks: ExecutionTask[] = [];
	const phases = new Map<number, string>();
	const lines = todo.split(/\r?\n/);
	let inTaskGraph = false;
	let current: ExecutionTask | undefined;
	let currentPhase: { number: number; label: string } | undefined;

	const finishCurrent = () => {
		if (!current) return;
		if (!current.owner) errors.push(`Task "${current.id}" has no parseable owner line.`);
		if (!current.acceptance) errors.push(`Task "${current.id}" has no parseable acceptance criteria.`);
		if (current.phaseNumber === 0) errors.push(`Task "${current.id}" does not belong to a numbered phase.`);
		current.gate = extractGate(current.evidence);
		tasks.push(current);
		current = undefined;
	};

	for (const line of lines) {
		if (line === "## Task graph") {
			inTaskGraph = true;
			continue;
		}
		if (inTaskGraph && /^## /.test(line)) {
			finishCurrent();
			inTaskGraph = false;
		}
		if (!inTaskGraph) continue;

		const phase = line.match(/^### Phase ([1-9]\d*) — (.+)$/);
		if (phase) {
			finishCurrent();
			const number = Number(phase[1]);
			const label = inline(phase[2]);
			if (phases.has(number) && phases.get(number) !== label) {
				errors.push(`Phase ${number} has conflicting labels.`);
			}
			phases.set(number, label);
			currentPhase = { number, label };
			continue;
		}

		const item = line.match(/^- \[([ xX])\] \*\*([^*]+)\*\* — (.+)$/);
		if (item) {
			finishCurrent();
			const latestPhase = [...phases.entries()].at(-1);
			current = {
				id: inline(item[2]),
				title: inline(item[3]),
				owner: "",
				phase: latestPhase?.[1] ?? "Execution",
				phaseNumber: latestPhase?.[0] ?? 0,
				dependsOn: [],
				acceptance: "",
				status: item[1].toLowerCase() === "x" ? "done" : "todo",
				checkboxDone: item[1].toLowerCase() === "x",
			};
			continue;
		}
		if (!current) continue;

		const metadata = line.match(/^\s+- owner: `([^`]+)` · depends: (.+)$/);
		if (metadata) {
			current.owner = metadata[1];
			const dependencyText = metadata[2].trim();
			current.dependsOn = dependencyText === "none" ? [] : [...dependencyText.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
			const canonical = current.dependsOn.length > 0 ? current.dependsOn.map((id) => `\`${id}\``).join(", ") : "none";
			if (dependencyText !== canonical) errors.push(`Task "${current.id}" has a malformed dependency list.`);
			continue;
		}
		const acceptance = line.match(/^\s+- Acceptance: (.+)$/);
		if (acceptance) current.acceptance = inline(acceptance[1]);
		const evidence = line.match(/^\s+- Evidence: (.+)$/);
		if (evidence) current.evidence = inline(evidence[1]);
	}
	finishCurrent();

	if (tasks.length === 0) errors.push("No parseable tasks found under ## Task graph.");
	const byId = new Map<string, ExecutionTask>();
	for (const task of tasks) {
		if (byId.has(task.id)) errors.push(`Duplicate task id "${task.id}" in TODO.md.`);
		byId.set(task.id, task);
	}

	const progress = new Map<string, { owner: string; status: TaskStatus }>();
	for (const line of lines) {
		const row = line.match(/^\| `([^`]+)` \| `([^`]+)` \| ([^|]+) \|/);
		if (!row || !byId.has(row[1])) continue;
		const status = row[3].trim() as TaskStatus;
		if (!STATUSES.has(status)) {
			errors.push(`Task "${row[1]}" has unknown progress status "${status}".`);
			continue;
		}
		if (progress.has(row[1])) errors.push(`Task "${row[1]}" has multiple progress-log rows.`);
		progress.set(row[1], { owner: row[2], status });
	}

	for (const task of tasks) {
		const state = progress.get(task.id);
		if (!state) {
			warnings.push(`Task "${task.id}" has no progress-log row; using its checkbox status.`);
			continue;
		}
		if (state.owner !== task.owner) {
			errors.push(`Task "${task.id}" owner differs between the task graph and progress log.`);
		}
		if (task.checkboxDone !== (state.status === "done")) {
			errors.push(`Task "${task.id}" checkbox and progress-log completion state disagree.`);
		}
		task.status = state.status;
	}

	return { tasks, errors, warnings };
}

/** Build an authoritative initial execution plan from a generated scaffold. */
export function buildExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
	const parsed = parseTodo(input.todo);
	const errors = [...parsed.errors];
	const warnings = [...parsed.warnings];
	const phases = [...new Map(parsed.tasks.map((task) => [task.phaseNumber, task.phase])).entries()]
		.map(([number, label]) => ({ number, label }))
		.sort((a, b) => a.number - b.number);
	const byId = new Map(parsed.tasks.map((task) => [task.id, task]));

	if (input.roster !== undefined) {
		const rosterAgents = new Set(parseRosterAgents(input.roster));
		for (const task of parsed.tasks) {
			if (!rosterAgents.has(task.owner)) errors.push(`Task "${task.id}" owner "${task.owner}" is missing from ROSTER.md.`);
		}
	}
	for (const task of parsed.tasks) {
		for (const dependency of task.dependsOn) {
			if (!byId.has(dependency)) errors.push(`Task "${task.id}" depends on unknown task "${dependency}".`);
		}
	}

	let phase: number | undefined;
	if (input.phase !== undefined) {
		phase = Number(input.phase);
		if (!Number.isInteger(phase) || phase < 1) {
			errors.push(`Phase must be a positive integer; received "${input.phase}".`);
			phase = undefined;
		} else if (!phases.some((candidate) => candidate.number === phase)) {
			const available = phases.map((candidate) => `${candidate.number} (${candidate.label})`).join(", ") || "none";
			errors.push(`Unknown phase ${phase}. Available phases: ${available}.`);
		}
	}

	let selected = new Set(parsed.tasks.map((task) => task.id));
	if (input.from) {
		const origin = byId.get(input.from);
		if (!origin) {
			errors.push(`Unknown from-task "${input.from}". Known task ids: ${parsed.tasks.map((task) => task.id).join(", ") || "none"}.`);
		} else {
			const downstream = new Map<string, string[]>();
			for (const task of parsed.tasks) {
				for (const dependency of task.dependsOn) {
					const children = downstream.get(dependency);
					if (children) children.push(task.id);
					else downstream.set(dependency, [task.id]);
				}
			}
			selected = new Set([origin.id]);
			const pending = [origin.id];
			while (pending.length > 0) {
				for (const dependent of downstream.get(pending.pop() ?? "") ?? []) {
					if (!selected.has(dependent)) {
						selected.add(dependent);
						pending.push(dependent);
					}
				}
			}

			const ancestors = new Set<string>();
			const ancestorsPending = [origin.id];
			while (ancestorsPending.length > 0) {
				for (const dependency of byId.get(ancestorsPending.pop() ?? "")?.dependsOn ?? []) {
					if (ancestors.has(dependency)) continue;
					ancestors.add(dependency);
					ancestorsPending.push(dependency);
				}
			}
			const unfinished = [...ancestors].filter((id) => byId.get(id)?.status !== "done");
			if (unfinished.length > 0) {
				errors.push(`Task "${origin.id}" has unfinished dependencies outside --from scope: ${unfinished.join(", ")}.`);
			}
		}
	}

	if (phase !== undefined) {
		selected = new Set([...selected].filter((id) => byId.get(id)?.phaseNumber === phase));
	}
	const tasks = parsed.tasks.filter((task) => selected.has(task.id) && task.status !== "done");
	const selectedUnfinished = new Set(tasks.map((task) => task.id));
	for (const task of tasks) {
		for (const dependency of task.dependsOn) {
			const dependencyTask = byId.get(dependency);
			if (dependencyTask && dependencyTask.status !== "done" && !selectedUnfinished.has(dependency)) {
				errors.push(
					`Task "${task.id}" depends on unfinished task "${dependency}" outside the selected scope; widen the scope or complete it first.`,
				);
			}
		}
	}

	const layers: ExecutionTask[][] = [];
	if (errors.length === 0) {
		const order = new Map(tasks.map((task, index) => [task.id, index]));
		const dependents = new Map<string, ExecutionTask[]>();
		const indegree = new Map<string, number>();
		for (const task of tasks) {
			const pending = task.dependsOn.filter((dependency) => selectedUnfinished.has(dependency));
			indegree.set(task.id, pending.length);
			for (const dependency of pending) {
				const children = dependents.get(dependency);
				if (children) children.push(task);
				else dependents.set(dependency, [task]);
			}
		}
		let frontier = tasks.filter((task) => indegree.get(task.id) === 0);
		let placedCount = 0;
		while (frontier.length > 0) {
			layers.push(frontier);
			placedCount += frontier.length;
			const next: ExecutionTask[] = [];
			for (const task of frontier) {
				for (const dependent of dependents.get(task.id) ?? []) {
					const remaining = (indegree.get(dependent.id) ?? 0) - 1;
					indegree.set(dependent.id, remaining);
					if (remaining === 0) next.push(dependent);
				}
			}
			frontier = next.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
		}
		if (placedCount !== tasks.length) {
			const unplaced = tasks.filter((task) => (indegree.get(task.id) ?? 0) > 0).map((task) => task.id);
			errors.push(`Dependency cycle or unplaceable tasks detected: ${unplaced.join(", ")}.`);
		}
	}

	return { errors, warnings, allTasks: parsed.tasks, tasks, layers, phases };
}

/** Render a dry-run table and explicit parallel-layer summary. */
export function formatExecutionPlan(plan: ExecutionPlan): string {
	if (plan.errors.length > 0) return plan.errors.map((error) => `- ${error}`).join("\n");
	if (plan.tasks.length === 0) return "All tasks in the selected scope are already done.";
	const layerByTask = new Map<string, number>();
	plan.layers.forEach((layer, index) => layer.forEach((task) => layerByTask.set(task.id, index + 1)));
	const rows = plan.tasks.map(
		(task) =>
			`| ${layerByTask.get(task.id) ?? "—"} | \`${tableCell(task.id)}\` | ${tableCell(task.title)} | \`${tableCell(task.owner)}\` | ${task.gate ? `\`${tableCell(task.gate)}\`` : "—"} |`,
	);
	const layers = plan.layers.map(
		(layer, index) => `- Layer ${index + 1}: ${layer.map((task) => `\`${task.id}\``).join(", ")}${layer.length > 1 ? " (parallel)" : ""}`,
	);
	return [
		"| Layer | Task | Title | Owner | Gate |",
		"| --- | --- | --- | --- | --- |",
		...rows,
		"",
		...layers,
	].join("\n");
}
