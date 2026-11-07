import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildScaffold } = await jiti.import("../lib/scaffold-core.ts");
const { buildExecutionPlan, extractGate, formatExecutionPlan, parseRosterAgents } = await jiti.import(
	"../lib/execution-core.ts",
);

function planFixture() {
	return {
		goal: "Ship a verified API",
		framing: { summary: "Build and verify one API seam.", successCriteria: ["Tests pass"] },
		agents: [
			{ name: "api-writer", description: "Writes the API", access: "writer", systemPrompt: "Implement the seam." },
			{ name: "api-reviewer", description: "Reviews the API", access: "read-only", systemPrompt: "Review only." },
		],
		tasks: [
			{ id: "T1", title: "Map the API", owner: "api-writer", phase: "Recon", acceptance: "Seams are listed" },
			{
				id: "T2",
				title: "Add the endpoint",
				owner: "api-writer",
				phase: "Implement",
				dependsOn: ["T1"],
				acceptance: "Endpoint works",
				evidence: "npm test — endpoint tests pass",
			},
			{
				id: "T3",
				title: "Review the endpoint",
				owner: "api-reviewer",
				phase: "Verify",
				dependsOn: ["T2"],
				acceptance: "Review has evidence",
			},
		],
	};
}

function scaffold(plan = planFixture()) {
	const built = buildScaffold(plan, { cwd: "/repo", planDir: ".pi/frame/api", agentsDir: ".pi/agents/api" });
	assert.deepEqual(built.errors, []);
	return {
		todo: built.files.find((file) => file.kind === "todo").content,
		roster: built.files.find((file) => file.kind === "roster").content,
	};
}

function markDone(todo, id, owner) {
	return todo
		.replace(`- [ ] **${id}**`, `- [x] **${id}**`)
		.replace(`| \`${id}\` | \`${owner}\` | todo |`, `| \`${id}\` | \`${owner}\` | done |`);
}

test("buildExecutionPlan parses tasks and returns linear topological layers", () => {
	const { todo, roster } = scaffold();
	const plan = buildExecutionPlan({ todo, roster });
	assert.deepEqual(plan.errors, []);
	assert.deepEqual(plan.layers.map((layer) => layer.map((task) => task.id)), [["T1"], ["T2"], ["T3"]]);
	assert.equal(plan.tasks[1].gate, "npm test");
	assert.deepEqual(parseRosterAgents(roster), ["api-writer", "api-reviewer"]);
	const formatted = formatExecutionPlan(plan);
	assert.ok(formatted.includes("| 2 | `T2` | Add the endpoint |"));
	assert.ok(formatted.includes("Layer 3: `T3`"));
});

test("buildExecutionPlan groups independent tasks into parallel layers", () => {
	const input = planFixture();
	input.tasks.splice(2, 0, {
		id: "T2b",
		title: "Review the contract",
		owner: "api-reviewer",
		phase: "Implement",
		dependsOn: ["T1"],
		acceptance: "Contract review is reported",
	});
	input.tasks[3].dependsOn = ["T2", "T2b"];
	const { todo, roster } = scaffold(input);
	const plan = buildExecutionPlan({ todo, roster });
	assert.deepEqual(plan.errors, []);
	assert.deepEqual(plan.layers.map((layer) => layer.map((task) => task.id)), [["T1"], ["T2", "T2b"], ["T3"]]);
	assert.ok(formatExecutionPlan(plan).includes("Layer 2: `T2`, `T2b` (parallel)"));
});

test("buildExecutionPlan applies phase scope and skips completed dependencies", () => {
	let { todo, roster } = scaffold();
	assert.ok(buildExecutionPlan({ todo, roster, phase: 2 }).errors.some((error) => error.includes("outside the selected scope")));
	todo = markDone(todo, "T1", "api-writer");
	const plan = buildExecutionPlan({ todo, roster, phase: "2" });
	assert.deepEqual(plan.errors, []);
	assert.deepEqual(plan.tasks.map((task) => task.id), ["T2"]);
	assert.deepEqual(plan.layers[0].map((task) => task.id), ["T2"]);
});

