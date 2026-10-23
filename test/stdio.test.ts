import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { TOOLS } from "../src/generated/tools";

/**
 * The stdio entrypoint is what Glama's build check launches (behind mcp-proxy) to score
 * the server, so it must start with a placeholder key and list every tool without
 * reaching the API.
 */

let client: Client | undefined;

afterEach(async () => {
	await client?.close();
	client = undefined;
});

async function connect(env: Record<string, string>) {
	client = new Client({ name: "stdio-test", version: "1.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: "npx",
			args: ["tsx", "src/stdio.ts"],
			env: { PATH: process.env.PATH ?? "", ...env },
		}),
	);
	return client;
}

describe("stdio entrypoint", () => {
	it("lists every tool with a placeholder key", async () => {
		const mcp = await connect({ MNA_API_KEY: "mna_placeholder" });

		const { tools } = await mcp.listTools();

		expect(mcp.getServerVersion()?.name).toBe("mynextadventure");
		expect(tools.map((t) => t.name).sort()).toEqual(
			[...TOOLS.map((t) => t.name), "connector_info"].sort(),
		);
	}, 30_000);

	it("explains the missing key instead of calling the API", async () => {
		const mcp = await connect({});

		const result = await mcp.callTool({ name: "whoami", arguments: {} });

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("No MyNextAdventure API key");
	}, 30_000);
});
