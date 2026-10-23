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
 * Behavioural hints published with every tool, per the MCP `ToolAnnotations`
 * type (spec revision 2026-07-28). Clients use these to decide what to run
 * without asking, what to confirm first, and what to cache.
 *
 * The spec makes every field optional with a default, and the defaults are the
 * pessimistic ones (`readOnlyHint: false`, `destructiveHint: true`,
 * `idempotentHint: false`, `openWorldHint: true`). We make all four **required**
 * so the manifest has to state a deliberate answer for each tool rather than
 * inheriting a default nobody chose.
 *
 * Semantics, quoted from the spec:
 * - `readOnlyHint` — "If true, the tool does not modify its environment."
 * - `destructiveHint` — "If true, the tool may perform destructive updates to
 *   its environment. If false, the tool performs only additive updates."
 * - `idempotentHint` — "If true, calling the tool repeatedly with the same
 *   arguments will have no additional effect on its environment."
 * - `openWorldHint` — "If true, this tool may interact with an 'open world' of
 *   external entities. If false, the tool's domain of interaction is closed."
 *
 * Declared as a type alias rather than an interface on purpose: the MCP SDK
 * types annotations as a passthrough object (it carries an index signature),
 * and only type aliases pick up the implicit index signature that makes them
 * assignable to it. An interface here would need a cast at the call site.
 */
export type ToolAnnotations = {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
};

/**
 * A single MCP tool. `inputShape` is handed straight to the MCP SDK, and
 * `resolve` turns validated tool arguments into the HTTP call to make.
 */
export interface ToolDefinition {
	name: string;
	title: string;
	description: string;
	/** OpenAPI operationId(s) this tool covers — useful for tests and docs. */
	operations: string[];
	annotations: ToolAnnotations;
	inputShape: z.ZodRawShape;
	resolve: (args: Record<string, unknown>) => ApiRequest;
}
