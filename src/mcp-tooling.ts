import { z } from "zod";
import type { ToolAnnotations, ToolDefinition } from "./tool-types";

/**
 * The subset of MCP SDK v2's `registerTool` config we populate from a generated
 * `ToolDefinition`. `inputSchema` is a single zod object built from the tool's raw
 * shape; `title`, `annotations` and `description` pass straight through, with the
 * title repeated in `annotations.title` for clients that only read it there.
 */
export interface RegisterToolConfig {
	title: string;
	description: string;
	inputSchema: z.ZodObject<z.ZodRawShape>;
	annotations: ToolAnnotations & { title: string };
}

/**
 * Adapt a generated `ToolDefinition` to `registerTool`'s config object. The v1 SDK
 * took the raw zod shape directly (`server.tool(name, desc, shape, …)`); the v2 SDK
 * takes a config with a single `inputSchema`, so the raw shape is wrapped in
 * `z.object` here — the one place that mapping lives.
 */
export function toRegisterToolConfig(tool: ToolDefinition): RegisterToolConfig {
	return {
		title: tool.title,
		description: tool.description,
		inputSchema: z.object(tool.inputShape),
		annotations: { ...tool.annotations, title: tool.title },
	};
}
