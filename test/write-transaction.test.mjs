import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { writeScaffold } = await jiti.import("../lib/scaffold-core.ts");

function plan(goal = "Transactional scaffold") {
	return {
		goal,
		framing: { summary: "Exercise atomic scaffold writes.", successCriteria: ["All targets remain consistent"] },
		agents: [
			{ name: "writer", description: "Writes the fixture", access: "writer", systemPrompt: "Write only the fixture." },
			{ name: "reviewer", description: "Reviews the fixture", systemPrompt: "Review only." },
		],
		tasks: [
			{ id: "T1", title: "Add fixture", owner: "writer", acceptance: "Fixture exists" },
			{ id: "T2", title: "Review fixture", owner: "reviewer", dependsOn: ["T1"], acceptance: "Review is recorded" },
		],
	};
}

function options(cwd, overwrite = false) {
	return { cwd, planDir: ".pi/frame/transaction", agentsDir: ".pi/agents/transaction", overwrite };
}

async function assertNoScaffold(cwd) {
	for (const path of [
		".pi/frame/transaction/GOAL.md",
		".pi/frame/transaction/ROSTER.md",
		".pi/frame/transaction/TODO.md",
		".pi/agents/transaction/writer/AGENT.md",
		".pi/agents/transaction/reviewer/AGENT.md",
	]) {
		await assert.rejects(readFile(join(cwd, path), "utf8"), { code: "ENOENT" });
	}
}

async function assertNoTemporaryFiles(cwd) {
	for (const directory of [
		".pi/frame/transaction",
		".pi/agents/transaction/writer",
		".pi/agents/transaction/reviewer",
	]) {
		const names = await readdir(join(cwd, directory));
		assert.deepEqual(names.filter((name) => name.includes(".agent-frame-")), []);
	}
}

test("a no-overwrite commit failure removes every file committed by that call", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-commit-failure-"));
	const originalLink = fs.link;
	let calls = 0;
	try {
		fs.link = async (...args) => {
			calls += 1;
			if (calls === 2) throw new Error("injected link failure");
			return originalLink(...args);
		};
		syncBuiltinESMExports();

		await assert.rejects(writeScaffold(plan(), options(cwd)), /injected link failure/);
		assert.equal(calls, 2);
		await assertNoScaffold(cwd);
		await assertNoTemporaryFiles(cwd);
	} finally {
		fs.link = originalLink;
		syncBuiltinESMExports();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("an overwrite commit failure restores original content and file modes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-overwrite-failure-"));
	const originalRename = fs.rename;
	try {
		const seeded = await writeScaffold(plan(), options(cwd));
		assert.equal(seeded.ok, true);
		const originals = new Map();
		for (const file of seeded.files) {
			originals.set(file.path, { content: await readFile(file.path), mode: (await fs.stat(file.path)).mode });
		}

		let calls = 0;
		fs.rename = async (...args) => {
			calls += 1;
			if (calls === 2) throw new Error("injected rename failure");
			return originalRename(...args);
		};
		syncBuiltinESMExports();

		await assert.rejects(writeScaffold(plan("Changed mission"), options(cwd, true)), /injected rename failure/);
		assert.equal(calls, 2);
		for (const [path, original] of originals) {
			assert.deepEqual(await readFile(path), original.content);
			assert.equal((await fs.stat(path)).mode, original.mode);
		}
		await assertNoTemporaryFiles(cwd);
	} finally {
		fs.rename = originalRename;
		syncBuiltinESMExports();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("concurrent no-overwrite writers produce exactly one complete scaffold", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-frame-concurrent-writers-"));
	try {
		const results = await Promise.allSettled([writeScaffold(plan(), options(cwd)), writeScaffold(plan(), options(cwd))]);
		const successes = results.filter((result) => result.status === "fulfilled" && result.value.ok);
		assert.equal(successes.length, 1);
		for (const result of results) {
			if (result.status === "fulfilled" && result.value.ok) continue;
			if (result.status === "fulfilled") assert.ok(result.value.errors[0].includes("Refusing to overwrite"));
			else assert.equal(result.reason.code, "EEXIST");
		}
		const todo = await readFile(join(cwd, ".pi/frame/transaction/TODO.md"), "utf8");
		assert.ok(todo.includes("Transactional scaffold"));
		await assertNoTemporaryFiles(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
