import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { startPiRpc } from "./pi-rpc-client.mjs";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url);

const GOAL =
	"Create a tiny two-phase fixture with exactly one writer agent and exactly two tasks. T1 is in phase Prepare and writes phase-one.txt containing exactly `phase one\\n`. T2 is in phase Implement, depends on T1, and writes answer.txt containing exactly `frame acceptance\\n`. Use access writer, objective acceptance criteria, and artifact-path evidence. Framing itself must not create either artifact.";

export function parseAcceptanceArgs(argv) {
	const options = { execute: false, keep: false, help: false, model: undefined, extensions: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--execute") options.execute = true;
		else if (argument === "--keep") options.keep = true;
		else if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--model") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error("--model requires a value");
			options.model = value;
			index += 1;
		} else if (argument.startsWith("--model=")) {
			options.model = argument.slice("--model=".length);
			if (!options.model) throw new Error("--model requires a value");
		} else if (argument === "--extension") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error("--extension requires a path");
			index += 1;
			options.extensions.push(value);
		} else if (argument.startsWith("--extension=")) {
			const value = argument.slice("--extension=".length);
			if (!value) throw new Error("--extension requires a path");
			options.extensions.push(value);
		} else throw new Error(`Unknown argument "${argument}"`);
	}
	return options;
}

export function readProgress(todo) {
	return [...todo.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| (todo|in-progress|blocked|review|done) \| (.*) \|$/gm)].map(
		(match) => ({ id: match[1], owner: match[2], status: match[3], evidence: match[4] }),
	);
}

export function taskLaunchCount(client) {
	return client.toolStarts.filter(
		(event) =>
			event.toolName === "subagent" &&
			!["list", "status", "cost", "doctor"].includes(event.args?.action) &&
			Boolean(event.args?.agent || event.args?.workflow || event.args?.workflowScript || event.args?.script),
	).length;
}

export function assistantText(messages) {
	return messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text),
		)
		.join("\n");
}

async function packAndInstall(root) {
	const packed = await exec("npm", ["pack", "--json", "--pack-destination", root], { cwd: repoRoot });
	const [packResult] = JSON.parse(packed.stdout);
	const installRoot = join(root, "install");
	await exec(
		"npm",
		[
			"install",
			"--prefix",
			installRoot,
			"--ignore-scripts",
			"--omit=dev",
			"--offline",
			"--no-audit",
			"--no-fund",
			join(root, packResult.filename),
		],
		{ cwd: repoRoot },
	);
	return join(installRoot, "node_modules/pi-agent-frame");
}

async function assertMissing(path) {
	await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
}

export async function waitForPlan(client, todoPath, predicate, timeoutMs, description) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// Capture before reading so a completion after a stale read is still seen.
		const since = client.sequence;
		const todo = await readFile(todoPath, "utf8");
		const progress = readProgress(todo);
		if (progress.length === 0) throw new Error("No task progress rows found in TODO.md");
		if (predicate(progress, todo)) return { todo, progress };
		const blocked = progress.find((task) => task.status === "blocked");
		if (blocked) throw new Error(`Task ${blocked.id} was blocked: ${blocked.evidence}`);
		await client.waitForEvent((event) => event.type === "agent_settled", {
			since,
			timeoutMs: Math.max(1, deadline - Date.now()),
			description,
		});
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function assertFramedFixture(project) {
	const planDir = join(project, ".pi/frame/frame-acceptance");
	const [goal, roster, todo] = await Promise.all([
		readFile(join(planDir, "GOAL.md"), "utf8"),
		readFile(join(planDir, "ROSTER.md"), "utf8"),
		readFile(join(planDir, "TODO.md"), "utf8"),
	]);
	assert.ok(goal.includes("tiny two-phase fixture"));
	const { buildExecutionPlan, parseRosterAgents } = await jiti.import("../lib/execution-core.ts");
	assert.equal(parseRosterAgents(roster).length, 1);
	const execution = buildExecutionPlan({ todo, roster });
	assert.deepEqual(execution.errors, []);
	assert.deepEqual(execution.allTasks.map((task) => task.id), ["T1", "T2"]);
	assert.deepEqual(execution.phases.map((phase) => phase.label), ["Prepare", "Implement"]);
	assert.equal(execution.layers.length, 2);
	const agentRoot = join(project, ".pi/agents/frame-acceptance");
	assert.equal((await readdir(agentRoot)).length, 1);
	assert.equal(readProgress(todo).length, 2);
	return { planDir, roster, todo };
}

