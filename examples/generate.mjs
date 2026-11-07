/**
 * Regenerate the committed sample scaffold in examples/items-api/.
 *
 * Runs the real generator (lib/scaffold-core.ts) so the example is authentic
 * frame_scaffold output, not a hand-written imitation. Idempotent: re-run
 * after changing the renderers to refresh the sample.
 *
 * The TS module is loaded through jiti — the same loader pi uses at runtime.
 */

import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { writeScaffold } = await jiti.import("../lib/scaffold-core.ts");

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const plan = {
	goal: "Add a rate-limited public API for items: GET and POST /v2/items backed by the existing in-memory store, with a sliding-window rate limiter (100 requests/minute per IP), covered by tests.",
	title: "Items API",
	slug: "items-api",
	framing: {
		summary:
			"The service exposes no public read/write API for items. Add GET and POST /v2/items on the existing in-memory store, guarded by a sliding-window limiter of 100 requests per minute per IP, and prove the behavior with automated tests.",
		successCriteria: [
			"GET /v2/items returns 200 with the seeded fixture items",
			"POST /v2/items creates an item and returns 201",
			"The 101st request within one minute from one IP returns 429",
			"npm test passes",
		],
		constraints: ["Use the existing in-memory store; no new dependencies", "Keep the public API under /v2"],
		nonGoals: ["Authentication or per-user quotas", "Persistent storage"],
		risks: ["Sliding-window bookkeeping under concurrent requests", "Test flakiness from time-based assertions"],
		openQuestions: ["Should the 429 response include a Retry-After header?"],
	},
	agents: [
		{
			name: "api-implementer",
			role: "API implementer",
			description: "Implements the /v2/items routes and their rate limiting",
			responsibility: "Owns src/routes/items.js and src/middleware/rateLimit.js end to end, including their tests.",
			access: "writer",
			systemPrompt:
				"You implement HTTP API seams in this service. Work only in src/routes/, src/middleware/, and their test files.\n\nMethod: read the existing server first to match its conventions, write the smallest implementation that satisfies the acceptance criteria, then prove it with tests.\n\nQuality bar: tests must cover the happy path and the documented edge cases, and `npm test` must pass.\n\nReport what changed, the evidence, and any blockers. If a requirement is not covered by GOAL.md, stop and ask instead of guessing.",
		},
		{
			name: "limiter-reviewer",
			role: "Rate-limit reviewer",
			description: "Reviews the limiter implementation for correctness and abuse edge cases",
			responsibility: "Independently checks the rate limiter against the acceptance criteria; produces findings, never edits.",
			access: "read-only",
			tools: "read, grep, find, ls",
			systemPrompt:
				"You review rate-limiting behavior for correctness and abuse resistance. You are read-only: produce findings, not edits.\n\nMethod: recompute the limiter's behavior against the acceptance criteria, then hunt for window-boundary races, unbounded growth in the window store, and IP-spoofing assumptions.\n\nVerdict standard: every acceptance criterion either has evidence or is listed as a blocker. Report findings ordered by severity with a clear ok/blocked verdict.",
		},
		{
			name: "integration-verifier",
			role: "Integration verifier",
			description: "Verifies the finished API end to end against GOAL.md success criteria",
			responsibility: "Runs the test suite and exercises the live service; records transcripts as evidence.",
			access: "read-only",
			tools: "read, grep, find, ls, bash",
			systemPrompt:
				"You verify finished work end to end.\n\nMethod: run the test suite, then exercise the running service with curl and record a transcript for each success criterion in GOAL.md.\n\nBoundary: you may run commands and read files but never edit source. If verification fails, report the failing criterion, the observed output, and the likely owner — do not attempt fixes yourself.",
		},
	],
	tasks: [
		{
			id: "T1",
			title: "Map the existing server, store, and test seams",
			owner: "api-implementer",
			phase: "Recon",
			acceptance: "A short note names the server entry point, the store module, and the test command",
			evidence: "Recon note in the final report",
		},
		{
			id: "T2",
			title: "Implement GET and POST /v2/items",
			owner: "api-implementer",
			phase: "Implement",
			dependsOn: ["T1"],
			acceptance: "GET returns the seeded items with 200; POST creates an item and returns 201",
			evidence: "npm test — items route tests pass",
		},
		{
			id: "T3",
			title: "Add the sliding-window rate limiter",
			owner: "api-implementer",
			phase: "Implement",
			dependsOn: ["T2"],
			acceptance: "100 requests/minute per IP are allowed; the 101st returns 429",
			evidence: "npm test — limiter tests pass, including the window-boundary case",
		},
		{
			id: "T4",
			title: "Review limiter correctness and abuse edge cases",
			owner: "limiter-reviewer",
			phase: "Review",
			dependsOn: ["T3"],
			acceptance: "Every T3 acceptance criterion is checked with evidence, or listed as an explicit blocker",
			evidence: "Review report with verdict: ok or blocked",
		},
		{
			id: "T5",
			title: "Verify the API end to end",
			owner: "integration-verifier",
			phase: "Verify",
			dependsOn: ["T4"],
			acceptance: "All success criteria in GOAL.md are verified with command output",
			evidence: "npm test plus curl transcripts for the 200, 201, and 429 responses",
		},
	],
};

const result = await writeScaffold(plan, {
	cwd: repoRoot,
	planDir: "examples/items-api",
	agentsDir: "examples/items-api/agents",
	slug: plan.slug,
	title: plan.title,
	createdAt: "2026-01-15",
	overwrite: true,
});

if (!result.ok) {
	console.error("generate failed:\n" + result.errors.map((e) => `- ${e}`).join("\n"));
	process.exit(1);
}
for (const warning of result.warnings) console.warn(`warning: ${warning}`);
console.log(`wrote ${result.files.length} files:`);
for (const file of result.files) console.log(`  ${file.display}`);
