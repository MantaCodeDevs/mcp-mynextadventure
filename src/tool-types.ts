import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A resolved HTTP call against the MyNextAdventure public API. */
export interface ApiRequest {
	method: HttpMethod;
	/** Path relative to the API base URL, e.g. `/v1/trips/abc123`. */
	path: string;
	query?: Record<string, unknown>;
	body?: unknown;
}

/**
 * A single MCP tool. `inputShape` is handed straight to the MCP SDK, and
 * `resolve` turns validated tool arguments into the HTTP call to make.
 */
export interface ToolDefinition {
	name: string;
	description: string;
	/** OpenAPI operationId(s) this tool covers — useful for tests and docs. */
	operations: string[];
	inputShape: z.ZodRawShape;
	resolve: (args: Record<string, unknown>) => ApiRequest;
}
