import { describe, expect, it, vi } from "vitest";
import {
	type EventsBinding,
	clientFamily,
	makeTelemetry,
	reportSessions,
	sanitizeClientName,
	timeTool,
} from "../src/telemetry";

const binding = () => {
	const writeDataPoint = vi.fn();
	return { events: { writeDataPoint } as EventsBinding, writeDataPoint };
};

const request = (headers: Record<string, string> = {}, cf?: { country?: string }) =>
	Object.assign(new Request("https://mcp.test/mcp", { method: "POST", headers }), { cf });

describe("clientFamily — coarse client from the User-Agent, never the raw string", () => {
	it.each([
		["Claude-User/1.0 (+https://support.anthropic.com/)", "claude"],
		["claude-ai/0.1.0", "claude"],
		[
			"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0",
			"chatgpt",
		],
		["openai-mcp/1.0.0", "chatgpt"],
		["Cursor/1.4.2", "cursor"],
		["Visual Studio Code/1.95", "vscode"],
		["Windsurf/1.0", "windsurf"],
		["Cline/3.1", "cline"],
		["node", "node"],
		["python-httpx/0.27.0", "python"],
		["SomethingElse/9", "other"],
	])("%s -> %s", (ua, family) => {
		expect(clientFamily(ua)).toBe(family);
	});

	it("is 'unknown' without a User-Agent", () => {
		expect(clientFamily(null)).toBe("unknown");
	});
});

describe("sanitizeClientName", () => {
	it("keeps a short, lower-case, safe name", () => {
		expect(sanitizeClientName("Claude Desktop")).toBe("claude-desktop");
		expect(sanitizeClientName("a".repeat(100))).toHaveLength(40);
	});

	it("is 'unknown' for anything that is not a non-empty string", () => {
		expect(sanitizeClientName(undefined)).toBe("unknown");
		expect(sanitizeClientName(42)).toBe("unknown");
		expect(sanitizeClientName("   ")).toBe("unknown");
	});
});

describe("makeTelemetry — the shared Manta Code event layout", () => {
	it("writes mcp_tool with tool, client family, duration and ok flag", () => {
		const { events, writeDataPoint } = binding();
		const telemetry = makeTelemetry(
			events,
			request({ "User-Agent": "Cursor/1.4" }, { country: "DE" }),
			"v123",
		);

		telemetry.toolCall("get_trip", 87, true);

		expect(writeDataPoint).toHaveBeenCalledWith({
			indexes: ["mna-mcp"],
			blobs: [
				"mna-mcp",
				"mcp_tool",
				"get_trip",
				"cursor",
				"",
				"server",
				"DE",
				"",
				"",
				"",
				"v123",
			],
			doubles: [87, 1],
		});
	});

	it("writes mcp_session with the initialize clientInfo name and the client family", () => {
		const { events, writeDataPoint } = binding();
		const telemetry = makeTelemetry(
			events,
			request({ "User-Agent": "Claude-User/1.0" }),
			undefined,
		);

		telemetry.session("claude-ai");

		expect(writeDataPoint.mock.calls[0][0].blobs.slice(1, 4)).toEqual([
			"mcp_session",
			"claude-ai",
			"claude",
		]);
		expect(writeDataPoint.mock.calls[0][0].doubles).toEqual([0, 1]);
	});

	it("never carries the Authorization header, User-Agent or any argument", () => {
		const { events, writeDataPoint } = binding();
		const telemetry = makeTelemetry(
			events,
			request({
				Authorization: "Bearer mna_secret",
				"User-Agent": "Cursor/1.4 secret-machine",
			}),
			undefined,
		);

		telemetry.toolCall("create_trip", 10, false);

		const written = JSON.stringify(writeDataPoint.mock.calls);
		expect(written).not.toContain("mna_secret");
		expect(written).not.toContain("secret-machine");
	});

	it("is a no-op without the binding, and a failing write never throws", () => {
		expect(() =>
			makeTelemetry(undefined, request(), undefined).toolCall("x", 1, true),
		).not.toThrow();
		const events = {
			writeDataPoint: () => {
				throw new Error("down");
			},
		};
		expect(() => makeTelemetry(events, request(), undefined).session("c")).not.toThrow();
	});
});

describe("timeTool", () => {
	it("reports ok for a successful result and passes it through", async () => {
		const toolCall = vi.fn();
		const result = { content: [{ type: "text" as const, text: "hi" }] };

		const out = await timeTool("whoami", async () => result, { toolCall, session: vi.fn() })(
			{},
		);

		expect(out).toBe(result);
		expect(toolCall).toHaveBeenCalledWith("whoami", expect.any(Number), true);
	});

	it("reports an error result, and a thrown handler, as not ok", async () => {
		const toolCall = vi.fn();
		const telemetry = { toolCall, session: vi.fn() };

		await timeTool("a", async () => ({ content: [], isError: true }), telemetry)({});
		await expect(
			timeTool(
				"b",
				async () => {
					throw new Error("boom");
				},
				telemetry,
			)({}),
		).rejects.toThrow("boom");

		expect(toolCall.mock.calls.map((c) => [c[0], c[2]])).toEqual([
			["a", false],
			["b", false],
		]);
	});
});

describe("reportSessions — initialize requests on the wire", () => {
	const post = (body: unknown) =>
		new Request("https://mcp.test/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	it("reports one session per initialize message, single or batched", async () => {
		const session = vi.fn();
		const telemetry = { toolCall: vi.fn(), session };

		await reportSessions(
			post({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { clientInfo: { name: "Cursor" } },
			}),
			telemetry,
		);
		await reportSessions(
			post([
				{
					jsonrpc: "2.0",
					id: 2,
					method: "initialize",
					params: { clientInfo: { name: "claude-ai" } },
				},
				{ jsonrpc: "2.0", id: 3, method: "tools/list" },
			]),
			telemetry,
		);

		expect(session.mock.calls).toEqual([["cursor"], ["claude-ai"]]);
	});

	it("ignores other methods, GETs and bodies that are not JSON, and leaves the request readable", async () => {
		const session = vi.fn();
		const telemetry = { toolCall: vi.fn(), session };
		const req = post({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_trip" },
		});

		await reportSessions(req, telemetry);
		await reportSessions(new Request("https://mcp.test/mcp"), telemetry);
		await reportSessions(
			new Request("https://mcp.test/mcp", { method: "POST", body: "not json" }),
			telemetry,
		);

		expect(session).not.toHaveBeenCalled();
		expect(await req.json()).toMatchObject({ method: "tools/call" });
	});
});
