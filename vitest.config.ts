import { defineConfig } from "vitest/config";

const dockerIntegrationTests = [
	"test/lifecycle/catch-expiry.test.ts",
	"test/payment/payment-repository.test.ts",
	"test/gate/gate-repository.test.ts",
	"test/storage/catch-repository.test.ts",
	"test/storage/migration.test.ts",
	"test/whisper/whisper-repository.test.ts",
];

export default defineConfig({
	test: {
		testTimeout: 15_000,
		hookTimeout: 20_000,
		sequence: {
			groupOrder: 0,
			concurrent: false,
		},
		projects: [
			{
				test: {
					name: "unit",
					include: ["test/**/*.test.ts"],
					exclude: dockerIntegrationTests,
				},
			},
			{
				test: {
					name: "postgres-integration",
					include: dockerIntegrationTests,
					maxWorkers: 1,
					fileParallelism: false,
				},
			},
		],
	},
});
