import { afterEach, describe, expect, it, vi } from "vitest";

import { startExpiryWorker } from "../src/expiry-worker.js";
import type { CatchRepository } from "../src/storage/catch-repository.js";

describe("CATCH expiry worker", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("runs immediately, repeats in bounded batches, and stops cleanly", async () => {
		vi.useFakeTimers();
		const expireDueResources = vi.fn<() => Promise<number>>().mockResolvedValue(0);
		const worker = startExpiryWorker({ expireDueResources } as unknown as CatchRepository, {
			intervalMs: 1_000,
			batchSize: 25,
		});

		await vi.waitFor(() => expect(expireDueResources).toHaveBeenCalledWith(25));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(expireDueResources).toHaveBeenCalledTimes(2);

		await worker.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(expireDueResources).toHaveBeenCalledTimes(2);
	});

	it("reports failures without stopping later cleanup attempts", async () => {
		vi.useFakeTimers();
		const error = new Error("database unavailable");
		const onError = vi.fn();
		const expireDueResources = vi.fn<() => Promise<number>>()
			.mockRejectedValueOnce(error)
			.mockResolvedValue(0);
		const worker = startExpiryWorker({ expireDueResources } as unknown as CatchRepository, {
			intervalMs: 1_000,
			onError,
		});

		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(expireDueResources).toHaveBeenCalledTimes(2);
		await worker.stop();
	});
});
