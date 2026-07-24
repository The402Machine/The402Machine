import { describe, expect, it } from "vitest";

import { ownerPulseStatus, parsePulseSettings, publicPulseStatus, pulseState } from "../../src/pulse/pulse-contract.js";
import type { PulseResource } from "../../src/pulse/pulse-repository.js";

const resource = (overrides: Partial<PulseResource> = {}): PulseResource => ({
	id: "pulse-resource",
	publicId: "pulse_abcdefghijklmnopqrstuv",
	publicStatusId: "pulse_status_zyxwvutsrqponmlkjihgfe",
	planId: "spark",
	status: "active",
	ownerTokenHash: "owner-hash",
	pingTokenHash: "ping-hash",
	heartbeatLimit: 1_202,
	heartbeatCount: 4,
	expectedIntervalSeconds: 300,
	graceSeconds: 600,
	name: "Backup heartbeat",
	description: "Nightly backup worker",
	publicStatusEnabled: true,
	lastPingAt: new Date("2026-07-24T10:05:00.000Z"),
	createdAt: new Date("2026-07-24T10:00:00.000Z"),
	expiresAt: new Date("2026-07-28T12:00:00.000Z"),
	...overrides,
});

describe("PULSE contract", () => {
	it("derives every display state from one deterministic clock", () => {
		expect(pulseState(resource({ lastPingAt: null }), Date.parse("2026-07-24T10:01:00.000Z"))).toBe("waiting");
		expect(pulseState(resource(), Date.parse("2026-07-24T10:19:59.000Z"))).toBe("operational");
		expect(pulseState(resource(), Date.parse("2026-07-24T10:20:01.000Z"))).toBe("late");
		expect(pulseState(resource({ status: "exhausted" }), Date.parse("2026-07-24T10:06:00.000Z"))).toBe("exhausted");
		expect(pulseState(resource(), Date.parse("2026-07-28T12:00:00.000Z"))).toBe("expired");
		expect(pulseState(resource({ status: "exhausted" }), Date.parse("2026-07-28T12:00:00.000Z"))).toBe("expired");
	});

	it("keeps the public DTO bounded while the owner DTO contains operational fields", () => {
		const current = resource();
		expect(publicPulseStatus(current, Date.parse("2026-07-24T10:06:00.000Z"))).toEqual({
			name: "Backup heartbeat",
			description: "Nightly backup worker",
			state: "operational",
			lastPingAt: "2026-07-24T10:05:00.000Z",
		});
		expect(ownerPulseStatus(current, Date.parse("2026-07-24T10:06:00.000Z"))).toMatchObject({
			publicId: current.publicId,
			publicStatusId: current.publicStatusId,
			heartbeatLimit: 1_202,
			heartbeatCount: 4,
			heartbeatsRemaining: 1_198,
			expectedIntervalSeconds: 300,
			graceSeconds: 600,
			publicStatusEnabled: true,
		});
	});

	it("merges partial settings, trims strings, and rejects unknown keys", () => {
		const current = resource();
		expect(parsePulseSettings({ name: "  Renamed monitor  " }, current)).toEqual({
			name: "Renamed monitor",
			description: current.description,
			expectedIntervalSeconds: current.expectedIntervalSeconds,
			graceSeconds: current.graceSeconds,
			publicStatusEnabled: current.publicStatusEnabled,
		});
		expect(parsePulseSettings({ publicStatusEnabledd: true }, current)).toBeNull();
	});

	it("merges partial settings from the raw JSON buffer installed for CATCH", () => {
		const current = resource({ publicStatusEnabled: false });
		expect(parsePulseSettings(Buffer.from('{"publicStatusEnabled":true}'), current)).toEqual({
			name: current.name,
			description: current.description,
			expectedIntervalSeconds: current.expectedIntervalSeconds,
			graceSeconds: current.graceSeconds,
			publicStatusEnabled: true,
		});
	});
});
