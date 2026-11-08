import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Start a Pi RPC process with explicit extensions and no ambient discovery. */
export function startPiRpc({ cwd, environment, extensionPaths, model }) {
	const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const piPath = join(dirname(piEntry), "bundle/cli.js");
	const args = [piPath, "--mode", "rpc", "--no-session", "--offline", "--no-mcp", "--no-extensions", "--approve"];
	if (model) args.push("--model", model);
	for (const path of extensionPaths) args.push("-e", path);
	const child = spawn(process.execPath, args, {
		cwd,
		env: environment,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return new PiRpcClient(child);
}

/** Minimal JSONL RPC client with event-history waits and bounded cleanup. */
export class PiRpcClient {
	constructor(child, { requestTimeoutMs = 30_000 } = {}) {
		this.child = child;
		this.requestTimeoutMs = requestTimeoutMs;
		this.pending = new Map();
		this.waiters = new Set();
		this.events = [];
		this.notifications = [];
		this.toolStarts = [];
		this.extensionErrors = [];
		this.sequence = 0;
		this.stdout = "";
		this.stderr = "";
		this.closePromise = undefined;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
		});
		child.once("error", (error) => this.#fail(error));
		child.once("exit", (code, signal) => {
			const error = new Error(`Pi exited (code ${code}, signal ${signal}). stderr: ${this.stderr}`);
			this.#fail(error);
		});
	}

	#onStdout(chunk) {
		this.stdout += chunk;
		let newline;
		while ((newline = this.stdout.indexOf("\n")) !== -1) {
			const line = this.stdout.slice(0, newline).trim();
			this.stdout = this.stdout.slice(newline + 1);
			if (!line) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch (error) {
				this.#fail(new Error(`Invalid Pi JSONL record: ${line}`, { cause: error }));
				continue;
			}
			if (record.type === "response") {
				const pending = this.pending.get(record.id);
				if (!pending) continue;
				this.pending.delete(record.id);
				clearTimeout(pending.timer);
				if (record.success) pending.resolve(record.data);
				else pending.reject(new Error(record.error || `Pi command ${record.command} failed`));
				continue;
			}
			if (record.type === "extension_ui_request") {
				if (record.method === "notify") this.notifications.push(record);
				else {
					// The acceptance flow is inline and should never open a dialog. Cancel
					// unexpected dialogs explicitly rather than leaving Pi blocked.
					this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
				}
				continue;
			}
			this.sequence += 1;
			this.events.push({ sequence: this.sequence, ...record });
			if (record.type === "tool_execution_start") this.toolStarts.push(record);
			if (record.type === "extension_error") this.extensionErrors.push(record);
			for (const waiter of [...this.waiters]) {
				if (this.waiters.has(waiter)) waiter.test();
			}
		}
	}

	#fail(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}

	request(type, payload = {}, timeoutMs = this.requestTimeoutMs) {
		if (this.child.exitCode !== null || this.child.signalCode !== null) {
			return Promise.reject(new Error(`Cannot send ${type}: Pi has exited. stderr: ${this.stderr}`));
		}
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for Pi ${type} response. stderr: ${this.stderr}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
		});
	}

	waitForEvent(predicate, { since = 0, timeoutMs = 30_000, description = "event" } = {}) {
		return new Promise((resolve, reject) => {
			const waiter = {
				timer: undefined,
				reject,
				test: () => {
					const found = this.events.findLast((event) => event.sequence > since && predicate(event));
					if (!found) return;
					clearTimeout(waiter.timer);
					this.waiters.delete(waiter);
					resolve(found);
				},
			};
			waiter.timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`Timed out waiting for ${description}. stderr: ${this.stderr}`));
			}, timeoutMs);
			this.waiters.add(waiter);
			waiter.test();
		});
	}

	/** Send a prompt and wait for its complete session-level run when expected. */
	async promptAndWait(message, { expectRun = true, timeoutMs = 120_000 } = {}) {
		const since = this.sequence;
		const result = await this.request("prompt", { message }, Math.min(timeoutMs, this.requestTimeoutMs));
		if (result.disposition === "queued") throw new Error("Prompt was unexpectedly queued; wait for idle before acceptance steps.");
		const shouldWait = result.disposition === "started" || (expectRun && result.disposition === "handled");
		if (!shouldWait) return result;
		if (expectRun) {
			const started = await this.waitForEvent(
				(event) => event.type === "agent_start" || event.type === "extension_error",
				{
					since,
					timeoutMs,
					description: `agent start after ${message}`,
				},
			);
			if (started.type === "extension_error") {
				throw new Error(`Pi ${started.event} failed: ${started.error}`);
			}
		}
		const settled = await this.waitForEvent(
			(event) => event.type === "agent_settled" || event.type === "extension_error",
			{
				since,
				timeoutMs,
				description: `agent completion after ${message}`,
			},
		);
		if (settled.type === "extension_error") throw new Error(`Pi ${settled.event} failed: ${settled.error}`);
		return result;
	}

	async messages() {
		return (await this.request("get_messages")).messages;
	}

	async state() {
		return this.request("get_state");
	}

	async close() {
		if (this.closePromise) return this.closePromise;
		this.closePromise = (async () => {
			if (this.child.exitCode !== null || this.child.signalCode !== null) return;
			this.child.stdin.end();
			let timer;
			const exited = await Promise.race([
				once(this.child, "exit"),
				new Promise((resolve) => {
					timer = setTimeout(resolve, 5_000);
				}),
			]);
			clearTimeout(timer);
			if (!Array.isArray(exited) && this.child.exitCode === null && this.child.signalCode === null) {
				this.child.kill("SIGTERM");
				await once(this.child, "exit");
			}
			if (this.child.exitCode !== null && this.child.exitCode !== 0) {
				throw new Error(`Pi exited with code ${this.child.exitCode}. stderr: ${this.stderr}`);
			}
		})();
		return this.closePromise;
	}
}
