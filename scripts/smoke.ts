#!/usr/bin/env node
/**
 * Drives the MCP protocol against a running server (local `wrangler dev` or
 * production) to verify the handshake, the tool list and one tool call.
 *
 *   npx tsx scripts/smoke.ts                                   # local, list_trips
 *   npx tsx scripts/smoke.ts --url https://mcp.mynextadventure.cloud/mcp
 *   npx tsx scripts/smoke.ts --tool get_trip --args '{"tripId":"..."}'
 *
 * The API key comes from $MNA_API_KEY or ~/.config/mna/credentials.
 * Only read-only tools are allowed unless --force is passed, so that a smoke
 * run can never create or mutate real trips.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const READ_ONLY_TOOLS = new Set(["whoami", "list_trips", "get_trip", "list_goals"]);

function arg(name: string, fallback?: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}

function apiKey(): string {
	if (process.env.MNA_API_KEY) return process.env.MNA_API_KEY;
	const path = join(homedir(), ".config", "mna", "credentials");
	try {
		return JSON.parse(readFileSync(path, "utf8")).apiKey as string;
	} catch {
		throw new Error(`Set $MNA_API_KEY or create ${path} with an apiKey field.`);
	}
}

async function main(): Promise<void> {
	const url = arg("url", "http://localhost:8787/mcp") as string;
	const toolName = arg("tool", "list_trips") as string;
	const toolArgs = JSON.parse(arg("args", "{}") as string);
	const force = process.argv.includes("--force");

	if (!READ_ONLY_TOOLS.has(toolName) && !force) {
		throw new Error(
			`"${toolName}" mutates data. Re-run with --force only if you are pointing at a throwaway account.`,
		);
	}

	const headers = { Authorization: `Bearer ${apiKey()}` };
	const requestInit = { headers };
	const transport = url.endsWith("/sse")
		? new SSEClientTransport(new URL(url), {
				requestInit,
				// The SSE GET is opened by EventSource, which cannot carry headers
				// unless we hand it a fetch of our own.
				eventSourceInit: {
					fetch: (input: string | URL | Request, init?: RequestInit) =>
						fetch(input, {
							...init,
							headers: { ...(init?.headers as Record<string, string>), ...headers },
						}),
				},
			})
		: new StreamableHTTPClientTransport(new URL(url), { requestInit });
	const client = new Client({ name: "mna-mcp-smoke", version: "1.0.0" });

	await client.connect(transport);
	const info = client.getServerVersion();
	console.log(`connected: ${info?.name} ${info?.version} @ ${url}`);

	const { tools } = await client.listTools();
	console.log(`tools/list -> ${tools.length} tools`);
	for (const tool of tools) {
		const required = (tool.inputSchema?.required as string[] | undefined) ?? [];
		console.log(
			`  ${tool.name.padEnd(28)} required: [${required.join(", ")}]  ${tool.description?.slice(0, 60)}…`,
		);
	}

	console.log(`\ntools/call ${toolName} ${JSON.stringify(toolArgs)}`);
	const result = await client.callTool({ name: toolName, arguments: toolArgs });
	const content = (result.content as Array<{ type: string; text?: string }>) ?? [];
	const text = content.map((part) => part.text ?? "").join("\n");
	console.log(`isError: ${result.isError === true}`);
	console.log(text.length > 2000 ? `${text.slice(0, 2000)}\n…(truncated)` : text);

	await client.close();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
