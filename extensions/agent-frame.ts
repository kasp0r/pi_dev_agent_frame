/**
 * pi-agent-frame
 *
 * Two entry points:
 *
 *  - `/frame [--out <dir>] [--agents <dir>] [--name <slug>] [goal...]`
 *    Asks for the goal (interactive editor when omitted), then hands the
 *    agent-scaffolding workflow to the current session.
 *
 *  - `/frame-run [slug] [--phase <n>] [--from <task>] [--dry-run] [--plan <dir>]`
 *    Hands an existing framed task graph back to the session for execution
 *    through pi-subagents, following references/execution.md.
 *
 *  - `frame_scaffold` tool
 *    Deterministically writes GOAL.md, ROSTER.md, TODO.md and one AGENT.md per
 *    worker agent once the roster and task graph have been decided.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { slugify, writeScaffold } from "../lib/scaffold-core.ts";

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const AgentSpec = Type.Object({
	name: Type.String({ description: "Unique lower-case kebab-case agent name, e.g. api-implementer" }),
	role: Type.String({ description: "Short role label, e.g. 'API implementer' or 'Independent reviewer'" }),
	description: Type.String({
		description: "One-line capability description shown during agent discovery",
	}),
	responsibility: Type.Optional(Type.String({ description: "What this agent owns end-to-end, in one or two sentences" })),
	tools: Type.Optional(
		Type.String({
			description:
				"Comma-separated child tool allowlist, e.g. 'read, grep, find, ls, bash, edit, write'. Defaults to a read-only set, or a writer set when the agent owns implementation tasks.",
		}),
	),
	thinking: Type.Optional(Type.String({ description: "Optional thinking level: minimal, low, medium, high, xhigh" })),
	systemPrompt: Type.String({ description: "Full system prompt for the agent, in markdown" }),
});

const TaskSpec = Type.Object({
	id: Type.String({ description: "Stable task id, e.g. T1 or T1.2" }),
	title: Type.String({ description: "Imperative task title" }),
	owner: Type.String({ description: "Name of the accountable agent" }),
	phase: Type.Optional(Type.String({ description: "Phase label; defaults to 'Execution'" })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must complete first" })),
	acceptance: Type.String({ description: "Objective acceptance criteria / definition of done" }),
	evidence: Type.Optional(Type.String({ description: "What evidence proves completion" })),
});

const FrameParams = Type.Object({
	goal: Type.String({ description: "The user's goal, verbatim" }),
	title: Type.Optional(Type.String({ description: "Short human title for the mission" })),
	slug: Type.Optional(Type.String({ description: "Kebab-case plan slug; derived from the goal when omitted" })),
	framing: Type.Object({
		summary: Type.String({ description: "Problem framing in two to four sentences" }),
		successCriteria: Type.Array(Type.String(), { description: "Observable criteria that define success" }),
		constraints: Type.Optional(Type.Array(Type.String())),
		nonGoals: Type.Optional(Type.Array(Type.String())),
		risks: Type.Optional(Type.Array(Type.String())),
		openQuestions: Type.Optional(Type.Array(Type.String())),
	}),
	agents: Type.Array(AgentSpec, { description: "The minimal set of worker agents that can achieve the goal" }),
	tasks: Type.Array(TaskSpec, { description: "The shared TODO task graph" }),
	planDir: Type.Optional(
		Type.String({
			description: `Directory for GOAL.md, ROSTER.md and TODO.md (default: ${CONFIG_DIR_NAME}/frame/<slug>)`,
		}),
	),
	agentsDir: Type.Optional(
		Type.String({
			description: `Directory for generated AGENT.md files (default: ${CONFIG_DIR_NAME}/agents)`,
		}),
	),
	overwrite: Type.Optional(Type.Boolean({ description: "Overwrite existing scaffold files (default false)" })),
});

// ---------------------------------------------------------------------------
// Kickoff prompt
// ---------------------------------------------------------------------------

const SKILL_URL = new URL("../skills/agent-scaffolding/SKILL.md", import.meta.url);
const SKILL_DIR = fileURLToPath(new URL("../skills/agent-scaffolding/", import.meta.url));

async function loadSkillBody(): Promise<string> {
	const raw = await readFile(fileURLToPath(SKILL_URL), "utf8");
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

interface FrameArgs {
	planDir?: string;
	agentsDir?: string;
	name?: string;
	goal: string;
}

function stripQuotes(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseArgs(raw: string): FrameArgs {
	const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	const goalParts: string[] = [];
	let planDir: string | undefined;
	let agentsDir: string | undefined;
	let name: string | undefined;

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--out" || token === "--plan-dir") planDir = stripQuotes(tokens[++i]);
		else if (token.startsWith("--out=")) planDir = stripQuotes(token.slice("--out=".length));
		else if (token === "--agents" || token === "--agents-dir") agentsDir = stripQuotes(tokens[++i]);
		else if (token.startsWith("--agents=")) agentsDir = stripQuotes(token.slice("--agents=".length));
		else if (token === "--name" || token === "--slug") name = stripQuotes(tokens[++i]);
		else goalParts.push(token);
	}

	return { planDir, agentsDir, name, goal: goalParts.join(" ").trim() };
}

async function buildKickoff(goal: string, args: FrameArgs, cwd: string): Promise<string> {
	const skill = await loadSkillBody();
	const overrides: string[] = [];
	if (args.planDir) overrides.push(`- planDir override: ${args.planDir}`);
	if (args.agentsDir) overrides.push(`- agentsDir override: ${args.agentsDir}`);
	if (args.name) overrides.push(`- slug override: ${args.name}`);

	return `[agent-frame] Goal framing request

Project root: ${cwd}
${overrides.length ? `${overrides.join("\n")}\n` : ""}
Goal (verbatim from the user):
"""
${goal}
"""

Persist the result by calling the \`frame_scaffold\` tool exactly once. Do not
hand-write GOAL.md, ROSTER.md, TODO.md, or any AGENT.md file.

Follow this workflow:

--- BEGIN SKILL: agent-scaffolding ---
${skill}
--- END SKILL ---

Supporting references (read with absolute paths when useful):
- ${join(SKILL_DIR, "references", "agent-authoring.md")}
- ${join(SKILL_DIR, "references", "todo-format.md")}
- ${join(SKILL_DIR, "assets", "agent-template.md")}

Do not ask for the goal again; it is provided above. Ask at most one or two
clarifying questions, and only when a missing decision would materially change
the roster. Finish by showing the generated file tree and the recommended next
step for execution: review the scaffold, then run \`/frame-run <slug>\`.`;
}

// ---------------------------------------------------------------------------
// /frame-run kickoff
// ---------------------------------------------------------------------------

const EXECUTION_URL = new URL("../skills/agent-scaffolding/references/execution.md", import.meta.url);

async function loadExecutionBody(): Promise<string> {
	return (await readFile(fileURLToPath(EXECUTION_URL), "utf8")).trim();
}

interface FrameRunArgs {
	planDir?: string;
	slug?: string;
	phase?: string;
	from?: string;
	dryRun: boolean;
}

function parseRunArgs(raw: string): FrameRunArgs {
	const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	const slugParts: string[] = [];
	let planDir: string | undefined;
	let phase: string | undefined;
	let from: string | undefined;
	let dryRun = false;

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--dry-run") dryRun = true;
		else if (token === "--plan" || token === "--plan-dir") planDir = stripQuotes(tokens[++i]);
		else if (token.startsWith("--plan=")) planDir = stripQuotes(token.slice("--plan=".length));
		else if (token === "--phase") phase = stripQuotes(tokens[++i]);
		else if (token.startsWith("--phase=")) phase = stripQuotes(token.slice("--phase=".length));
		else if (token === "--from") from = stripQuotes(tokens[++i]);
		else if (token.startsWith("--from=")) from = stripQuotes(token.slice("--from=".length));
		else slugParts.push(token);
	}

	return {
		planDir,
		phase,
		from,
		dryRun,
		slug: slugParts.length > 0 ? slugify(slugParts.join("-")) : undefined,
	};
}

interface PlanCandidate {
	slug: string;
	path: string;
	mtimeMs: number;
}

/**
 * List framed plans under a frame root, newest TODO.md first. Directories
 * without a TODO.md are not considered framed plans.
 */
