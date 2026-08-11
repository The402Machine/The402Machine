import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { formatGateProjectProvisioning, provisionGateProject, type GateOperatorRepository } from "../../src/gate/gate-operator.js";

const createdProject = { id: "project-uuid", publicId: `gate_project_${"p".repeat(24)}`, displayName: "Weather API", lightningAddress: "merchant@example.com", monthlyFreeLimit: 25, active: true, createdAt: new Date("2026-08-11T00:00:00Z"), updatedAt: new Date("2026-08-11T00:00:00Z") };
const createdRoute = { id: "route-uuid", projectId: createdProject.id, routeKey: "forecast", method: "GET" as const, path: "/v1/forecast", priceSats: 42, active: true, createdAt: new Date("2026-08-11T00:00:00Z"), updatedAt: new Date("2026-08-11T00:00:00Z") };

function repository(): GateOperatorRepository {
	return {
		provisionProject: vi.fn(() => Promise.resolve({ project: createdProject, routes: [createdRoute] })),
		getProjectByPublicId: vi.fn(() => Promise.resolve(createdProject)),
		listRoutesForProject: vi.fn(() => Promise.resolve([createdRoute])),
	};
}

describe("GATE operator provisioning", () => {
	it("normalizes operator input, stores only capability hashes and returns plaintext once", async () => {
		const store = repository();
		const result = await provisionGateProject({ displayName: " Weather API ", lightningAddress: "merchant@EXAMPLE.com", routes: [{ key: "forecast", method: "get", path: "/v1/forecast", priceSats: 42 }] }, { repository: store, tokenPepper: "operator-test-pepper", randomBytes: (size: number) => Buffer.alloc(size, 7) });

		expect(result.project).toBe(createdProject);
		expect(result.routes).toEqual([createdRoute]);
		expect(result.adminToken).toMatch(/^gate_admin_[A-Za-z0-9_-]{32,}$/u);
		expect(result.apiToken).toMatch(/^gate_api_[A-Za-z0-9_-]{32,}$/u);
		expect(store.provisionProject).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Weather API", lightningAddress: "merchant@example.com", adminTokenHash: createHmac("sha256", "operator-test-pepper").update(`gate-admin\0${result.adminToken}`, "utf8").digest("hex"), apiTokenHash: createHmac("sha256", "operator-test-pepper").update(`gate-api\0${result.apiToken}`, "utf8").digest("hex") }));
		expect(JSON.stringify(vi.mocked(store.provisionProject).mock.calls)).not.toContain(result.adminToken);
		expect(JSON.stringify(vi.mocked(store.provisionProject).mock.calls)).not.toContain(result.apiToken);
	});

	it("rejects invalid routes before persisting anything", async () => {
		const store = repository();
		await expect(provisionGateProject({ displayName: "Weather API", lightningAddress: "merchant@example.com", routes: [{ key: "forecast", method: "TRACE", path: "/v1/forecast", priceSats: 42 }] }, { repository: store, tokenPepper: "operator-test-pepper" })).rejects.toThrow(/method/u);
		expect(store.provisionProject).not.toHaveBeenCalled();
	});

	it("propagates an atomic provisioning failure without returning capabilities", async () => {
		const store = repository();
		vi.mocked(store.provisionProject).mockRejectedValueOnce(new Error("route insert failed"));
		await expect(provisionGateProject({ displayName: "Weather API", lightningAddress: "merchant@example.com", routes: [{ key: "forecast", method: "GET", path: "/v1/forecast", priceSats: 42 }] }, { repository: store, tokenPepper: "operator-test-pepper" })).rejects.toThrow(/route insert/u);
	});

	it("formats a redacted inspection without capabilities", () => {
		const output = formatGateProjectProvisioning({ project: createdProject, routes: [createdRoute] });
		expect(output).toContain(createdProject.publicId);
		expect(output).toContain("forecast");
		expect(output).not.toMatch(/gate_(?:admin|api)_/u);
	});
});
