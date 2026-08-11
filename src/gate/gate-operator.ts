import { createHmac, randomBytes as secureRandomBytes } from "node:crypto";

import { normalizeLightningAddress, validateGateRoute, type GateRouteInput } from "./gate-domain.js";
import type { GateProject, GateRepository, GateRoute } from "./gate-repository.js";

export type GateOperatorRepository = Pick<GateRepository, "provisionProject" | "getProjectByPublicId" | "listRoutesForProject">;

export type GateProjectProvisioningInput = {
	displayName: string;
	lightningAddress: string;
	routes: GateRouteInput[];
};

export type GateProjectProvisioningResult = {
	project: GateProject;
	routes: GateRoute[];
	adminToken: string;
	apiToken: string;
};

type GateOperatorDependencies = {
	repository: GateOperatorRepository;
	tokenPepper: string;
	randomBytes?: (size: number) => Buffer;
};

export async function provisionGateProject(input: GateProjectProvisioningInput, dependencies: GateOperatorDependencies): Promise<GateProjectProvisioningResult> {
	const displayName = input.displayName.trim();
	if (displayName.length < 1 || displayName.length > 120) throw new Error("GATE project display name must contain between 1 and 120 characters");
	if (dependencies.tokenPepper.length < 8) throw new Error("GATE token pepper is unavailable");
	if (input.routes.length < 1 || input.routes.length > 50) throw new Error("GATE provisioning requires between 1 and 50 routes");
	const lightningAddress = normalizeLightningAddress(input.lightningAddress);
	const routes = input.routes.map(validateGateRoute);
	if (new Set(routes.map((route) => route.key)).size !== routes.length) throw new Error("GATE route keys must be unique");
	const bytes = dependencies.randomBytes ?? secureRandomBytes;
	const projectPublicId = `gate_project_${bytes(24).toString("base64url")}`;
	const adminToken = `gate_admin_${bytes(32).toString("base64url")}`;
	const apiToken = `gate_api_${bytes(32).toString("base64url")}`;
	const provisioned = await dependencies.repository.provisionProject({
		publicId: projectPublicId,
		displayName,
		lightningAddress,
		adminTokenHash: hashCapability("gate-admin", dependencies.tokenPepper, adminToken),
		apiTokenHash: hashCapability("gate-api", dependencies.tokenPepper, apiToken),
		routes,
	});
	return { project: provisioned.project, routes: provisioned.routes, adminToken, apiToken };
}

export function formatGateProjectProvisioning(input: { project: GateProject; routes: GateRoute[] }): string {
	return JSON.stringify({ project: { publicId: input.project.publicId, displayName: input.project.displayName, lightningAddress: input.project.lightningAddress, monthlyFreeLimit: input.project.monthlyFreeLimit, active: input.project.active }, routes: input.routes.map((route) => ({ key: route.routeKey, method: route.method, path: route.path, priceSats: route.priceSats, active: route.active })) }, null, 2);
}

function hashCapability(role: "gate-admin" | "gate-api", pepper: string, token: string): string {
	return createHmac("sha256", pepper).update(`${role}\0${token}`, "utf8").digest("hex");
}
