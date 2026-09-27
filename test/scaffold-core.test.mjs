import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
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

test("validatePlan warns about idle agents", () => {
	const plan = samplePlan();
	plan.agents.push({ name: "idle-agent", role: "Idle", description: "Does nothing", systemPrompt: "..." });
	const { warnings } = validatePlan(plan);
	assert.ok(warnings.some((w) => w.includes("idle-agent")));
});

test("buildScaffold renders GOAL, ROSTER, TODO, and one AGENT per worker", () => {
	const plan = samplePlan();
	const built = buildScaffold(plan, { cwd: "/repo", planDir: ".pi/frame/x", agentsDir: ".pi/agents" });
	assert.deepEqual(built.errors, []);
	const kinds = built.files.map((f) => f.kind);
	assert.deepEqual(kinds, ["goal", "roster", "todo", "agent", "agent"]);
	const todo = built.files.find((f) => f.kind === "todo");
	assert.ok(todo.content.includes("**T2**"));
	assert.ok(todo.content.includes("depends: `T1`"));
	const agent = built.files.find((f) => f.display.endsWith("api-implementer/AGENT.md"));
	assert.ok(agent.content.startsWith("---\n"));
	assert.ok(agent.content.includes("tools: read, grep, find, ls, bash, edit, write"));
	assert.ok(agent.content.includes("## Your tasks"));
	const reviewer = built.files.find((f) => f.display.endsWith("api-reviewer/AGENT.md"));
	assert.ok(reviewer.content.includes("tools: read, grep, find, ls"));
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
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
