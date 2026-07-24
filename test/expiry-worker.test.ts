import { afterEach, describe, expect, it, vi } from "vitest";

import { startExpiryWorker } from "../src/expiry-worker.js";

describe("expiry worker", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("runs immediately, repeats in bounded batches, and stops cleanly", async () => {
		vi.useFakeTimers();
		const expireDue = vi.fn<() => Promise<number>>().mockResolvedValue(0);
		const worker = startExpiryWorker([{ name: "CATCH", expireDue }], {
			intervalMs: 1_000,
			batchSize: 25,
		});

		await vi.waitFor(() => expect(expireDue).toHaveBeenCalledWith(25));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(expireDue).toHaveBeenCalledTimes(2);

		await worker.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(expireDue).toHaveBeenCalledTimes(2);
	});

	it("reports failures without stopping later cleanup attempts", async () => {
		vi.useFakeTimers();
		const error = new Error("database unavailable");
		const onError = vi.fn();
		const expireDue = vi.fn<() => Promise<number>>()
			.mockRejectedValueOnce(error)
			.mockResolvedValue(0);
		const worker = startExpiryWorker([{ name: "CATCH", expireDue }], {
			intervalMs: 1_000,
			onError,
		});

		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("CATCH", error));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(expireDue).toHaveBeenCalledTimes(2);
		await worker.stop();
	});

	it("isolates a failing product while other cleanup jobs still run", async () => {
		vi.useFakeTimers();
		const error = new Error("whisper unavailable");
		const onError = vi.fn();
		const failing = vi.fn<() => Promise<number>>().mockRejectedValue(error);
		const healthy = vi.fn<() => Promise<number>>().mockResolvedValue(0);
		const worker = startExpiryWorker([
			{ name: "WHISPER", expireDue: failing },
			{ name: "PULSE", expireDue: healthy },
		], { intervalMs: 60_000, onError });

		await vi.waitFor(() => {
			expect(onError).toHaveBeenCalledWith("WHISPER", error);
			expect(healthy).toHaveBeenCalledOnce();
		});
		await worker.stop();
	});

	it("drains every full due batch immediately before sleeping", async () => {
		vi.useFakeTimers();
		const expireDue = vi.fn<() => Promise<number>>()
			.mockResolvedValueOnce(25)
			.mockResolvedValueOnce(25)
			.mockResolvedValueOnce(7)
			.mockResolvedValue(0);
		const worker = startExpiryWorker([{ name: "CATCH", expireDue }], {
			intervalMs: 60_000,
			batchSize: 25,
		});

		await vi.waitFor(() => expect(expireDue).toHaveBeenCalledTimes(3));
		expect(expireDue).toHaveBeenNthCalledWith(1, 25);
		expect(expireDue).toHaveBeenNthCalledWith(2, 25);
		expect(expireDue).toHaveBeenNthCalledWith(3, 25);
		await worker.stop();
	});

	it("drains independent product jobs in the same supervised cycle", async () => {
		vi.useFakeTimers();
		const catchExpiry = vi.fn<() => Promise<number>>().mockResolvedValue(0);
		const whisperExpiry = vi.fn<() => Promise<number>>().mockResolvedValue(0);
		const pulseExpiry = vi.fn<() => Promise<number>>().mockResolvedValue(0);
		const worker = startExpiryWorker([
			{ name: "CATCH", expireDue: catchExpiry },
			{ name: "WHISPER", expireDue: whisperExpiry },
			{ name: "PULSE", expireDue: pulseExpiry },
		], { intervalMs: 60_000, batchSize: 10 });

		await vi.waitFor(() => {
			expect(catchExpiry).toHaveBeenCalledWith(10);
			expect(whisperExpiry).toHaveBeenCalledWith(10);
			expect(pulseExpiry).toHaveBeenCalledWith(10);
		});
		await worker.stop();
	});

	it("waits for every active cleanup before shutdown completes", async () => {
		vi.useFakeTimers();
		let release: (() => void) | undefined;
		const activeCleanup = new Promise<number>((resolve) => { release = () => resolve(0); });
		const expireDue = vi.fn<() => Promise<number>>().mockReturnValue(activeCleanup);
		const worker = startExpiryWorker([{ name: "PULSE", expireDue }], { intervalMs: 60_000 });

		await vi.waitFor(() => expect(expireDue).toHaveBeenCalledOnce());
		let stopped = false;
		const stopping = worker.stop().then(() => { stopped = true; });
		await Promise.resolve();
		expect(stopped).toBe(false);
		release?.();
		await stopping;
		expect(stopped).toBe(true);
	});

	it("does not overlap cycles while a cleanup run is still active", async () => {
		vi.useFakeTimers();
		let release: (() => void) | undefined;
		const activeCleanup = new Promise<number>((resolve) => { release = () => resolve(0); });
		const expireDue = vi.fn<() => Promise<number>>().mockReturnValue(activeCleanup);
		const worker = startExpiryWorker([{ name: "CATCH", expireDue }], { intervalMs: 1_000 });

		await vi.waitFor(() => expect(expireDue).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(5_000);
		expect(expireDue).toHaveBeenCalledOnce();
		release?.();
		await worker.stop();
	});

	it("bounds each job per cycle so a permanent backlog cannot starve other products", async () => {
		vi.useFakeTimers();
		const overloaded = vi.fn<() => Promise<number>>().mockResolvedValue(10);
		const healthy = vi.fn<() => Promise<number>>().mockResolvedValue(0);
		const worker = startExpiryWorker([
			{ name: "CATCH", expireDue: overloaded },
			{ name: "PULSE", expireDue: healthy },
		], { intervalMs: 1_000, batchSize: 10, maxBatchesPerCycle: 2 });

		await vi.waitFor(() => {
			expect(overloaded).toHaveBeenCalledTimes(2);
			expect(healthy).toHaveBeenCalledOnce();
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(overloaded).toHaveBeenCalledTimes(4);
		expect(healthy).toHaveBeenCalledTimes(2);
		await worker.stop();
	});
});
