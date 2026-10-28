import { createServer } from "node:http";

import { Agent } from "undici";
import { expect, it } from "vitest";

import { createPinnedLookup } from "../../src/gate/lightning-address-adapter.js";

it("keeps the pinned dispatcher compatible with Node's native fetch", async () => {
	const server = createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ pinned: true }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Expected a TCP fixture");
	const dispatcher = new Agent({ connect: { lookup: createPinnedLookup("127.0.0.1") } });
	try {
		// This reserved hostname cannot resolve without the real pinned lookup.
		// Only the owned loopback fixture is contacted; no provider or invoice.
		const options = { dispatcher } as RequestInit & { dispatcher: Agent };
		const response = await fetch(`http://pinned-provider.invalid:${address.port}/`, options);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ pinned: true });
	} finally {
		await dispatcher.close();
		await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
	}
});
