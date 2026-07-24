export type ExpiryWorker = {
	stop(): Promise<void>;
};

export type ExpiryJob = {
	name: string;
	expireDue(limit: number): Promise<number>;
};

type ExpiryWorkerOptions = {
	intervalMs?: number;
	batchSize?: number;
	maxBatchesPerCycle?: number;
	onError?: (jobName: string, error: unknown) => void;
};

export function startExpiryWorker(jobs: readonly ExpiryJob[], options: ExpiryWorkerOptions = {}): ExpiryWorker {
	const intervalMs = options.intervalMs ?? 30_000;
	const batchSize = options.batchSize ?? 100;
	const maxBatchesPerCycle = options.maxBatchesPerCycle ?? 10;
	let stopped = false;
	let activeRun: Promise<void> | undefined;

	const drain = async (job: ExpiryJob): Promise<void> => {
		try {
			for (let batch = 0; !stopped && batch < maxBatchesPerCycle; batch += 1) {
				if (await job.expireDue(batchSize) < batchSize) return;
			}
		} catch (error: unknown) {
			options.onError?.(job.name, error);
		}
	};

	const run = async (): Promise<void> => {
		if (stopped || activeRun !== undefined) return;
		activeRun = Promise.all(jobs.map(drain))
			.then(() => undefined)
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