test("buildExecutionPlan resumes from a task and intersects --from with --phase", () => {
	let { todo, roster } = scaffold();
	assert.ok(buildExecutionPlan({ todo, roster, from: "T2" }).errors.some((error) => error.includes("unfinished dependencies")));
	todo = markDone(todo, "T1", "api-writer");
	const resumed = buildExecutionPlan({ todo, roster, from: "T2" });
	assert.deepEqual(resumed.errors, []);
	assert.deepEqual(resumed.tasks.map((task) => task.id), ["T2", "T3"]);
	const intersection = buildExecutionPlan({ todo, roster, from: "T1", phase: 2 });
	assert.deepEqual(intersection.errors, []);
	assert.deepEqual(intersection.tasks.map((task) => task.id), ["T2"]);
});

test("buildExecutionPlan reports unknown targets and completed scope", () => {
	let { todo, roster } = scaffold();
	assert.ok(buildExecutionPlan({ todo, roster, phase: 8 }).errors.some((error) => error.includes("Available phases")));
	assert.ok(buildExecutionPlan({ todo, roster, from: "T8" }).errors.some((error) => error.includes("Known task ids")));
	todo = markDone(markDone(markDone(todo, "T1", "api-writer"), "T2", "api-writer"), "T3", "api-reviewer");
	const plan = buildExecutionPlan({ todo, roster });
	assert.deepEqual(plan.errors, []);
	assert.equal(plan.tasks.length, 0);
	assert.equal(formatExecutionPlan(plan), "All tasks in the selected scope are already done.");
});

test("buildExecutionPlan rejects inconsistent status, roster, and dependency data", () => {
	const { todo, roster } = scaffold();
	assert.ok(
		buildExecutionPlan({ todo: todo.replace("| `T1` | `api-writer` | todo |", "| `T1` | `api-writer` | done |"), roster })
			.errors.some((error) => error.includes("completion state disagree")),
	);
	assert.ok(
		buildExecutionPlan({ todo, roster: roster.replace("### `api-reviewer`", "### `other-reviewer`") }).errors.some((error) =>
			error.includes("missing from ROSTER.md"),
		),
	);
	assert.ok(
		buildExecutionPlan({ todo: todo.replace("depends: `T1`", "depends: eventually"), roster }).errors.some((error) =>
			error.includes("malformed dependency list"),
		),
	);
	const cyclic = todo
		.replace("owner: `api-writer` · depends: none", "owner: `api-writer` · depends: `T3`")
		.replace("owner: `api-reviewer` · depends: `T2`", "owner: `api-reviewer` · depends: `T1`");
	assert.ok(buildExecutionPlan({ todo: cyclic, roster }).errors.some((error) => error.includes("Dependency cycle")));
});

test("buildExecutionPlan warns and uses checkbox state when a progress row is missing", () => {
	const { todo, roster } = scaffold();
	const withoutRow = todo
		.split("\n")
		.filter((line) => !line.startsWith("| `T1` |"))
		.join("\n");
	const plan = buildExecutionPlan({ todo: withoutRow, roster });
	assert.deepEqual(plan.errors, []);
	assert.ok(plan.warnings.some((warning) => warning.includes('Task "T1"')));
	assert.equal(plan.allTasks.find((task) => task.id === "T1").status, "todo");
	assert.equal(plan.tasks.length, 3);
});

test("buildExecutionPlan rejects unknown progress statuses", () => {
	const { todo, roster } = scaffold();
	const plan = buildExecutionPlan({ todo: todo.replace("| `T1` | `api-writer` | todo |", "| `T1` | `api-writer` | unknown |"), roster });
	assert.ok(plan.errors.some((error) => error.includes('unknown progress status "unknown"')));
});

test("extractGate only returns clearly identifiable single commands", () => {
	assert.equal(extractGate("npm test — route tests pass"), "npm test");
	assert.equal(extractGate("Run `pnpm test` and attach output"), "pnpm test");
	assert.equal(extractGate("./scripts/verify.sh — verification passes"), "./scripts/verify.sh");
	assert.equal(extractGate("npm test plus curl transcripts"), undefined);
	assert.equal(extractGate("Review report with verdict"), undefined);
	assert.equal(extractGate("npm test; rm -rf / — unsafe compound command"), undefined);
});