async function listPlans(frameRoot: string): Promise<PlanCandidate[]> {
	let entries;
	try {
		entries = await readdir(frameRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const plans: PlanCandidate[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const path = join(frameRoot, entry.name);
		try {
			const todoStat = await stat(join(path, "TODO.md"));
			plans.push({ slug: entry.name, path, mtimeMs: todoStat.mtimeMs });
		} catch {
			// Not a framed plan directory.
		}
	}
	return plans.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function buildRunKickoff(
	plan: PlanCandidate,
	args: FrameRunArgs,
	cwd: string,
	alternatives: string[],
): Promise<string> {
	const execution = await loadExecutionBody();
	const scope: string[] = [];
	if (args.phase) scope.push(`Run only phase ${args.phase} of the task graph, then stop for review.`);
	if (args.from) scope.push(`Resume from task ${args.from}: run that task and its unfinished dependents only.`);
	if (scope.length === 0) scope.push("Run every unfinished task in dependency order.");
	const label = relative(cwd, plan.path) || ".";

	return `[agent-frame] Task-graph execution request

Project root: ${cwd}
Plan directory: ${plan.path} (${label}/)
Slug: ${plan.slug}
Mode: ${args.dryRun ? "dry-run — build the launch plan but do NOT launch any subagent" : "execute"}
Scope: ${scope.join(" ")}
${
	alternatives.length > 0
		? `Other framed plans: ${alternatives.join(", ")} — this run targets "${plan.slug}"; redirect with \`/frame-run <slug>\` if that is wrong.`
		: "This is the only framed plan under the default directory."
}

Execute the task graph in ${label}/TODO.md with pi-subagents. Do not re-run
/frame, do not call frame_scaffold, and do not rewrite GOAL.md, ROSTER.md, or
the task definitions in TODO.md — the only permitted plan edits are status and
evidence updates in TODO.md.

Follow this workflow:

--- BEGIN REFERENCE: execution.md ---
${execution}
--- END REFERENCE ---

Supporting references (read with absolute paths when useful):
- ${join(SKILL_DIR, "references", "todo-format.md")}
- ${join(SKILL_DIR, "references", "agent-authoring.md")}

Begin with preflight. If anything blocks execution (missing agents, unknown
scope targets, an unreadable plan), stop and report instead of guessing.`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function agentFrame(pi: ExtensionAPI) {
	pi.registerCommand("frame", {
		description: "Frame a goal into agent workers, AGENT.md files, and a shared TODO.md",
		getArgumentCompletions: (prefix) => {
			const flags = ["--out ", "--agents ", "--name "];
			const items = flags.filter((flag) => flag.startsWith(prefix)).map((flag) => ({ value: flag, label: flag }));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = parseArgs(rawArgs);
			let goal = args.goal;

			if (!goal) {
				if (!ctx.hasUI) {
					ctx.ui.notify("No goal provided. Use: /frame <goal description>", "warning");
					return;
				}
				const typed = await ctx.ui.editor(
					"Describe the goal you want to achieve. Include success criteria, constraints, and known components.",
					"",
				);
				goal = (typed ?? "").trim();
			}

			if (!goal) {
				ctx.ui.notify("No goal provided — nothing to frame.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Try /frame again once the current turn finishes.", "warning");
				return;
			}

			const kickoff = await buildKickoff(goal, args, ctx.cwd);
			pi.setSessionName(`Frame: ${args.name ?? slugify(goal)}`);
			ctx.ui.notify("Framing goal → agent roster, AGENT.md files, TODO.md…", "info");
			pi.sendUserMessage(kickoff);
		},
	});

	pi.registerCommand("frame-run", {
		description: "Execute a framed task graph with pi-subagents: /frame-run [slug] [--phase N] [--from T<n>] [--dry-run]",
		getArgumentCompletions: (prefix) => {
			const flags = ["--phase ", "--from ", "--dry-run", "--plan "];
			const items = flags.filter((flag) => flag.startsWith(prefix)).map((flag) => ({ value: flag, label: flag }));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = parseRunArgs(rawArgs);
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Try /frame-run again once the current turn finishes.", "warning");
				return;
			}

			const frameRoot = join(ctx.cwd, CONFIG_DIR_NAME, "frame");
			const plans = await listPlans(frameRoot);
			let target: PlanCandidate | undefined;

			if (args.planDir) {
				const path = resolve(ctx.cwd, args.planDir);
				try {
					const todoStat = await stat(join(path, "TODO.md"));
					target = { slug: args.slug ?? basename(path), path, mtimeMs: todoStat.mtimeMs };
				} catch {
					ctx.ui.notify(`No TODO.md found in ${args.planDir}. Point --plan at a framed plan directory.`, "warning");
					return;
				}
			} else if (args.slug) {
				target = plans.find((plan) => plan.slug === args.slug);
				if (!target) {
					const hint =
						plans.length > 0
							? ` Available plans: ${plans.map((plan) => plan.slug).join(", ")}.`
							: " Run /frame first to create one.";
					ctx.ui.notify(`No framed plan "${args.slug}".${hint}`, "warning");
					return;
				}
			} else {
				if (plans.length === 0) {
					ctx.ui.notify("No framed plans under .pi/frame. Run /frame first.", "warning");
					return;
				}
				target = plans[0];
			}

			const alternatives = plans.filter((plan) => plan.path !== target.path).map((plan) => plan.slug);
			const kickoff = await buildRunKickoff(target, args, ctx.cwd, alternatives);
			pi.setSessionName(`Frame run: ${target.slug}`);
			ctx.ui.notify(
				args.dryRun
					? `Planning execution of "${target.slug}" (dry-run)…`
					: `Kicking off execution of "${target.slug}"…`,
				"info",
			);
			pi.sendUserMessage(kickoff);
		},
	});

	pi.registerTool({
		name: "frame_scaffold",
		label: "Frame Scaffold",
		description:
			"Persist a framed goal into a deterministic scaffold: GOAL.md, ROSTER.md, TODO.md and one AGENT.md per worker agent. Use only after the agent-scaffolding workflow has decided the roster and task graph.",
		promptSnippet: "Write a framed goal's GOAL.md, ROSTER.md, TODO.md and per-agent AGENT.md files",
		promptGuidelines: [
			"Use frame_scaffold to persist an agent-scaffolding plan; do not hand-write GOAL.md, ROSTER.md, TODO.md, or AGENT.md files.",
		],
		parameters: FrameParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const slug = slugify(params.slug || params.title || params.goal);
			const planDir = params.planDir ?? join(CONFIG_DIR_NAME, "frame", slug);
			const agentsDir = params.agentsDir ?? join(CONFIG_DIR_NAME, "agents");

			const plan = {
				goal: params.goal,
				title: params.title,
				framing: params.framing,
				agents: params.agents,
				tasks: params.tasks,
			};

			try {
				const result = await writeScaffold(plan, {
					cwd,
					planDir,
					agentsDir,
					slug,
					title: params.title,
					overwrite: params.overwrite ?? false,
				});

				const planDirLabel = relative(cwd, resolve(cwd, planDir)) || ".";

				if (!result.ok) {
					return {
						content: [
							{
								type: "text",
								text: [
									"frame_scaffold failed — fix the plan and call it again.",
									"",
									...result.errors.map((error) => `- ${error}`),
								].join("\n"),
							},
						],
						details: { ok: false, errors: result.errors, warnings: result.warnings, files: [] },
					};
				}

				const lines = [
					`Framed "${params.title ?? slug}" into ${params.agents.length} agent(s) and ${params.tasks.length} task(s).`,
					"",
					"Written:",
					...result.files.map((file) => `- ${file.display}`),
				];
				if (result.warnings.length > 0) {
					lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
				}
				lines.push(
					"",
					`Next: review ${planDirLabel}/TODO.md and ${planDirLabel}/ROSTER.md, then run /frame-run ${slug} to execute the task graph with pi-subagents.`,
				);

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						ok: true,
						slug,
						planDir: planDirLabel,
						agentsDir,
						files: result.files,
						warnings: result.warnings,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `frame_scaffold failed: ${message}` }],
					details: { ok: false, errors: [message], warnings: [], files: [] },
				};
			}
		},
	});
}
