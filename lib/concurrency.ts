/** Dependency-free bounded concurrency helpers for independent filesystem work. */

const DEFAULT_CONCURRENCY = 16;

function workerCount(length: number, concurrency: number): number {
	if (length === 0) return 0;
	const normalized = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : DEFAULT_CONCURRENCY;
	return Math.min(length, normalized);
}

/** Map in input order, wait for every operation, then return or throw the first error. */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	mapper: (item: T, index: number) => Promise<R>,
	concurrency = DEFAULT_CONCURRENCY,
): Promise<R[]> {
	const outcomes = await mapConcurrentSettled(items, mapper, concurrency);
	const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failure) throw failure.reason;
	return outcomes.map((result) => (result as PromiseFulfilledResult<R>).value);
}

/** Settled variant for staging/cleanup paths that must not leave operations running. */
export async function mapConcurrentSettled<T, R>(
	items: readonly T[],
	mapper: (item: T, index: number) => Promise<R>,
	concurrency = DEFAULT_CONCURRENCY,
): Promise<PromiseSettledResult<R>[]> {
	const outcomes = new Array<PromiseSettledResult<R>>(items.length);
	let next = 0;
	const workers = Array.from({ length: workerCount(items.length, concurrency) }, async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			try {
				outcomes[index] = { status: "fulfilled", value: await mapper(items[index], index) };
			} catch (reason) {
				outcomes[index] = { status: "rejected", reason };
			}
		}
	});
	await Promise.all(workers);
	return outcomes;
}
