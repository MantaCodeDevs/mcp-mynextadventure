import { describe, expect, it, vi } from "vitest";
import {
	type AuthContextReader,
	makeConnectorInfoHandler,
	makeToolHandler,
} from "../src/mcp-server";
import type { ToolDefinition } from "../src/tool-types";

const tool: ToolDefinition = {
	name: "whoami",
	title: "Who Am I",
	description: "who",
	operations: ["MeV1Controller_getMe"],
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputShape: {},
	resolve: () => ({ method: "GET", path: "/v1/me" }),
};

const okApi = () => vi.fn().mockResolvedValue({ ok: true, status: 200, text: '{"id":"u1"}' });
const ctxWith =
	(apiKey: unknown): AuthContextReader =>
	() => ({ props: { apiKey } });

describe("makeToolHandler — per-request credential", () => {
	it("runs the call under the key from the current auth context", async () => {
		const callApi = okApi();
		const handler = makeToolHandler(tool, {
			apiBaseUrl: "https://api.test",
			callApi,
			getAuthContext: ctxWith("mna_A"),
		});

		await handler({});

		expect(callApi).toHaveBeenCalledWith("https://api.test", "mna_A", {
			method: "GET",
			path: "/v1/me",
		});
	});

	it("uses whichever key the CURRENT request carries, with no carryover", async () => {
		const callApi = okApi();
		let key = "mna_A";
		const getAuthContext: AuthContextReader = () => ({ props: { apiKey: key } });
		const handler = makeToolHandler(tool, {
			apiBaseUrl: "https://api.test",
			callApi,
			getAuthContext,
		});

		await handler({});
		key = "mna_B";
		await handler({});

		expect(callApi.mock.calls[0][1]).toBe("mna_A");
		expect(callApi.mock.calls[1][1]).toBe("mna_B");
	});

	it("refuses (and never calls the API) when no credential is on the request", async () => {
		const callApi = okApi();
		const handler = makeToolHandler(tool, {
			apiBaseUrl: "https://api.test",
			callApi,
			getAuthContext: () => undefined,
		});

		const result = await handler({});

		expect(result.isError).toBe(true);
		expect(callApi).not.toHaveBeenCalled();
	});

	it("refuses when the auth context has an empty key", async () => {
		const callApi = okApi();
		const handler = makeToolHandler(tool, {
			apiBaseUrl: "https://api.test",
			callApi,
			getAuthContext: ctxWith(""),
		});

		const result = await handler({});

		expect(result.isError).toBe(true);
		expect(callApi).not.toHaveBeenCalled();
	});

	it("surfaces a resolve() error as an error result without calling the API", async () => {
		const callApi = okApi();
		const throwing: ToolDefinition = {
			...tool,
			resolve: () => {
				throw new Error("bad args");
			},
		};
		const handler = makeToolHandler(throwing, {
			apiBaseUrl: "https://api.test",
			callApi,
			getAuthContext: ctxWith("mna_A"),
		});

		const result = await handler({});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("bad args");
		expect(callApi).not.toHaveBeenCalled();
	});

	it("marks an API failure as an error result", async () => {
		const callApi = vi.fn().mockResolvedValue({ ok: false, status: 404, text: "Not found" });
		const handler = makeToolHandler(tool, {
			apiBaseUrl: "https://api.test",
			callApi,
			getAuthContext: ctxWith("mna_A"),
		});

		const result = await handler({});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Not found");
	});
});

describe("makeConnectorInfoHandler", () => {
	it("reports the build and contract without needing a credential", async () => {
		const handler = makeConnectorInfoHandler({
			apiBaseUrl: "https://api.test",
			version: { id: "build-123", timestamp: "2026-09-17T00:00:00Z" },
			getLiveContractHash: async () => null,
		});

		const result = await handler();

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("Connector build: build-123");
		expect(result.content[0].text).toContain("API: https://api.test");
	});

	it("flags a contract mismatch", async () => {
		const handler = makeConnectorInfoHandler({
			apiBaseUrl: "https://api.test",
			version: { id: "b" },
			getLiveContractHash: async () => "different-hash",
		});

		const result = await handler();

		expect(result.content[0].text).toContain("MISMATCH");
	});
});
