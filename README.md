# MyNextAdventure MCP server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI
assistant plan trips in [MyNextAdventure](https://mynextadventure.cloud) — create a trip,
lay out the itinerary, propose flights and hotels, add things to do, and share the result.

It runs as a Cloudflare Worker (Durable Object backed) and is a thin, authenticated proxy in
front of the MyNextAdventure public API: it holds no trip data of its own, and forwards every
call to the API under the caller's own API key.

- **Production:** `https://mcp.mynextadventure.cloud/sse` (also `…/mcp` for Streamable HTTP)
- **Upstream API:** `https://api.mynextadventure.cloud` (v1 public API)

## Authentication

Every request needs a MyNextAdventure API key. Create one in the app under
**Settings → API keys**, then send it as either:

- `Authorization: Bearer <api-key>` — what most MCP clients send, and what `mcp-remote` does, or
- `X-API-Key: <api-key>` — for clients that only let you set custom headers.

The worker forwards it to the API as `X-API-Key`. Requests without a key get a `401`.
Whatever the key can do, the assistant can do: keys are per-user, so the assistant only ever
sees that user's trips.

**Where your key lives.** Each MCP connection gets its own Durable Object session, and the
agents SDK persists that session's props — including your key — to the session's storage so it
survives the worker hibernating between messages. In other words the key is held for the
duration of your session in isolated per-session storage, and passed through to the
MyNextAdventure API; it is never logged and is not shared between sessions or users. Revoke a
key any time in the app under Settings → API keys.

## Tools

24 tools, covering the operations conversational planning actually needs. Each one is a
curated view over a MyNextAdventure API operation — see [Regenerating the tools](#regenerating-the-tools).

| Tool | What it does |
| --- | --- |
| `whoami` | Which account the API key belongs to (handy for checking the connection). |
| `list_trips` | List the user's trips; filter by status (`planning`, `ready`, `finished`, `cancelled`). |
| `get_trip` | One trip in full — variants, destinations, options, events. Needed before any edit. |
| `create_trip` | Create a new, empty trip. |
| `update_trip` | Rename, set a cover photo, or move the trip through its lifecycle. |
| `create_trip_share_link` | Create/refresh a public read-only share link. |
| `create_variant` | Add an alternative plan (dates live here: exact or flexible). |
| `duplicate_variant` | Copy a variant with everything in it. |
| `update_variant` | Rename a variant, change its dates or notes. |
| `select_variant` | Mark a variant as the chosen plan. |
| `add_destination` | Add a stop to a variant, in itinerary order. |
| `update_destination` | Change a stop's place name, dates or notes. |
| `reorder_destinations` | Reorder the stops in a variant. |
| `add_accommodation_option` | Propose a place to stay at a destination. |
| `add_transport_option` | Propose a way of getting to a destination. |
| `add_getting_around_option` | Propose local mobility (public transport, rental car, …). |
| `update_destination_option` | Edit an existing option of any of the three kinds. |
| `select_destination_option` | Select — or, with no `optionId`, deselect — an option. |
| `add_event` | Add an activity (museum, concert, restaurant, tour) to a variant. |
| `update_event` | Edit an activity. |
| `toggle_event` | Flip an activity between committed and "just an idea". |
| `delete_trip_item` | Permanently delete a variant, destination, option or event. Deleting a whole variant additionally requires `confirm: true`. |
| `list_goals` | List the user's travel goals / bucket list. |
| `add_goal` | Add a goal from a name or a URL. |

The server also ships MCP `instructions` describing the data model
(`trip → variants → destinations → options`, with events on the variant) and the usual
order of operations, so a client does not have to guess the workflow.

Not exposed yet, though the API supports them: collaborator access management and invites,
voting, collections, invite tokens, goal↔trip linking, API key management, and trip deletion.

## Connecting

### Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "mynextadventure": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.mynextadventure.cloud/sse",
        "--header",
        "Authorization: Bearer ${MNA_API_KEY}"
      ],
      "env": { "MNA_API_KEY": "your-api-key" }
    }
  }
}
```

Restart Claude Desktop; the tools appear under the connector.

### claude.ai / Claude Code

Add a custom connector pointing at `https://mcp.mynextadventure.cloud/mcp` and set the
`Authorization: Bearer <api-key>` header. From Claude Code:

```bash
claude mcp add --transport http mynextadventure https://mcp.mynextadventure.cloud/mcp \
  --header "Authorization: Bearer <api-key>"
```

### ChatGPT

Settings → Connectors → Add custom connector, MCP server URL
`https://mcp.mynextadventure.cloud/mcp`, authentication "custom header" with
`X-API-Key: <api-key>` (or `Authorization: Bearer <api-key>`).

### Any other MCP client

Streamable HTTP at `/mcp`, legacy SSE at `/sse`. `GET /` returns a small JSON health
document with the endpoint list and tool count.

## Development

```bash
npm install
npm run dev              # wrangler dev on http://localhost:8787
npm test                 # vitest: request building, schemas, generator freshness
npm run type-check       # tsc --noEmit
npm run generate:tools   # regenerate src/generated/tools.ts from the OpenAPI spec
npx tsx scripts/smoke.ts # drive the MCP protocol against localhost:8787
```

`scripts/smoke.ts` performs a real handshake (initialize → `tools/list` → one `tools/call`),
reading the API key from `$MNA_API_KEY` or `~/.config/mna/credentials`. It refuses to call
mutating tools unless `--force` is passed. To exercise write tools without touching real
data, point the worker at a local mock:

```bash
npx wrangler dev --var MNA_API_BASE_URL:http://localhost:8899
```

### Regenerating the tools

Tool schemas are **generated**, not hand-written:

```
apps/server/openapi-v1.json   (the API's OpenAPI snapshot, kept fresh by server CI)
        +
scripts/tool-manifest.ts      (which operations become tools, their names and descriptions)
        ↓  scripts/generator.ts
src/generated/tools.ts        (committed; zod input schemas + request builders)
```

To add or change a tool, edit `scripts/tool-manifest.ts` and run `npm run generate:tools`.
Never edit `src/generated/tools.ts` by hand — a test fails if it drifts from the spec.

A manifest entry names one API operation, or groups several body-less operations behind a
discriminator argument (`delete_trip_item`'s `target`, `select_destination_option`'s
`action`) to keep the tool count down. Path params can be renamed (`id` → `tripId`), query
params can be narrowed to enums, and descriptions can be overridden — everything else,
including the request-body schemas, comes from the spec.

### Deployment

`npm run deploy` (wrangler) — production only, so it is gated on a maintainer; CI never
deploys this worker.

## Development

```
npm ci
npm run type-check
npm test        # includes a drift test: src/generated/tools.ts must match the generator output
npm run dev     # wrangler dev
```

Tools are generated from the vendored OpenAPI snapshot in `spec/openapi-v1.json`
(canonical live spec: https://api.mynextadventure.cloud/api/v1/openapi.json) via
`scripts/generate-tools.ts`. Regenerate after refreshing the snapshot.

This repo is the deployable source for `mcp.mynextadventure.cloud`. Development also
happens in the My Next Adventure monorepo and is synced here on release. Issues and
PRs welcome.

## License

MIT
