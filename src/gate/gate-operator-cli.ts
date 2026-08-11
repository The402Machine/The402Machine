import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { validateGateRoute, type GateRouteInput } from "./gate-domain.js";
import { formatGateProjectProvisioning, provisionGateProject } from "./gate-operator.js";
import { GateRepository } from "./gate-repository.js";

export type GateOperatorCommand =
	| { command: "create-project"; displayName: string; lightningAddress: string; routes: GateRouteInput[] }
	| { command: "inspect-project"; projectPublicId: string };

const PROJECT_PUBLIC_ID = /^gate_project_[A-Za-z0-9_-]{16,64}$/u;

export function parseGateOperatorArguments(arguments_: string[]): GateOperatorCommand {
	const [command, ...tokens] = arguments_;
	if (command === "create-project") {
		const displayName = oneOption(tokens, "--name");
		const lightningAddress = oneOption(tokens, "--lightning-address");
		const routeSpecs = repeatedOption(tokens, "--route");
		const acknowledgementCount = tokens.filter((token) => token === "--allow-plaintext-capabilities").length;
		if (acknowledgementCount === 0) throw new Error("GATE create-project requires --allow-plaintext-capabilities because it emits bearer secrets to stdout\n" + operatorUsage());
		if (acknowledgementCount !== 1 || displayName === null || lightningAddress === null || routeSpecs.length === 0 || hasUnknownTokens(tokens, ["--name", "--lightning-address", "--route"], ["--allow-plaintext-capabilities"])) throw new Error(operatorUsage());
		return { command, displayName, lightningAddress, routes: routeSpecs.map(parseRouteSpecification) };
	}
	if (command === "inspect-project") {
		const projectPublicId = oneOption(tokens, "--project");
		if (projectPublicId === null || !PROJECT_PUBLIC_ID.test(projectPublicId) || hasUnknownTokens(tokens, ["--project"])) throw new Error("GATE project identifier is invalid\n" + operatorUsage());
		return { command, projectPublicId };
	}
	throw new Error(operatorUsage());
}

export function operatorUsage(): string {
	return [
		"Usage:",
		"  npm run gate:operator -- create-project --name <name> --lightning-address <address> --route <key:METHOD:/path:priceSats> [--route ...] --allow-plaintext-capabilities",
		"  npm run gate:operator -- inspect-project --project <gate_project_id>",
		"",
		"This CLI writes only project and route policy. It never resolves Lightning Addresses or creates invoices.",
	].join("\n");
}

export async function runGateOperator(arguments_: string[], environment: NodeJS.ProcessEnv = process.env): Promise<string> {
	const command = parseGateOperatorArguments(arguments_);
	const databaseUrl = environment.DATABASE_URL;
	const tokenPepper = environment.CATCH_TOKEN_PEPPER;
	if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error("DATABASE_URL is required for GATE operator commands");
	if (tokenPepper === undefined || tokenPepper.length < 8) throw new Error("CATCH_TOKEN_PEPPER is required for GATE operator commands");
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		const repository = new GateRepository(sql);
		if (command.command === "create-project") {
			const result = await provisionGateProject({ displayName: command.displayName, lightningAddress: command.lightningAddress, routes: command.routes }, { repository, tokenPepper });
			return JSON.stringify({ warning: "Save both capabilities now. Plaintext is not stored and cannot be recovered.", project: { publicId: result.project.publicId, displayName: result.project.displayName, lightningAddress: result.project.lightningAddress, monthlyFreeLimit: result.project.monthlyFreeLimit }, routes: result.routes.map((route) => ({ key: route.routeKey, method: route.method, path: route.path, priceSats: route.priceSats })), capabilities: { admin: result.adminToken, api: result.apiToken } }, null, 2);
		}
		const project = await repository.getProjectByPublicId(command.projectPublicId);
		if (project === null) throw new Error("GATE project not found");
		return formatGateProjectProvisioning({ project, routes: await repository.listRoutesForProject(project.id) });
	} finally {
		await sql.end();
	}
}

function parseRouteSpecification(value: string): GateRouteInput {
	const parts = value.split(":");
	if (parts.length !== 4) throw new Error("GATE route must use key:METHOD:/path:priceSats");
	const [key, method, path, price] = parts as [string, string, string, string];
	const priceSats = Number(price);
	return validateGateRoute({ key, method, path, priceSats });
}

function oneOption(tokens: string[], option: string): string | null {
	const values = repeatedOption(tokens, option);
	return values.length === 1 ? values[0]! : null;
}

function repeatedOption(tokens: string[], option: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) if (tokens[index] === option && tokens[index + 1] !== undefined && !tokens[index + 1]!.startsWith("--")) values.push(tokens[index + 1]!);
	return values;
}

function hasUnknownTokens(tokens: string[], valueOptions: string[], flagOptions: string[] = []): boolean {
	for (let index = 0; index < tokens.length;) {
		const token = tokens[index] ?? "";
		if (flagOptions.includes(token)) { index += 1; continue; }
		if (!valueOptions.includes(token) || tokens[index + 1] === undefined || tokens[index + 1]!.startsWith("--")) return true;
		index += 2;
	}
	return false;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runGateOperator(process.argv.slice(2)).then((output) => { process.stdout.write(output + "\n"); }).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "GATE operator failed"}\n`); process.exitCode = 1; });
}
