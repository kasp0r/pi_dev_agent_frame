import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

// Load the extension exactly the way pi does: through jiti's TypeScript loader.
const jiti = createJiti(import.meta.url, { interopDefault: true });
const imported = await jiti.import("../extensions/agent-frame.ts");
const agentFrame = typeof imported === "function" ? imported : imported.default;

function createPi() {
	const commands = new Map();
	const tools = new Map();
	const messages = [];
	return {
		commands,
		tools,
		messages,
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		sendUserMessage(content) {
			messages.push(content);
		},
		setSessionName() {},
	};
}

function createCommandContext(overrides = {}) {
	const notifications = [];
	const editorCalls = [];
	const ctx = {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: overrides.hasUI ?? true,
		isIdle: overrides.isIdle ?? (() => true),
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			async editor(prompt, prefilled) {
				editorCalls.push({ prompt, prefilled });
				return overrides.editorResult;
			},
		},
	};
	return { ctx, notifications, editorCalls };
}

test("registers the /frame command and frame_scaffold tool", () => {
	const pi = createPi();
	agentFrame(pi);
	assert.ok(pi.commands.has("frame"));
	assert.ok(pi.commands.has("frame-run"));
	assert.ok(pi.tools.has("frame_scaffold"));
	assert.equal(pi.tools.get("frame_scaffold").label, "Frame Scaffold");
});

