import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mapConcurrent, mapConcurrentSettled } = await jiti.import("../lib/concurrency.ts");

test("mapConcurrent preserves order and bounds active work", async () => {
	let active = 0;
	let maximum = 0;
	const result = await mapConcurrent(
		Array.from({ length: 30 }, (_, index) => index),
		async (value) => {
			active += 1;
			maximum = Math.max(maximum, active);
			await delay((value % 4) + 1);
			active -= 1;
			return value * 2;
		},
		3,
	);
	assert.deepEqual(result, Array.from({ length: 30 }, (_, index) => index * 2));
	assert.ok(maximum <= 3);
});

test("mapConcurrent waits for in-flight work before throwing", async () => {
	let finished = 0;
	await assert.rejects(
		mapConcurrent(
			[1, 2, 3, 4],
			async (value) => {
				await delay(value);
				finished += 1;
				if (value === 2) throw new Error("expected failure");
				return value;
			},
			2,
		),
		/expected failure/,
	);
	assert.equal(finished, 4);
});

test("mapConcurrentSettled handles empty input and invalid limits", async () => {
	assert.deepEqual(await mapConcurrentSettled([], async () => "unused"), []);
	const settled = await mapConcurrentSettled([1, 2], async (value) => value, 0);
	assert.deepEqual(
		settled.map((result) => result.value),
		[1, 2],
	);
});
