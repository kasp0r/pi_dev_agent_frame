import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Test-only bridge to pi-subagents' public in-process RPC. Loaded explicitly by
 * live-acceptance.mjs; never discovered by the generated fixture agents.
 */
export default function acceptanceObserver(pi: ExtensionAPI) {
	function request(method: string, params?: unknown): Promise<any> {
		return new Promise((resolve, reject) => {
			const requestId = randomUUID();
			const event = `subagents:rpc:v1:reply:${requestId}`;
			let unsubscribe: (() => void) | void;
			const timer = setTimeout(() => {
				unsubscribe?.();
				reject(new Error(`Timed out waiting for pi-subagents ${method}`));
			}, 10_000);
			unsubscribe = pi.events.on(event, (reply: any) => {
				clearTimeout(timer);
				unsubscribe?.();
				if (reply.success) resolve(reply.data);
				else reject(new Error(reply.error?.message || `pi-subagents ${method} failed`));
			});
			pi.events.emit("subagents:rpc:v1:request", {
				version: 1,
				requestId,
				method,
				params,
			});
		});
	}

	async function status() {
		return request("status");
	}

	async function writeStatus(value: unknown) {
		const path = process.env.PI_AGENT_FRAME_STATUS_FILE;
		if (!path) throw new Error("PI_AGENT_FRAME_STATUS_FILE is required by the acceptance observer");
		await writeFile(path, JSON.stringify(value, null, 2), "utf8");
	}

	pi.registerCommand("acceptance-subagent-status", {
		description: "Test-only pi-subagents status snapshot",
		handler: async (_args, ctx) => {
			const value = await status();
			await writeStatus(value);
			ctx.ui.notify("Acceptance subagent status recorded", "info");
		},
	});

	pi.registerCommand("acceptance-stop-subagents", {
		description: "Test-only cleanup of active pi-subagents runs",
		handler: async (_args, ctx) => {
			const snapshot = await status();
			const active = (snapshot.asyncSnapshot?.runs ?? []).filter((run: any) =>
				["queued", "running", "paused"].includes(run.state),
			);
			const stopped: string[] = [];
			for (const run of active) {
				await request("stop", { id: run.id });
				stopped.push(run.id);
			}
			const deadline = Date.now() + 10_000;
			let remaining = await status();
			while (
				(remaining.asyncSnapshot?.runs ?? []).some((run: any) => ["queued", "running", "paused"].includes(run.state)) &&
				Date.now() < deadline
			) {
				await delay(100);
				remaining = await status();
			}
			const stillActive = (remaining.asyncSnapshot?.runs ?? []).filter((run: any) =>
				["queued", "running", "paused"].includes(run.state),
			);
			if (stillActive.length > 0) throw new Error("Some acceptance subagents did not stop before the deadline");
			await writeStatus({ stopped, remaining });
			ctx.ui.notify(`Acceptance stopped ${stopped.length} active run(s)`, "info");
		},
	});
}