test("frame_scaffold writes the full scaffold through the extension", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-ext-"));
	try {
		const pi = createPi();
		agentFrame(pi);
		const tool = pi.tools.get("frame_scaffold");

		const result = await tool.execute(
			"call-1",
			{
				goal: "Ship a CLI greeting command",
				title: "Greeting CLI",
				framing: {
					summary: "Add a greet command with tests.",
					successCriteria: ["greet CLI prints hello", "tests pass"],
				},
				agents: [
					{
						name: "cli-implementer",
						role: "Implementer",
						description: "Implements the greet command",
						systemPrompt: "Implement the CLI seam only.",
					},
				],
				tasks: [
					{
						id: "T1",
						title: "Implement greet",
						owner: "cli-implementer",
						acceptance: "greet prints hello",
					},
				],
			},
			undefined,
			undefined,
			{ cwd },
		);

		assert.equal(result.details.ok, true);
		assert.equal(result.details.planDir, ".pi/frame/greeting-cli");
		const todo = await readFile(join(cwd, ".pi/frame/greeting-cli/TODO.md"), "utf8");
		assert.ok(todo.includes("Implement greet"));
		const agent = await readFile(join(cwd, ".pi/agents/cli-implementer/AGENT.md"), "utf8");
		assert.ok(agent.includes("name: cli-implementer"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("frame_scaffold reports validation errors without writing", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-ext-"));
	try {
		const pi = createPi();
		agentFrame(pi);
		const tool = pi.tools.get("frame_scaffold");
		const result = await tool.execute(
			"call-2",
			{
				goal: "Bad plan",
				framing: { summary: "x", successCriteria: ["y"] },
				agents: [{ name: "Good", role: "r", description: "d", systemPrompt: "s" }],
				tasks: [{ id: "T1", title: "t", owner: "missing", acceptance: "a" }],
			},
			undefined,
			undefined,
			{ cwd },
		);
		assert.equal(result.details.ok, false);
		assert.ok(result.content[0].text.includes("frame_scaffold failed"));
		await assert.rejects(readFile(join(cwd, ".pi/frame/bad-plan/TODO.md"), "utf8"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/frame with an inline goal injects the workflow without prompting", async () => {
	const pi = createPi();
	agentFrame(pi);
	const { ctx, notifications, editorCalls } = createCommandContext();
	await pi.commands.get("frame").handler("add a health check endpoint", ctx);

	assert.equal(editorCalls.length, 0);
	assert.equal(pi.messages.length, 1);
	const message = pi.messages[0];
	assert.ok(message.includes("add a health check endpoint"));
	assert.ok(message.includes("frame_scaffold"));
	assert.ok(message.includes("BEGIN SKILL: agent-scaffolding"));
	assert.ok(message.includes("## Step 3 — Decide the roster"));
	assert.ok(notifications.some((n) => n.level === "info"));
});

test("/frame without a goal prompts via the editor", async () => {
	const pi = createPi();
	agentFrame(pi);
	const { ctx, editorCalls } = createCommandContext({ editorResult: "reduce flaky tests" });
	await pi.commands.get("frame").handler("", ctx);

	assert.equal(editorCalls.length, 1);
	assert.equal(pi.messages.length, 1);
	assert.ok(pi.messages[0].includes("reduce flaky tests"));
});

test("/frame cancels cleanly when the editor is empty", async () => {
	const pi = createPi();
	agentFrame(pi);
	const { ctx, notifications } = createCommandContext({ editorResult: "   " });
	await pi.commands.get("frame").handler("", ctx);

	assert.equal(pi.messages.length, 0);
	assert.ok(notifications.some((n) => n.level === "warning"));
});

test("/frame refuses to run while the agent is busy", async () => {
	const pi = createPi();
	agentFrame(pi);
	const { ctx, notifications } = createCommandContext({ isIdle: () => false });
	await pi.commands.get("frame").handler("some goal", ctx);

	assert.equal(pi.messages.length, 0);
	assert.ok(notifications.some((n) => n.level === "warning"));
});

test("/frame parses --out and --agents overrides", async () => {
	const pi = createPi();
	agentFrame(pi);
	const { ctx } = createCommandContext();
	await pi.commands.get("frame").handler('--out docs/plan --agents .pi/agents "goal here"', ctx);
	const message = pi.messages[0];
	assert.ok(message.includes("planDir override: docs/plan"));
	assert.ok(message.includes("agentsDir override: .pi/agents"));
	assert.ok(message.includes("goal here"));
});

// ---------------------------------------------------------------------------
// /frame-run
// ---------------------------------------------------------------------------

function planParams(goal, agentName = "api-implementer") {
	return {
		goal,
		framing: { summary: `Summary for ${goal}.`, successCriteria: [`${goal} works`] },
		agents: [
			{
				name: agentName,
				role: "Implementer",
				description: `Implements ${goal}`,
				systemPrompt: "Implement the seam only.",
			},
		],
		tasks: [
			{ id: "T1", title: `Implement ${goal}`, owner: agentName, acceptance: `${goal} verified` },
		],
	};
}

async function scaffoldPlan(pi, cwd, goal, agentName) {
	const tool = pi.tools.get("frame_scaffold");
	const result = await tool.execute(`call-${goal}`, planParams(goal, agentName), undefined, undefined, { cwd });
	assert.equal(result.details.ok, true, result.content[0].text);
}

test("/frame-run without any plan warns and sends nothing", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-run-"));
	try {
		const pi = createPi();
		agentFrame(pi);
		const { ctx, notifications } = createCommandContext({ cwd });
		await pi.commands.get("frame-run").handler("", ctx);

		assert.equal(pi.messages.length, 0);
		assert.ok(notifications.some((n) => n.level === "warning" && n.message.includes("/frame")));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/frame-run with an unknown slug lists available plans", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-run-"));
	try {
		const pi = createPi();
		agentFrame(pi);
		await scaffoldPlan(pi, cwd, "Known plan");
		const { ctx, notifications } = createCommandContext({ cwd });
		await pi.commands.get("frame-run").handler("other-slug", ctx);

		assert.equal(pi.messages.length, 0);
		const warning = notifications.find((n) => n.level === "warning");
		assert.ok(warning.message.includes('No framed plan "other-slug"'));
		assert.ok(warning.message.includes("known-plan"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/frame-run with a slug injects the execution kickoff", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-run-"));
	try {
		const pi = createPi();
		agentFrame(pi);
		await scaffoldPlan(pi, cwd, "Items API");
		const { ctx, notifications } = createCommandContext({ cwd });
		await pi.commands.get("frame-run").handler("items-api", ctx);

		assert.equal(pi.messages.length, 1);
		const message = pi.messages[0];
		assert.ok(message.includes("Slug: items-api"));
		assert.ok(message.includes("Mode: execute"));
		assert.ok(message.includes(join(cwd, ".pi", "frame", "items-api")));
		assert.ok(message.includes("BEGIN REFERENCE: execution.md"));
		assert.ok(message.includes("subagent"));
		assert.ok(!message.includes("BEGIN SKILL"));
		assert.ok(notifications.some((n) => n.level === "info"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/frame-run defaults to the newest plan and lists alternatives", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-run-"));
	try {
		const pi = createPi();
		agentFrame(pi);
		await scaffoldPlan(pi, cwd, "Alpha plan", "alpha-implementer");
		await scaffoldPlan(pi, cwd, "Beta plan", "beta-implementer");
		// Make the ordering deterministic regardless of filesystem mtime granularity.
		const oldDate = new Date("2020-01-01T00:00:00Z");
		await utimes(join(cwd, ".pi", "frame", "alpha-plan", "TODO.md"), oldDate, oldDate);

		const { ctx } = createCommandContext({ cwd });
		await pi.commands.get("frame-run").handler("", ctx);

		assert.equal(pi.messages.length, 1);
		assert.ok(pi.messages[0].includes("Slug: beta-plan"));
		assert.ok(pi.messages[0].includes("Other framed plans: alpha-plan"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/frame-run flags shape scope and mode", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-run-"));
	try {
		const pi = createPi();
		agentFrame(pi);
		await scaffoldPlan(pi, cwd, "Items API");
		const { ctx } = createCommandContext({ cwd });

		await pi.commands.get("frame-run").handler("--dry-run --phase 2 items-api", ctx);
		let message = pi.messages[pi.messages.length - 1];
		assert.ok(message.includes("Mode: dry-run"));
		assert.ok(message.includes("do NOT launch"));
		assert.ok(message.includes("phase 2"));

		await pi.commands.get("frame-run").handler("--from T3 items-api", ctx);
		message = pi.messages[pi.messages.length - 1];
		assert.ok(message.includes("Resume from task T3"));

		await pi.commands.get("frame-run").handler("items api", ctx);
		message = pi.messages[pi.messages.length - 1];
		assert.ok(message.includes("Slug: items-api"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/frame-run accepts a custom --plan directory", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-run-"));
	try {
		const pi = createPi();
		agentFrame(pi);
		const tool = pi.tools.get("frame_scaffold");
		const result = await tool.execute(
			"call-custom",
			{ ...planParams("Custom spot"), planDir: "docs/plan" },
			undefined,
			undefined,
			{ cwd },
		);
		assert.equal(result.details.ok, true, result.content[0].text);

		const { ctx } = createCommandContext({ cwd });
		await pi.commands.get("frame-run").handler("--plan docs/plan", ctx);
		assert.equal(pi.messages.length, 1);
		assert.ok(pi.messages[0].includes(join(cwd, "docs", "plan")));
		assert.ok(pi.messages[0].includes("Slug: plan"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/frame-run refuses to run while the agent is busy", async () => {
	const pi = createPi();
	agentFrame(pi);
	const { ctx, notifications } = createCommandContext({ isIdle: () => false });
	await pi.commands.get("frame-run").handler("items-api", ctx);

	assert.equal(pi.messages.length, 0);
	assert.ok(notifications.some((n) => n.level === "warning"));
});