async function saveDiagnostics(root, client, failure) {
	if (!client) return;
	if (failure) {
		try {
			const messages = await client.messages();
			await writeFile(join(root, "messages.json"), JSON.stringify(messages, null, 2), "utf8");
		} catch {
			// The event log and stderr below remain available if Pi is unresponsive.
		}
	}
	const events = client.events.map(({ sequence, ...event }) => ({ sequence, ...event }));
	await writeFile(join(root, "rpc-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
	await writeFile(join(root, "ui-notifications.json"), JSON.stringify(client.notifications, null, 2), "utf8");
	await writeFile(join(root, "pi-stderr.log"), client.stderr, "utf8");
}

function activeRuns(status) {
	return (status.asyncSnapshot?.runs ?? []).filter((run) => ["queued", "running", "paused"].includes(run.state));
}

async function subagentStatus(client, statusPath) {
	await client.promptAndWait("/acceptance-subagent-status", { expectRun: false });
	return JSON.parse(await readFile(statusPath, "utf8"));
}

async function assertNoActiveSubagents(client, statusPath) {
	const status = await subagentStatus(client, statusPath);
	assert.equal(status.fleet?.totalActive ?? 0, 0);
	assert.deepEqual(activeRuns(status), []);
}

async function stopActiveSubagents(client) {
	await client.promptAndWait("/acceptance-stop-subagents", { expectRun: false });
}

async function run(options) {
	const timeoutEnv = Number(process.env.PI_AGENT_FRAME_ACCEPTANCE_TIMEOUT_MS ?? 240_000);
	if (!Number.isInteger(timeoutEnv) || timeoutEnv < 1) {
		throw new Error("PI_AGENT_FRAME_ACCEPTANCE_TIMEOUT_MS must be a positive integer");
	}
	const root = await mkdtemp(join(tmpdir(), "agent-frame-live-"));
	const project = join(root, "project");
	const statusPath = join(root, "subagent-status.json");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "package.json"), JSON.stringify({ name: "frame-live-fixture", private: true }), "utf8");
	let client;
	let failure;
	try {
		const packageRoot = await packAndInstall(root);
		const subagentsEntry = fileURLToPath(import.meta.resolve("pi-subagents"));
		const observerPath = fileURLToPath(new URL("../test/fixtures/acceptance-observer.ts", import.meta.url));
		client = startPiRpc({
			cwd: project,
			environment: {
				...process.env,
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				PI_AGENT_FRAME_STATUS_FILE: statusPath,
			},
			extensionPaths: [
				packageRoot,
				subagentsEntry,
				observerPath,
				...options.extensions.map((path) => resolve(process.cwd(), path)),
			],
			model: options.model ?? process.env.PI_AGENT_FRAME_ACCEPTANCE_MODEL,
		});
		const commands = (await client.request("get_commands")).commands;
		assert.ok(commands.some((command) => command.name === "frame"));
		assert.ok(commands.some((command) => command.name === "frame-run"));

		console.log("[acceptance] Framing fixture with the configured live model…");
		await client.promptAndWait(`/frame --name frame-acceptance ${GOAL}`, { timeoutMs: timeoutEnv });
		const framed = await assertFramedFixture(project);
		assert.ok(
			client.events.some(
				(event) =>
					event.type === "tool_execution_end" &&
					event.toolName === "frame_scaffold" &&
					!event.isError &&
					event.result?.details?.ok,
			),
			"frame_scaffold did not report success",
		);
		await assertMissing(join(project, "phase-one.txt"));
		await assertMissing(join(project, "answer.txt"));

		const launchesBeforeValidation = taskLaunchCount(client);
		const invalid = await client.promptAndWait("/frame-run frame-acceptance --phase 99", {
			expectRun: false,
			timeoutMs: timeoutEnv,
		});
		assert.equal(invalid.disposition, "handled");
		assert.ok(client.notifications.some((notification) => notification.message?.includes("Unknown phase 99")));
		assert.equal(taskLaunchCount(client), launchesBeforeValidation);

		console.log("[acceptance] Checking deterministic dry-run…");
		const launchesBeforeDryRun = taskLaunchCount(client);
		const messageCountBeforeDryRun = (await client.messages()).length;
		const toolStartsBeforeDryRun = client.toolStarts.length;
		await client.promptAndWait("/frame-run frame-acceptance --dry-run", { timeoutMs: timeoutEnv });
		assert.equal(await readFile(join(framed.planDir, "TODO.md"), "utf8"), framed.todo);
		assert.equal(taskLaunchCount(client), launchesBeforeDryRun);
		assert.ok(
			client.toolStarts
				.slice(toolStartsBeforeDryRun)
				.some((event) => event.toolName === "subagent" && event.args?.action === "list"),
			"Dry-run did not perform runtime agent discovery",
		);
		const dryRunText = assistantText((await client.messages()).slice(messageCountBeforeDryRun));
		assert.ok(dryRunText.includes("T1") && dryRunText.includes("T2"), "Dry-run omitted fixture tasks");
		assert.ok(/Layer|layer/.test(dryRunText), "Dry-run omitted launch layers");
		assert.ok(dryRunText.includes("without `--dry-run`"), "Dry-run omitted the execution handoff");
		await assertNoActiveSubagents(client, statusPath);
		await assertMissing(join(project, "phase-one.txt"));
		await assertMissing(join(project, "answer.txt"));

		if (options.execute) {
			console.log("[acceptance] Executing phase 1, then stopping at the phase boundary…");
			await client.promptAndWait("/frame-run frame-acceptance --phase 1", { timeoutMs: timeoutEnv });
			await waitForPlan(
				client,
				join(framed.planDir, "TODO.md"),
				(progress) =>
					progress.find((task) => task.id === "T1")?.status === "done" &&
					progress.find((task) => task.id === "T2")?.status === "todo",
				timeoutEnv,
				"phase 1 completion",
			);
			assert.equal(await readFile(join(project, "phase-one.txt"), "utf8"), "phase one\n");
			await assertNoActiveSubagents(client, statusPath);
			await assertMissing(join(project, "answer.txt"));

			console.log("[acceptance] Resuming the remaining task…");
			await client.promptAndWait("/frame-run frame-acceptance", { timeoutMs: timeoutEnv });
			const completed = await waitForPlan(
				client,
				join(framed.planDir, "TODO.md"),
				(progress) => progress.length === 2 && progress.every((task) => task.status === "done"),
				timeoutEnv,
				"all tasks to complete",
			);
			assert.ok(completed.progress.every((task) => task.evidence !== "—"));
			assert.equal(await readFile(join(project, "answer.txt"), "utf8"), "frame acceptance\n");
			await assertNoActiveSubagents(client, statusPath);

			console.log("[acceptance] Checking idempotent rerun and second-plan isolation…");
			const launchesBeforeRerun = taskLaunchCount(client);
			await client.promptAndWait("/frame-run frame-acceptance", { expectRun: false, timeoutMs: timeoutEnv });
			assert.equal(taskLaunchCount(client), launchesBeforeRerun);
			assert.ok(client.notifications.some((notification) => notification.message?.includes("already done")));
			await client.promptAndWait(
				"/frame --name second-acceptance Create a second one-task writer plan for second.txt; do not execute it.",
				{ timeoutMs: timeoutEnv },
			);
			assert.ok((await readFile(join(project, ".pi/frame/second-acceptance/GOAL.md"), "utf8")).includes("second.txt"));
			assert.ok((await readdir(join(project, ".pi/agents/second-acceptance"))).length > 0);
			await assertMissing(join(project, "second.txt"));
		}
		assert.deepEqual(client.extensionErrors, []);
		console.log(`[acceptance] PASS${options.execute ? " (framing, dry-run, execute, resume, rerun, second plan)" : " (framing and dry-run)"}`);
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		let cleanupFailure;
		if (failure && client) {
			try {
				await client.request("abort");
			} catch (error) {
				cleanupFailure ??= error;
			}
			try {
				await stopActiveSubagents(client);
			} catch (error) {
				cleanupFailure ??= error;
			}
		}
		try {
			await saveDiagnostics(root, client, failure);
		} catch (error) {
			cleanupFailure ??= error;
		}
		try {
			if (client) await client.close();
		} catch (error) {
			cleanupFailure ??= error;
		}
		if (failure || cleanupFailure || options.keep) console.log(`[acceptance] Artifacts: ${root}`);
		else await rm(root, { recursive: true, force: true });
		if (cleanupFailure && !failure) throw cleanupFailure;
	}
}

function printHelp() {
	console.log(`Live pi-agent-frame acceptance test

Usage: npm run test:acceptance -- [options]

Frames a real fixture with the configured model, validates discovery, checks
invalid scope, and exercises dry-run. This mode makes model calls and may incur
provider charges, but never launches task agents.

Options:
  --execute       Also execute phase 1, resume phase 2, rerun a completed plan,
                  and frame a second plan. Launches real agents in a temp cwd.
  --model <id>    Provider model override (or PI_AGENT_FRAME_ACCEPTANCE_MODEL).
  --extension <path>
                  Explicit provider extension; repeat for multiple extensions.
                  Required for custom providers when ambient discovery is off.
  --keep          Keep the temporary project and RPC diagnostics on success.
  -h, --help      Show this help without starting Pi or making model calls.

PI_AGENT_FRAME_ACCEPTANCE_TIMEOUT_MS bounds each live stage (default 240000).
Failures always preserve the temporary project and diagnostics.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try {
		const options = parseAcceptanceArgs(process.argv.slice(2));
		if (options.help) printHelp();
		else await run(options);
	} catch (error) {
		console.error(`[acceptance] FAIL: ${error instanceof Error ? error.stack : String(error)}`);
		process.exitCode = 1;
	}
}
