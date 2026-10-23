import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLS } from "../src/generated/tools";
import { buildMcpServer } from "../src/mcp-server";

/**
 * The Claude connectors directory flags any tool without a title and a
 * readOnlyHint or destructiveHint. Checked on what is actually registered,
 * so connector_info (registered by hand) is covered too.
 */
describe("every registered tool is directory-ready", () => {
	afterEach(() => vi.restoreAllMocks());

	const registered = () => {
		const registerTool = vi.spyOn(McpServer.prototype, "registerTool");
		buildMcpServer({});
		return registerTool.mock.calls.map(([name, config]) => ({
			name,
			config: config as {
				title?: string;
				annotations?: Record<string, unknown>;
			},
		}));
	};

	it("registers all generated tools plus connector_info", () => {
		expect(registered().map((t) => t.name)).toEqual([
			...TOOLS.map((t) => t.name),
			"connector_info",
		]);
	});

	it.each(registered())(
		"$name has a title, mirrored in annotations, and both hints",
		({ config }) => {
			expect(config.title?.trim()).toBeTruthy();
			expect(config.annotations?.title).toBe(config.title);
			expect(typeof config.annotations?.readOnlyHint).toBe("boolean");
			expect(typeof config.annotations?.destructiveHint).toBe("boolean");
		},
	);

	it("uses unique titles", () => {
		const titles = registered().map((t) => t.config.title);
		expect(new Set(titles).size).toBe(titles.length);
	});
});
