import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { callApi, DEFAULT_API_BASE_URL } from "./api-client";
import { TOOLS } from "./generated/tools";

export interface Env {
	MNA_API_BASE_URL?: string;
	MCP_OBJECT: DurableObjectNamespace;
}

/** Per-connection state: the caller's MyNextAdventure API key. */
type Props = { apiKey: string };

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
Prefer selecting/deselecting and toggling over delete_trip_item, which is permanent.`;

export class MyMCP extends McpAgent<Env, unknown, Props> {
	server = new McpServer(
		{
			name: "mynextadventure",
			title: "MyNextAdventure",
			version: "1.0.0",
		},
		{ instructions: SERVER_INSTRUCTIONS },
	);

	async init() {
		const apiBaseUrl = this.env?.MNA_API_BASE_URL || DEFAULT_API_BASE_URL;

		for (const tool of TOOLS) {
			this.server.tool(
				tool.name,
				tool.description,
				tool.inputShape,
				async (args: Record<string, unknown>) => {
					const apiKey = this.props?.apiKey;
					if (!apiKey) {
						return textResult(
							"No MyNextAdventure API key was supplied with this connection. Add your key to the connector configuration (Authorization: Bearer <key>) and reconnect.",
							true,
						);
					}

					let request: ReturnType<typeof tool.resolve>;
					try {
						request = tool.resolve(args ?? {});
					} catch (error) {
						return textResult((error as Error).message, true);
					}

					const result = await callApi(apiBaseUrl, apiKey, request);
					return textResult(result.text, !result.ok);
				},
			);
		}
	}
}

function textResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
	};
}

/**
 * Read the caller's MyNextAdventure API key. Clients that support bearer auth
 * (Claude Desktop via mcp-remote, claude.ai custom connectors) send it as
 * `Authorization: Bearer <key>`; clients that only allow custom headers can send
 * `X-API-Key: <key>` instead. Either way it is forwarded to the MyNextAdventure
 * API as `X-API-Key`.
 *
 * The key becomes this connection's Durable Object props, which the agents SDK
 * persists to the session's own storage for the lifetime of that session, so it
 * survives hibernation. It is never logged and never leaves the session.
 */
function readApiKey(request: Request): string | undefined {
	const authHeader = request.headers.get("authorization");
	if (authHeader?.toLowerCase().startsWith("bearer ")) {
		const token = authHeader.slice("bearer ".length).trim();
		if (token) return token;
	}
	const apiKeyHeader = request.headers.get("x-api-key")?.trim();
	return apiKeyHeader || undefined;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/" || url.pathname === "/health") {
			return Response.json({
				name: "mynextadventure-mcp",
				status: "ok",
				tools: TOOLS.length,
				endpoints: { streamableHttp: "/mcp", sse: "/sse" },
				auth: "Send your MyNextAdventure API key as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.",
			});
		}

		const isMcpPath =
			url.pathname === "/sse" ||
			url.pathname === "/sse/message" ||
			url.pathname === "/mcp";
		if (!isMcpPath) {
			return new Response("Not found", { status: 404 });
		}

		const apiKey = readApiKey(request);
		if (!apiKey) {
			return Response.json(
				{
					error: "unauthorized",
					message:
						"Missing MyNextAdventure API key. Send it as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'. Create a key at https://app.mynextadventure.cloud under Settings -> API keys.",
				},
				// Deliberately no WWW-Authenticate header: it is the MCP/OAuth
				// discovery trigger, and clients that can only do custom-header
				// auth should not be nudged into an OAuth flow this server does
				// not implement.
				{ status: 401 },
			);
		}

		ctx.props = { apiKey } satisfies Props;

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}
		return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
	},
};
