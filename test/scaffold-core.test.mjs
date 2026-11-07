import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

// Load the TS module through jiti — the same loader pi uses at runtime.
const jiti = createJiti(import.meta.url);
const { buildScaffold, slugify, validatePlan, writeScaffold } = await jiti.import("../lib/scaffold-core.ts");

/** @returns {any} */
function samplePlan() {
	return {
		goal: "Add a rate-limited public API for items",
		title: "Rate-limited items API",
		framing: {
			summary: "Expose /v2/items behind a token-bucket limiter with tests and docs.",
			successCriteria: ["pnpm test passes", "/v2/items returns 429 after the burst limit"],
			constraints: ["No new runtime dependencies"],
			nonGoals: ["Admin UI"],
			risks: ["Limiter state must survive restarts"],
			openQuestions: ["Per-key or global limit?"],
		},
		agents: [
			{
				name: "api-implementer",
				role: "API implementer",
				description: "Implements the rate-limited items endpoint",
				responsibility: "Owns src/api and its tests",
				tools: "read, grep, find, ls, bash, edit, write",
				systemPrompt: "You implement the API seam. Keep changes inside src/api.",
			},
			{
				name: "api-reviewer",
				role: "Independent reviewer",
				description: "Verifies the API behavior against acceptance criteria",
				systemPrompt: "You verify, you do not edit. Report evidence.",
			},
		],
		tasks: [
			{ id: "T1", title: "Design limiter contract", owner: "api-implementer", phase: "Design", acceptance: "Contract documented in docs/limiter.md" },
			{ id: "T2", title: "Implement endpoint", owner: "api-implementer", phase: "Implement", dependsOn: ["T1"], acceptance: "Endpoint responds and tests pass", evidence: "pnpm test output" },
			{ id: "T3", title: "Verify rate limiting", owner: "api-reviewer", phase: "Verify", dependsOn: ["T2"], acceptance: "429 after burst limit is demonstrated" },
		],
	};
}

test("slugify produces a filesystem-safe slug", () => {
	assert.equal(slugify("Add a rate-limited public API!"), "add-a-rate-limited-public-api");
	assert.equal(slugify("   "), "goal");
	assert.ok(slugify("a".repeat(200)).length <= 48);
});

test("validatePlan accepts a well-formed plan", () => {
	const { errors, warnings } = validatePlan(samplePlan());
	assert.deepEqual(errors, []);
	assert.deepEqual(warnings, []);
});

test("validatePlan rejects duplicate agents, unknown owners, and cycles", () => {
	const plan = samplePlan();
	plan.agents.push({ ...plan.agents[0] });
	plan.tasks[1].owner = "ghost";
	plan.tasks[0].dependsOn = ["T3"];
	const { errors } = validatePlan(plan);
	assert.ok(errors.some((e) => e.includes("Duplicate agent name")));
	assert.ok(errors.some((e) => e.includes('owner "ghost"')));
	assert.ok(errors.some((e) => e.includes("cycle")));
});

test("validatePlan rejects malformed task ids, access conflicts, and thinking levels", () => {
	const plan = samplePlan();
	plan.tasks[0].id = "T|1";
	plan.agents[0].thinking = "extreme";
	plan.agents[1].access = "read-only";
	plan.agents[1].tools = "read, write";
	const { errors } = validatePlan(plan);
	assert.ok(errors.some((error) => error.includes('Task "T|1"')));
	assert.ok(errors.some((error) => error.includes("unknown thinking level")));
	assert.ok(errors.some((error) => error.includes("read-only but its tools")));
});

test("validatePlan warns about idle agents", () => {
	const plan = samplePlan();
	plan.agents.push({ name: "idle-agent", role: "Idle", description: "Does nothing", systemPrompt: "..." });
	const { warnings } = validatePlan(plan);
	assert.ok(warnings.some((w) => w.includes("idle-agent")));
});

test("buildScaffold renders GOAL, ROSTER, TODO, and one AGENT per worker", () => {
	const plan = samplePlan();
	delete plan.agents[0].tools;
	plan.agents[0].access = "writer";
	plan.tasks[0].title = "Document limiter contract";
	plan.tasks[1].title = "Add endpoint";
	const built = buildScaffold(plan, { cwd: "/repo", planDir: ".pi/frame/x", agentsDir: ".pi/agents" });
	assert.deepEqual(built.errors, []);
	const kinds = built.files.map((f) => f.kind);
	assert.deepEqual(kinds, ["goal", "roster", "todo", "agent", "agent"]);
	const todo = built.files.find((f) => f.kind === "todo");
	assert.ok(todo.content.includes("**T2**"));
	assert.ok(todo.content.includes("depends: `T1`"));
	const roster = built.files.find((f) => f.kind === "roster");
	assert.ok(roster.content.includes("**Tools:** `read, grep, find, ls, bash, edit, write`"));
	const agent = built.files.find((f) => f.display.endsWith("api-implementer/AGENT.md"));
	assert.ok(agent.content.startsWith("---\n"));
	assert.ok(agent.content.includes("tools: read, grep, find, ls, bash, edit, write"));
	assert.ok(agent.content.includes("acceptanceRole: writer"));
	assert.ok(agent.content.includes("## Your tasks"));
	const reviewer = built.files.find((f) => f.display.endsWith("api-reviewer/AGENT.md"));
	assert.ok(reviewer.content.includes("tools: read, grep, find, ls"));
	assert.ok(reviewer.content.includes("acceptanceRole: read-only"));
});

