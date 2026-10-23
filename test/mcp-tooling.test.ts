import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toRegisterToolConfig } from "../src/mcp-tooling";
import type { ToolDefinition } from "../src/tool-types";

/**
 * `toRegisterToolConfig` adapts our generated `ToolDefinition` (a zod raw shape +
 * resolve + annotations) into the config object MCP SDK v2's `registerTool` expects.
 * The zod raw shape becomes a single `inputSchema` object; description and all four
 * annotations carry through unchanged.
 */
describe("toRegisterToolConfig", () => {
	const tool: ToolDefinition = {
		name: "add_thing",
		title: "Add Thing",
		description: "Add a thing.",
		operations: ["Things_add"],
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		inputShape: { name: z.string(), count: z.number().optional() },
		resolve: () => ({ method: "POST", path: "/v1/things" }),
	};

	it("carries the title, description and all four annotations through", () => {
		const cfg = toRegisterToolConfig(tool);
		expect(cfg.title).toBe("Add Thing");
		expect(cfg.description).toBe("Add a thing.");
		expect(cfg.annotations).toEqual({
			title: "Add Thing",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
	});

	it("builds an inputSchema that accepts valid args", () => {
		const cfg = toRegisterToolConfig(tool);
		expect(cfg.inputSchema.parse({ name: "x", count: 2 })).toEqual({ name: "x", count: 2 });
	});

	it("builds an inputSchema that rejects args missing a required field", () => {
		const cfg = toRegisterToolConfig(tool);
		expect(cfg.inputSchema.safeParse({}).success).toBe(false);
	});

	it("maps an empty shape to a schema that accepts no-arg calls", () => {
		const empty: ToolDefinition = { ...tool, inputShape: {} };
		const cfg = toRegisterToolConfig(empty);
		expect(cfg.inputSchema.safeParse({}).success).toBe(true);
	});
});
