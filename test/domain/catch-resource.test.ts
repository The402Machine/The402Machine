import { describe, expect, it } from "vitest";

import {
	canTransitionCatchResource,
	transitionCatchResource,
	type CatchResourceStatus,
} from "../../src/domain/catch-resource.js";

const inactiveStatuses: CatchResourceStatus[] = [
	"exhausted",
	"expired",
	"suspended",
	"manually_destroyed",
];

describe("CATCH resource lifecycle", () => {
	it("allows active resources to enter each inactive status", () => {
		for (const status of inactiveStatuses) {
			expect(canTransitionCatchResource("active", status)).toBe(true);
			expect(transitionCatchResource("active", status)).toBe(status);
		}
	});

	it("allows every terminal inactive status to be deleted", () => {
		for (const status of inactiveStatuses) {
			expect(canTransitionCatchResource(status, "deleted")).toBe(true);
			expect(transitionCatchResource(status, "deleted")).toBe("deleted");
		}
	});

	it("rejects revivals and other illegal transitions", () => {
		expect(canTransitionCatchResource("active", "active")).toBe(false);
		expect(canTransitionCatchResource("deleted", "deleted")).toBe(false);
		expect(canTransitionCatchResource("expired", "active")).toBe(false);
		expect(canTransitionCatchResource("exhausted", "suspended")).toBe(false);
		expect(canTransitionCatchResource("deleted", "active")).toBe(false);
		expect(() => transitionCatchResource("deleted", "deleted")).toThrow(
		"Illegal CATCH resource transition: deleted -> deleted",
	);
		expect(() => transitionCatchResource("deleted", "active")).toThrow(
		"Illegal CATCH resource transition: deleted -> active",
	);
	});
});