test("buildScaffold escapes table cells, YAML scalars, and list whitespace", () => {
	const plan = samplePlan();
	plan.agents[0].role = "API | implementer";
	plan.agents[0].description = "Implements API | CLI integration";
	plan.agents[0].tools = "read, bash # verification only";
	plan.agents[0].thinking = "high";
	plan.framing.successCriteria = ["tests pass\nand the API responds"];

	const built = buildScaffold(plan, { cwd: "/repo", planDir: ".pi/frame/x", agentsDir: ".pi/agents" });
	assert.deepEqual(built.errors, []);
	const roster = built.files.find((file) => file.kind === "roster").content;
	assert.ok(roster.includes("API \\| implementer"));
	assert.ok(roster.includes("Implements API \\| CLI integration"));
	const todo = built.files.find((file) => file.kind === "todo").content;
	assert.ok(todo.includes("- [ ] tests pass and the API responds"));
	const agent = built.files.find((file) => file.display.endsWith("api-implementer/AGENT.md")).content;
	assert.ok(agent.includes('tools: "read, bash # verification only"'));
	assert.ok(agent.includes("thinking: high"));
});

test("writeScaffold leaves unrelated targets untouched when one file conflicts", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-test-"));
	try {
		const planDir = join(cwd, ".pi/frame/x");
		await mkdir(planDir, { recursive: true });
		await writeFile(join(planDir, "TODO.md"), "existing plan", "utf8");

		const result = await writeScaffold(samplePlan(), {
			cwd,
			planDir: ".pi/frame/x",
			agentsDir: ".pi/agents",
		});

		assert.equal(result.ok, false);
		assert.equal(await readFile(join(planDir, "TODO.md"), "utf8"), "existing plan");
		await assert.rejects(readFile(join(planDir, "GOAL.md"), "utf8"));
		await assert.rejects(readFile(join(cwd, ".pi/agents/api-implementer/AGENT.md"), "utf8"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("writeScaffold writes files and refuses to overwrite by default", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-test-"));
	try {
		const first = await writeScaffold(samplePlan(), {
			cwd,
			planDir: ".pi/frame/x",
			agentsDir: ".pi/agents",
			overwrite: false,
		});
		assert.equal(first.ok, true);
		assert.equal(first.files.length, 5);
		const todo = await readFile(join(cwd, ".pi/frame/x/TODO.md"), "utf8");
		assert.ok(todo.startsWith("# TODO —"));

		const second = await writeScaffold(samplePlan(), {
			cwd,
			planDir: ".pi/frame/x",
			agentsDir: ".pi/agents",
			overwrite: false,
		});
		assert.equal(second.ok, false);
		assert.ok(second.errors[0].includes("Refusing to overwrite"));

		const third = await writeScaffold(samplePlan(), {
			cwd,
			planDir: ".pi/frame/x",
			agentsDir: ".pi/agents",
			overwrite: true,
		});
		assert.equal(third.ok, true);
		const temporaryFiles = (await readdir(join(cwd, ".pi/frame/x"))).filter((name) => name.includes(".tmp"));
		assert.deepEqual(temporaryFiles, []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("writeScaffold confines output to cwd unless explicitly allowed", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-frame-path-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	try {
		const options = {
			cwd,
			planDir: join(root, "outside/plan"),
			agentsDir: join(root, "outside/agents"),
		};
		const rejected = await writeScaffold(samplePlan(), options);
		assert.equal(rejected.ok, false);
		assert.ok(rejected.errors.some((error) => error.includes("allowOutsideCwd=true")));
		await assert.rejects(readFile(join(root, "outside/plan/TODO.md"), "utf8"));

		const allowed = await writeScaffold(samplePlan(), { ...options, allowOutsideCwd: true });
		assert.equal(allowed.ok, true);
		assert.ok((await readFile(join(root, "outside/plan/TODO.md"), "utf8")).startsWith("# TODO"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writeScaffold rejects symlink directory escapes before writing", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-frame-link-"));
	const cwd = join(root, "project");
	const outside = join(root, "outside");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(outside);
	await symlink(outside, join(cwd, ".pi/frame-link"), "dir");
	try {
		const result = await writeScaffold(samplePlan(), {
			cwd,
			planDir: ".pi/frame-link/plan",
			agentsDir: ".pi/agents",
		});
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((error) => error.includes("symbolic link")));
		await assert.rejects(readFile(join(outside, "plan/TODO.md"), "utf8"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writeScaffold honors pre-aborted signals without creating files", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-abort-"));
	try {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			writeScaffold(samplePlan(), { cwd, planDir: ".pi/frame/x", agentsDir: ".pi/agents", signal: controller.signal }),
			{ name: "AbortError" },
		);
		await assert.rejects(readFile(join(cwd, ".pi/frame/x/TODO.md"), "utf8"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("writeScaffold staging failures preserve existing files and create no partial scaffold", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-stage-"));
	const planDir = join(cwd, ".pi/frame/x");
	await mkdir(join(planDir, "ROSTER.md"), { recursive: true });
	await writeFile(join(planDir, "GOAL.md"), "original goal", "utf8");
	try {
		await assert.rejects(
			writeScaffold(samplePlan(), {
				cwd,
				planDir: ".pi/frame/x",
				agentsDir: ".pi/agents",
				overwrite: true,
			}),
			/not a regular file|EISDIR/,
		);
		assert.equal(await readFile(join(planDir, "GOAL.md"), "utf8"), "original goal");
		await assert.rejects(readFile(join(planDir, "TODO.md"), "utf8"));
		await assert.rejects(readFile(join(cwd, ".pi/agents/api-implementer/AGENT.md"), "utf8"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
