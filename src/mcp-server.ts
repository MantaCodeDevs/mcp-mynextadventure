import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { DEFAULT_API_BASE_URL, callApi as realCallApi } from "./api-client";
import { CONTRACT_HASH, TOOLS } from "./generated/tools";
import { toRegisterToolConfig } from "./mcp-tooling";
import { type Telemetry, timeTool } from "./telemetry";
import type { ToolAnnotations, ToolDefinition } from "./tool-types";

const SERVER_INSTRUCTIONS = `MyNextAdventure is a collaborative trip planner. Its data model is a hierarchy:

  trip -> variants -> destinations -> accommodation / transport / getting-around options
                   -> events (activities, attached to the variant, not to a destination)

A trip is just a named container. Each variant is one complete alternative plan and
carries the dates. Destinations are the places stayed at, in itinerary order. Options
are the competing candidates for a destination (three hotels to choose between); the
user "selects" one when they decide.

Planning a new trip end to end: create_trip -> create_variant (with dates) ->
add_destination (one per stop) -> add_transport_option / add_accommodation_option /
add_getting_around_option per destination -> add_event for things to do ->
select_destination_option and select_variant once the user decides ->
create_trip_share_link to share it.

Always call get_trip before editing an existing trip: every write tool needs the
variant id, destination key or option key that only get_trip returns. Money fields
always come in pairs (totalCost + currency) — supply both or the trip budget breaks.
Prefer selecting/deselecting and toggling over delete_trip_item, which is permanent.

If a tool rejects a field you expect to exist, or accepts one that then has no
effect, call connector_info: this connector's tool schemas are cached by your
client at connect time and may predate the API. It reports which build you are
talking to and whether it matches the live API contract.`;

/** MCP tool result shape (a CallToolResult). */
export function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Reads the credential bound to the CURRENT request. Injected so it is testable. */
export type AuthContextReader = () => { props?: { apiKey?: unknown } } | undefined;
type CallApiFn = typeof realCallApi;

export interface ToolDeps {
	apiBaseUrl: string;
	callApi: CallApiFn;
	/** Returns the auth context for the in-flight request (per request, never persisted). */
	getAuthContext: AuthContextReader;
}

/**
 * The handler for one proxied tool. The API key is read from the current request's
 * auth context on every call — there is no session state, so a call always runs under
 * the credential presented on THIS request.
 */
export function makeToolHandler(tool: ToolDefinition, deps: ToolDeps) {
	return async (args: Record<string, unknown> = {}) => {
		const apiKey = deps.getAuthContext()?.props?.apiKey;
		if (typeof apiKey !== "string" || apiKey.length === 0) {
			return textResult(
				"No MyNextAdventure API key was supplied with this connection. Connect the server through its OAuth flow, or add your key to the connector configuration (Authorization: Bearer <key>) and reconnect.",
				true,
			);
		}
		let request: ReturnType<typeof tool.resolve>;
		try {
			request = tool.resolve(args ?? {});
		} catch (error) {
			return textResult((error as Error).message, true);
		}
		const result = await deps.callApi(deps.apiBaseUrl, apiKey, request);
		return textResult(result.text, !result.ok);
	};
}

const CONNECTOR_INFO_TITLE = "Connector Info";

const CONNECTOR_INFO_DESCRIPTION =
	"Report which build of this connector you are talking to, and whether its tool schemas match the live API. Call this when a tool rejects a field you expect to exist, or accepts one that turns out to have no effect — clients cache tool schemas at connect time, so a connector can advertise an older contract than the API actually has. Takes no arguments and changes nothing.";

const CONNECTOR_INFO_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

/** Best-effort: a connector that cannot reach the API should still report its own build. */
export async function fetchLiveContractHash(apiBaseUrl: string): Promise<string | null> {
	try {
		const response = await fetch(`${apiBaseUrl}/v1/contract-hash`);
		if (!response.ok) return null;
		const body = (await response.json()) as { hash?: string };
		return body.hash ?? null;
	} catch {
		return null;
	}
}

export interface ConnectorInfoDeps {
	apiBaseUrl: string;
	version?: { id?: string; timestamp?: string };
	getLiveContractHash: (apiBaseUrl: string) => Promise<string | null>;
}

/**
 * Answered by the worker itself rather than proxied: the question is which build the
 * caller reached, so a round trip to the API cannot answer it. Needs no credential.
 */
export function makeConnectorInfoHandler(deps: ConnectorInfoDeps) {
	return async () => {
		const live = await deps.getLiveContractHash(deps.apiBaseUrl);
		const lines = [
			`Connector build: ${deps.version?.id ?? "unknown"}`,
			`Deployed at: ${deps.version?.timestamp ?? "unknown"}`,
			`Tool contract: ${CONTRACT_HASH}`,
			`API: ${deps.apiBaseUrl}`,
			`Live API contract: ${live ?? "could not be read"}`,
			`Tools advertised: ${TOOLS.length + 1}`,
		];
		if (live && live !== CONTRACT_HASH) {
			lines.push(
				"",
				"MISMATCH — this connector was generated from an older API contract than the one now live.",
				"Fields added since then are absent from the tool schemas you can see. Depending on your",
				"client, sending one anyway either errors or is dropped silently. Reconnect the connector",
				"to pick up the current schemas; if that does not change this line, the worker itself needs",
				"redeploying.",
			);
		} else if (live) {
			lines.push("", "Tool schemas match the live API contract.");
		}
		return textResult(lines.join("\n"));
	};
}

/** The bindings the MCP server reads: a slice of the worker's env, or set by hand over stdio. */
export interface McpServerEnv {
	MNA_API_BASE_URL?: string;
	CF_VERSION_METADATA?: { id?: string; timestamp?: string };
}

/**
 * Build a fresh MCP server for one request. Stateless: the credential is resolved
 * per request via `getMcpAuthContext()`, never stored on the server or a session.
 */
export function buildMcpServer(
	env: McpServerEnv,
	overrides?: Partial<ToolDeps>,
	telemetry?: Telemetry,
): McpServer {
	const apiBaseUrl = env?.MNA_API_BASE_URL || DEFAULT_API_BASE_URL;
	const deps: ToolDeps = {
		apiBaseUrl,
		callApi: realCallApi,
		getAuthContext: getMcpAuthContext,
		...overrides,
	};

	const server = new McpServer(
		{ name: "mynextadventure", title: "MyNextAdventure", version: "1.0.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			toRegisterToolConfig(tool),
			timeTool(tool.name, makeToolHandler(tool, deps), telemetry),
		);
	}

	server.registerTool(
		"connector_info",
		{
			title: CONNECTOR_INFO_TITLE,
			description: CONNECTOR_INFO_DESCRIPTION,
			inputSchema: z.object({}),
			annotations: { ...CONNECTOR_INFO_ANNOTATIONS, title: CONNECTOR_INFO_TITLE },
		},
		timeTool(
			"connector_info",
			makeConnectorInfoHandler({
				apiBaseUrl,
				version: env?.CF_VERSION_METADATA,
				getLiveContractHash: fetchLiveContractHash,
			}),
			telemetry,
		),
	);

	return server;
}
