import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url);

async function loadPackedCommands(piPath, packageRoot, cwd, environment) {
	const child = spawn(
		process.execPath,
		[piPath, "--mode", "rpc", "--no-session", "--offline", "--no-mcp", "--no-extensions", "-e", packageRoot],
		{ cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	let response;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const responsePromise = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for Pi RPC. stderr: ${stderr}`)), 20_000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			let newline;
			while ((newline = stdout.indexOf("\n")) !== -1) {
				const line = stdout.slice(0, newline).trim();
				stdout = stdout.slice(newline + 1);
				if (!line) continue;
				const record = JSON.parse(line);
				if (record.type === "response" && record.id === "commands") {
					clearTimeout(timer);
					if (record.success) resolve(record.data.commands);
					else reject(new Error(record.error || "Pi get_commands failed"));
				}
			}
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			if (!response) {
				clearTimeout(timer);
				reject(new Error(`Pi exited before answering (code ${code}). stderr: ${stderr}`));
			}
		});
	});

	try {
		child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
		response = await responsePromise;
		return response;
	} finally {
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) {
			let shutdownTimer;
			const exited = await Promise.race([
				once(child, "exit"),
				new Promise((resolve) => {
					shutdownTimer = setTimeout(resolve, 5_000);
				}),
			]);
			clearTimeout(shutdownTimer);
			if (!Array.isArray(exited) && child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await once(child, "exit");
			}
		}
		if (child.exitCode !== null && child.exitCode !== 0) {
			throw new Error(`Pi exited with code ${child.exitCode}. stderr: ${stderr}`);
		}
	}
}

test("packed package loads in Pi and generated agents parse and discover", { timeout: 60_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-frame-package-"));
	try {
		const packed = await exec("npm", ["pack", "--json", "--pack-destination", root], { cwd: repoRoot });
		const [packResult] = JSON.parse(packed.stdout);
		const tarball = join(root, packResult.filename);
		const installRoot = join(root, "install");
		await exec(
			"npm",
			["install", "--prefix", installRoot, "--ignore-scripts", "--omit=dev", "--offline", "--no-audit", "--no-fund", tarball],
			{ cwd: repoRoot },
		);
		const packageRoot = join(installRoot, "node_modules/pi-agent-frame");
		await readFile(join(packageRoot, "lib/execution-core.ts"), "utf8");
		await readFile(join(packageRoot, "CHANGELOG.md"), "utf8");

		const project = join(root, "project");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "package.json"), JSON.stringify({ name: "agent-frame-fixture", private: true }), "utf8");
		const { writeScaffold } = await jiti.import(join(packageRoot, "lib/scaffold-core.ts"));
		const written = await writeScaffold(
			{
				goal: "Verify the packed agent",
				framing: { summary: "Load and discover the generated role.", successCriteria: ["Discovery finds packed-writer"] },
				agents: [
					{
						name: "packed-writer",
						role: "Package verifier",
						description: "Verifies package output: YAML and discovery",
						access: "writer",
						systemPrompt: "Verify only the requested fixture.",
					},
				],
				tasks: [
					{
						id: "T1",
						title: "Add the fixture",
						owner: "packed-writer",
						acceptance: "The generated agent is discoverable",
						evidence: "npm test — package integration passes",
					},
				],
			},
			{ cwd: project, planDir: ".pi/frame/packed", agentsDir: ".pi/agents/packed", createdAt: "2026-01-15" },
		);
		assert.equal(written.ok, true);

		const agentPath = join(project, ".pi/agents/packed/packed-writer/AGENT.md");
		const agentText = await readFile(agentPath, "utf8");
		const frontmatter = agentText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		assert.ok(frontmatter);
		const metadata = parseYaml(frontmatter[1]);
		assert.equal(metadata.name, "packed-writer");
		assert.equal(metadata.description, "Verifies package output: YAML and discovery");
		assert.equal(metadata.acceptanceRole, "writer");
		assert.deepEqual(metadata.tools.split(",").map((tool) => tool.trim()), ["read", "grep", "find", "ls", "bash", "edit", "write"]);

		// pi-subagents does not export discovery publicly; this pinned development
		// version intentionally exercises the real internal discovery implementation.
		const subagentsEntry = import.meta.resolve("pi-subagents");
		const { discoverAgents } = await import(new URL("../src/agents/agents.js", subagentsEntry).href);
		const discovered = discoverAgents(project, "project", undefined, { globalNpmRoot: null, projectTrusted: true });
		assert.equal(discovered.agentDiagnostics?.length ?? 0, 0);
		const agent = discovered.agents.find((candidate) => candidate.name === "packed-writer");
		assert.ok(agent);
		assert.equal(agent.filePath, agentPath);
		assert.equal(agent.acceptanceRole, "writer");

		const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const piPath = join(dirname(piEntry), "bundle/cli.js");
		const commands = await loadPackedCommands(piPath, packageRoot, project, {
			...process.env,
			PI_CODING_AGENT_DIR: join(root, "pi-config"),
			PI_OFFLINE: "1",
		});
		assert.ok(commands.some((command) => command.name === "frame" && command.source === "extension"));
		assert.ok(commands.some((command) => command.name === "frame-run" && command.source === "extension"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
