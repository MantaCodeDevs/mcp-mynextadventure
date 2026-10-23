import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildMcpServer } from "./mcp-server";

/**
 * Local stdio entrypoint, for clients that launch the server as a subprocess and for
 * Glama's build checks. Same tools as the hosted worker; the credential is the
 * MyNextAdventure API key in `MNA_API_KEY` instead of an OAuth token.
 */
const apiKey = process.env.MNA_API_KEY;

const server = buildMcpServer(
	{ MNA_API_BASE_URL: process.env.MNA_API_BASE_URL },
	{ getAuthContext: () => ({ props: { apiKey } }) },
);
server.connect(new StdioServerTransport());
