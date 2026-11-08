import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { PiRpcClient } from "../scripts/pi-rpc-client.mjs";
import { parseAcceptanceArgs, readProgress, taskLaunchCount, assistantText, waitForPlan } from "../scripts/live-acceptance.mjs";

const exec = promisify(execFile);
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));

function fakeClient(t, options = {}) {
	const child = spawn(process.execPath, [fakePi], { stdio: ["pipe", "pipe", "pipe"] });
	const client = new PiRpcClient(child, { requestTimeoutMs: 500, ...options });
	t.after(() => client.close());
	return client;
}

test("PiRpcClient correlates requests and reads state/messages", async (t) => {
	const client = fakeClient(t);
	assert.equal((await client.state()).isStreaming, false);
	assert.equal((await client.messages())[0].role, "assistant");
});

test("promptAndWait waits for a normal started run", async (t) => {
	const client = fakeClient(t);
	const result = await client.promptAndWait("/run");
	assert.equal(result.disposition, "started");
	assert.deepEqual(
		client.events.map((event) => event.type),
		["agent_start", "agent_settled"],
	);
});

test("promptAndWait observes events emitted before a handled response", async (t) => {
	const client = fakeClient(t);
	const result = await client.promptAndWait("/handled-event-first");
	assert.equal(result.disposition, "handled");
	assert.equal(client.events.filter((event) => event.type === "agent_settled").length, 1);
});

test("promptAndWait supports handled no-op commands and bounds missing runs", async (t) => {
	const client = fakeClient(t);
	const result = await client.promptAndWait("/handled-noop", { expectRun: false });
	assert.equal(result.disposition, "handled");
	await assert.rejects(client.promptAndWait("/handled-noop", { timeoutMs: 50 }), /Timed out waiting for agent start/);
});

test("PiRpcClient surfaces command failures and captures notifications", async (t) => {
	const client = fakeClient(t);
	await assert.rejects(client.promptAndWait("/failure"), /injected prompt failure/);
	await client.promptAndWait("/notify-run");
	assert.ok(client.notifications.some((notification) => notification.message === "fake notice"));
});

test("promptAndWait surfaces extension errors without waiting for timeout", async (t) => {
	const client = fakeClient(t);
	await assert.rejects(client.promptAndWait("/extension-error", { timeoutMs: 5_000 }), /No API key found/);
});

test("acceptance arguments are explicit and reject unknown flags", () => {
	assert.deepEqual(parseAcceptanceArgs([]), { execute: false, keep: false, help: false, model: undefined, extensions: [] });
	assert.deepEqual(parseAcceptanceArgs(["--execute", "--keep", "--model=provider/model"]), {
		execute: true,
		keep: true,
		help: false,
		model: "provider/model",
		extensions: [],
	});
	assert.equal(parseAcceptanceArgs(["--model", "demo/model"]).model, "demo/model");
	assert.deepEqual(parseAcceptanceArgs(["--extension", "./provider.ts", "--extension=./other.ts"]).extensions, [
		"./provider.ts",
		"./other.ts",
	]);
	assert.throws(() => parseAcceptanceArgs(["--extension"]), /requires a path/);
	assert.throws(() => parseAcceptanceArgs(["--extension", "--execute"]), /requires a path/);
	assert.throws(() => parseAcceptanceArgs(["--model"]), /requires a value/);
	assert.throws(() => parseAcceptanceArgs(["--model", "--execute"]), /requires a value/);
	assert.throws(() => parseAcceptanceArgs(["--unknown"]), /Unknown argument/);
});

test("acceptance progress parsing reads status and evidence", () => {
	const rows = readProgress(`| Task | Owner | Status | Evidence / link |
| --- | --- | --- | --- |
| \`T1\` | \`writer\` | done | phase-one.txt |
| \`T2\` | \`writer\` | todo | — |`);
	assert.deepEqual(rows, [
		{ id: "T1", owner: "writer", status: "done", evidence: "phase-one.txt" },
		{ id: "T2", owner: "writer", status: "todo", evidence: "—" },
	]);
});

test("waitForPlan cannot miss a completion after a stale plan read", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-frame-wait-race-"));
	const todoPath = join(root, "TODO.md");
	const row = (status) => `| Task | Owner | Status | Evidence / link |\n| \`T1\` | \`writer\` | ${status} | answer.txt |\n`;
	await writeFile(todoPath, row("todo"), "utf8");
	let sequence = 0;
	let accesses = 0;
	const client = {
		get sequence() {
			// Simulate completion between the old implementation's read and cursor
			// capture. Capturing the cursor first observes the completed file.
			if (accesses === 0) {
				writeFileSync(todoPath, row("done"), "utf8");
				sequence += 1;
			}
			accesses += 1;
			return sequence;
		},
		waitForEvent() {
			return Promise.reject(new Error("completion event was missed"));
		},
	};
	try {
		const result = await waitForPlan(client, todoPath, (progress) => progress[0]?.status === "done", 1_000, "race check");
		assert.equal(result.progress[0].status, "done");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("acceptance launch counting permits read-only subagent discovery", () => {
	assert.equal(
		taskLaunchCount({
			toolStarts: [
				{ toolName: "subagent", args: { action: "list" } },
				{ toolName: "subagent", args: { action: "status" } },
				{ toolName: "subagent", args: { workflowScript: "return runs.all([])" } },
				{ toolName: "subagent", args: { agent: "writer", task: "Work" } },
				{ toolName: "bash", args: { command: "echo not-a-subagent" } },
			],
		}),
		2,
	);
});

test("acceptance assistant text extracts only text response content", () => {
	assert.equal(
		assistantText([
			{ role: "user", content: "ignored" },
			{ role: "assistant", content: [{ type: "text", text: "Layer 1" }, { type: "toolCall", toolName: "subagent" }] },
			{ role: "assistant", content: "Done" },
		]),
		"Layer 1\nDone",
	);
});

test("live acceptance --help exits without starting Pi or making model calls", async () => {
	const script = fileURLToPath(new URL("../scripts/live-acceptance.mjs", import.meta.url));
	const { stdout } = await exec(process.execPath, [script, "--help"], { timeout: 5_000 });
	assert.ok(stdout.includes("Usage: npm run test:acceptance"));
	assert.ok(stdout.includes("never launches task agents"));
});
