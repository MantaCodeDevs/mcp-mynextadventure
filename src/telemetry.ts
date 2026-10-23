/**
 * Anonymous usage counts for the connector, written server-side into Workers Analytics
 * Engine (dataset `mantacode_events`, shared by every Manta Code product, same layout):
 *
 *   index1 product   blob1 product  blob2 event  blob3 a  blob4 b  blob5 lang  blob6 device
 *   blob7 country    blob8 referrer blob9 source blob10 session    blob11 version
 *   double1 value    double2 n
 *
 * Two events: `mcp_session` (a = the client's self-reported name from `initialize`) and
 * `mcp_tool` (a = tool name, value = duration in ms, n = 1 ok / 0 error). b is always the
 * client family read from the User-Agent. The user, the credential, the raw User-Agent,
 * tool arguments and results are never written.
 */

export interface EventsBinding {
	writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface Telemetry {
	toolCall(tool: string, durationMs: number, ok: boolean): void;
	session(clientName: string): void;
}

const PRODUCT = "mna-mcp";

/** Ordered: the first match wins, so specific families come before generic runtimes. */
const CLIENT_FAMILIES: [RegExp, string][] = [
	[/claude|anthropic/i, "claude"],
	[/chatgpt|openai/i, "chatgpt"],
	[/cursor/i, "cursor"],
	[/visual studio code|vscode/i, "vscode"],
	[/windsurf|codeium/i, "windsurf"],
	[/cline/i, "cline"],
	[/^node|undici/i, "node"],
	[/python|httpx|aiohttp/i, "python"],
];

export function clientFamily(userAgent: string | null): string {
	if (!userAgent) return "unknown";
	return CLIENT_FAMILIES.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "other";
}

/** A client's self-reported name, reduced to something safe to count by. */
export function sanitizeClientName(name: unknown): string {
	if (typeof name !== "string") return "unknown";
	const safe = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.slice(0, 40);
	return safe || "unknown";
}

export function makeTelemetry(
	events: EventsBinding | undefined,
	request: Request,
	version: string | undefined,
): Telemetry {
	const family = clientFamily(request.headers.get("User-Agent"));
	const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? "";

	const write = (event: string, a: string, value: number, n: number) => {
		try {
			events?.writeDataPoint({
				indexes: [PRODUCT],
				blobs: [
					PRODUCT,
					event,
					a,
					family,
					"",
					"server",
					country,
					"",
					"",
					"",
					version ?? "",
				],
				doubles: [value, n],
			});
		} catch {
			// Counting must never break a tool call.
		}
	};

	return {
		toolCall: (tool, durationMs, ok) => write("mcp_tool", tool, durationMs, ok ? 1 : 0),
		session: (clientName) => write("mcp_session", clientName, 0, 1),
	};
}

type ToolResult = { content?: unknown; isError?: boolean };

/** Wrap a tool handler so each call is counted with its duration and outcome. */
export function timeTool<A, R extends ToolResult>(
	tool: string,
	handler: (args: A) => Promise<R>,
	telemetry: Telemetry | undefined,
): (args: A) => Promise<R> {
	return async (args) => {
		const started = Date.now();
		let ok = false;
		try {
			const result = await handler(args);
			ok = !result.isError;
			return result;
		} finally {
			telemetry?.toolCall(tool, Date.now() - started, ok);
		}
	};
}

/**
 * Count each `initialize` in a streamable-http POST. The handler is stateless, so the
 * client's name only travels on this one message; tool calls fall back to the family.
 * Reads a clone, so the request stays intact for the MCP handler.
 */
export async function reportSessions(request: Request, telemetry: Telemetry): Promise<void> {
	if (request.method !== "POST") return;
	try {
		const body: unknown = await request.clone().json();
		const messages = Array.isArray(body) ? body : [body];
		for (const message of messages) {
			if (message?.method === "initialize") {
				telemetry.session(sanitizeClientName(message.params?.clientInfo?.name));
			}
		}
	} catch {
		// Not JSON-RPC we can read: nothing to count.
	}
}
