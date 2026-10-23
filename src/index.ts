import { createMcpHandler } from "agents/mcp/server";
import { TOOLS } from "./generated/tools";
import { buildMcpServer } from "./mcp-server";

export interface Env {
	MNA_API_BASE_URL?: string;
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
		return createMcpHandler(() => buildMcpServer(env), { route: "/mcp" })(request, env, ctx);
	},
};
