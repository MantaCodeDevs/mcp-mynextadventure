import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { DEFAULT_API_BASE_URL, callApi } from "./api-client";
import { TOOLS } from "./generated/tools";

export interface Env {
	MNA_API_BASE_URL?: string;
}

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

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Build a fresh MCP server for one request. Stateless: there is no Durable Object and
 * no session storage. Each tool reads the caller's API key from the current request's
 * auth context (set from the request headers in `fetch`), so a call always runs under
 * the credential presented on THAT request.
 */
function buildServer(env: Env): McpServer {
	const apiBaseUrl = env?.MNA_API_BASE_URL || DEFAULT_API_BASE_URL;
	const server = new McpServer(
		{ name: "mynextadventure", title: "MyNextAdventure", version: "1.0.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: z.object(tool.inputShape) },
			async (args: Record<string, unknown> = {}) => {
				const apiKey = getMcpAuthContext()?.props?.apiKey;
				if (typeof apiKey !== "string" || apiKey.length === 0) {
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

	return server;
}

/**
 * Read the caller's MyNextAdventure API key. Clients that support bearer auth
 * (Claude Desktop via mcp-remote, claude.ai custom connectors) send it as
 * `Authorization: Bearer <key>`; clients that only allow custom headers can send
 * `X-API-Key: <key>` instead. Either way it is forwarded to the MyNextAdventure
 * API as `X-API-Key`. It is read fresh on every request and never persisted.
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
				endpoints: { streamableHttp: "/mcp" },
				auth: "Send your MyNextAdventure API key as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.",
			});
		}

		if (url.pathname !== "/mcp") {
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
				{ status: 401 },
			);
		}

		// The stateless handler resolves each tool call's credential from ctx.props,
		// so set it from this request's key before delegating.
		(ctx as { props?: { apiKey: string } }).props = { apiKey };
		return createMcpHandler(() => buildServer(env), { route: "/mcp" })(request, env, ctx);
	},
};
