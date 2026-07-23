import type { CatchRepository } from "./storage/catch-repository.js";

export type ExpiryWorker = {
	stop(): Promise<void>;
};

type ExpiryWorkerOptions = {
	intervalMs?: number;
	batchSize?: number;
	onError?: (error: unknown) => void;
};

export function startExpiryWorker(repository: CatchRepository, options: ExpiryWorkerOptions = {}): ExpiryWorker {
	const intervalMs = options.intervalMs ?? 30_000;
	const batchSize = options.batchSize ?? 100;
	let stopped = false;
	let activeRun: Promise<void> | undefined;

	const run = async (): Promise<void> => {
		if (stopped || activeRun !== undefined) return;
		activeRun = (async () => {
			while (!stopped) {
				const expired = await repository.expireDueResources(batchSize);
				if (expired < batchSize) return;
			}
		})()
			.catch((error: unknown) => options.onError?.(error))
			.finally(() => { activeRun = undefined; });
		await activeRun;
	};

	const timer = setInterval(() => { void run(); }, intervalMs);
	timer.unref();
	void run();

	return {
		async stop(): Promise<void> {
			stopped = true;
			clearInterval(timer);
			await activeRun;
		},
	};
}
