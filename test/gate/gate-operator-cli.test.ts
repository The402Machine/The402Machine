import { describe, expect, it } from "vitest";

import { parseGateOperatorArguments, runGateOperator } from "../../src/gate/gate-operator-cli.js";

describe("GATE operator CLI arguments", () => {
	it("parses a project with repeatable fixed route specifications and explicit capability output acknowledgement", () => {
		expect(parseGateOperatorArguments(["create-project", "--name", "Weather API", "--lightning-address", "merchant@example.com", "--route", "forecast:GET:/v1/forecast:42", "--route", "alerts:POST:/v1/alerts:402", "--allow-plaintext-capabilities"])).toEqual({ command: "create-project", displayName: "Weather API", lightningAddress: "merchant@example.com", routes: [{ key: "forecast", method: "GET", path: "/v1/forecast", priceSats: 42 }, { key: "alerts", method: "POST", path: "/v1/alerts", priceSats: 402 }] });
	});

	it("requires explicit acknowledgement before emitting plaintext capabilities", () => {
		expect(() => parseGateOperatorArguments(["create-project", "--name", "Weather API", "--lightning-address", "merchant@example.com", "--route", "forecast:GET:/v1/forecast:42"])).toThrow(/allow-plaintext-capabilities/u);
	});

	it("rejects duplicate acknowledgement flags and unexpected options", () => {
		expect(() => parseGateOperatorArguments(["create-project", "--name", "Weather API", "--lightning-address", "merchant@example.com", "--route", "forecast:GET:/v1/forecast:42", "--allow-plaintext-capabilities", "--allow-plaintext-capabilities"])).toThrow(/Usage/u);
		expect(() => parseGateOperatorArguments(["create-project", "--name", "Weather API", "--lightning-address", "merchant@example.com", "--route", "forecast:GET:/v1/forecast:42", "--allow-plaintext-capabilities", "--unexpected"])).toThrow(/Usage/u);
	});

	it("parses a side-effect-free project inspection", () => {
		expect(parseGateOperatorArguments(["inspect-project", "--project", `gate_project_${"p".repeat(24)}`])).toEqual({ command: "inspect-project", projectPublicId: `gate_project_${"p".repeat(24)}` });
	});

	it("rejects malformed or incomplete arguments", () => {
		expect(() => parseGateOperatorArguments(["create-project", "--name", "Weather API"])).toThrow(/allow-plaintext-capabilities/u);
		expect(() => parseGateOperatorArguments(["create-project", "--name", "Weather API", "--lightning-address", "merchant@example.com", "--route", "forecast:TRACE:/v1/forecast:42", "--allow-plaintext-capabilities"])).toThrow(/method/u);
		expect(() => parseGateOperatorArguments(["inspect-project", "--project", "other"])).toThrow(/project/u);
	});

	it("validates arguments before requiring database credentials", async () => {
		await expect(runGateOperator([], {})).rejects.toThrow(/Usage/u);
	});
});
