import { validPulseSchedule } from "../domain/pulse-plans.js";
import type { PulseResource, PulseSettings } from "./pulse-repository.js";

const PULSE_SETTING_KEYS = new Set<keyof PulseSettings>([
	"name",
	"description",
	"expectedIntervalSeconds",
	"graceSeconds",
	"publicStatusEnabled",
]);

export type PulseDisplayState = "waiting" | "operational" | "late" | "exhausted" | "expired";

export type PublicPulseStatus = {
	name: string;
	description: string;
	state: PulseDisplayState;
	lastPingAt: string | null;
};

export type OwnerPulseStatus = PublicPulseStatus & {
	publicId: string;
	publicStatusId: string;
	planId: PulseResource["planId"];
	status: PulseResource["status"];
	heartbeatLimit: number;
	heartbeatCount: number;
	heartbeatsRemaining: number;
	expectedIntervalSeconds: number;
	graceSeconds: number;
	publicStatusEnabled: boolean;
	createdAt: string;
	expiresAt: string;
};

export function parsePulseSettings(body: unknown, current: PulseResource): PulseSettings | null {
	const parsedBody = parseSettingsBody(body);
	if (parsedBody === null || Object.keys(parsedBody).some((key) => !PULSE_SETTING_KEYS.has(key as keyof PulseSettings))) return null;
	const rawName = parsedBody.name === undefined ? current.name : parsedBody.name;
	const rawDescription = parsedBody.description === undefined ? current.description : parsedBody.description;
	const expectedIntervalSeconds = parsedBody.expectedIntervalSeconds === undefined ? current.expectedIntervalSeconds : parsedBody.expectedIntervalSeconds;
	const graceSeconds = parsedBody.graceSeconds === undefined ? current.graceSeconds : parsedBody.graceSeconds;
	const publicStatusEnabled = parsedBody.publicStatusEnabled === undefined ? current.publicStatusEnabled : parsedBody.publicStatusEnabled;
	if (typeof rawName !== "string" || typeof rawDescription !== "string" || typeof publicStatusEnabled !== "boolean" || typeof expectedIntervalSeconds !== "number" || typeof graceSeconds !== "number") return null;
	const name = rawName.trim();
	const description = rawDescription.trim();
	if (name.length < 1 || name.length > 80 || description.length > 240 || !validPulseSchedule(current.planId, expectedIntervalSeconds, graceSeconds)) return null;
	return { name, description, expectedIntervalSeconds, graceSeconds, publicStatusEnabled };
}

export function pulseState(resource: PulseResource, now = Date.now()): PulseDisplayState {
	if (resource.status === "expired" || resource.status === "manually_destroyed" || now >= resource.expiresAt.getTime()) return "expired";
	if (resource.status === "exhausted") return "exhausted";
	if (resource.lastPingAt === null) return "waiting";
	return now > resource.lastPingAt.getTime() + (resource.expectedIntervalSeconds + resource.graceSeconds) * 1_000 ? "late" : "operational";
}

export function publicPulseStatus(resource: PulseResource, now = Date.now()): PublicPulseStatus {
	return { name: resource.name, description: resource.description, state: pulseState(resource, now), lastPingAt: resource.lastPingAt?.toISOString() ?? null };
}

export function ownerPulseStatus(resource: PulseResource, now = Date.now()): OwnerPulseStatus {
	return {
		...publicPulseStatus(resource, now),
		publicId: resource.publicId,
		publicStatusId: resource.publicStatusId,
		planId: resource.planId,
		status: resource.status,
		heartbeatLimit: resource.heartbeatLimit,
		heartbeatCount: resource.heartbeatCount,
		heartbeatsRemaining: Math.max(0, resource.heartbeatLimit - resource.heartbeatCount),
		expectedIntervalSeconds: resource.expectedIntervalSeconds,
		graceSeconds: resource.graceSeconds,
		publicStatusEnabled: resource.publicStatusEnabled,
		createdAt: resource.createdAt.toISOString(),
		expiresAt: resource.expiresAt.toISOString(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettingsBody(body: unknown): Record<string, unknown> | null {
	if (Buffer.isBuffer(body)) {
		try {
			const parsed: unknown = JSON.parse(body.toString("utf8"));
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return isRecord(body) ? body : null;
}