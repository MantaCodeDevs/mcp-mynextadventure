import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadSpec, OUTPUT_PATH, renderToolsFile } from "../scripts/generate-tools";
import { buildUrl } from "../src/api-client";
import { TOOLS } from "../src/generated/tools";
import type { ApiRequest } from "../src/tool-types";

/**
 * One sample call per tool: the arguments an LLM would send, and the HTTP
 * request the worker must produce. This is the contract between the generated
 * tool definitions and the MyNextAdventure public API.
 */
const CASES: Array<{
	tool: string;
	args: Record<string, unknown>;
	expected: ApiRequest;
}> = [
	{
		tool: "whoami",
		args: {},
		expected: { method: "GET", path: "/v1/me" },
	},
	{
		tool: "list_trips",
		args: { status: "planning" },
		expected: {
			method: "GET",
			path: "/v1/trips",
			query: { includeExample: undefined, status: "planning" },
		},
	},
	{
		tool: "get_trip",
		args: { tripId: "trip-1", includeAllOptions: true },
		expected: {
			method: "GET",
			path: "/v1/trips/trip-1",
			query: { includeAllOptions: true },
		},
	},
	{
		tool: "create_trip",
		args: { data: { name: "Japan 2027" } },
		expected: { method: "POST", path: "/v1/trips", body: { name: "Japan 2027" } },
	},
	{
		tool: "update_trip",
		args: { tripId: "trip-1", data: { status: "ready" } },
		expected: {
			method: "PATCH",
			path: "/v1/trips/trip-1",
			body: { status: "ready" },
		},
	},
	{
		tool: "create_trip_share_link",
		args: { tripId: "trip-1" },
		expected: { method: "POST", path: "/v1/trips/trip-1/share-link" },
	},
	{
		tool: "create_variant",
		args: {
			tripId: "trip-1",
			data: {
				name: "Cherry blossom",
				dates: {
					startDate: "2027-04-01T00:00:00.000Z",
					endDate: "2027-04-14T00:00:00.000Z",
				},
			},
		},
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants",
			body: {
				name: "Cherry blossom",
				dates: {
					startDate: "2027-04-01T00:00:00.000Z",
					endDate: "2027-04-14T00:00:00.000Z",
				},
			},
		},
	},
	{
		tool: "duplicate_variant",
		args: { tripId: "trip-1", variantId: "variant-1" },
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants/variant-1/duplicate",
		},
	},
	{
		tool: "update_variant",
		args: { tripId: "trip-1", variantId: "variant-1", data: { name: "Plan B" } },
		expected: {
			method: "PATCH",
			path: "/v1/trips/trip-1/variants/variant-1",
			body: { name: "Plan B" },
		},
	},
	{
		tool: "select_variant",
		args: { tripId: "trip-1", variantId: "variant-1" },
		expected: {
			method: "PUT",
			path: "/v1/trips/trip-1/variants/variant-1/select",
		},
	},
	{
		tool: "add_destination",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			data: { destination: "Kyoto, Japan" },
		},
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants/variant-1/destinations",
			body: { destination: "Kyoto, Japan" },
		},
	},
	{
		tool: "update_destination",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			destinationKey: "destination-1",
			data: { notes: "Stay near Gion" },
		},
		expected: {
			method: "PATCH",
			path: "/v1/trips/trip-1/variants/variant-1/destinations/destination-1",
			body: { notes: "Stay near Gion" },
		},
	},
	{
		tool: "reorder_destinations",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			data: { order: ["destination-2", "destination-1"] },
		},
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants/variant-1/destinations/reorder",
			body: { order: ["destination-2", "destination-1"] },
		},
	},
	{
		tool: "add_accommodation_option",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			destinationKey: "destination-1",
			data: {
				name: "Hotel Granvia",
				type: "hotel",
				totalCost: 1200,
				currency: "EUR",
				location: { name: "Kyoto Station" },
				roomDetails: { numberOfRooms: 1 },
			},
		},
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants/variant-1/destinations/destination-1/options/accommodation",
			body: {
				name: "Hotel Granvia",
				type: "hotel",
				totalCost: 1200,
				currency: "EUR",
				location: { name: "Kyoto Station" },
				roomDetails: { numberOfRooms: 1 },
			},
		},
	},
	{
		tool: "add_transport_option",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			destinationKey: "destination-1",
			data: {
				totalCost: 780,
				currency: "EUR",
				transportType: "plane",
				roundTrip: true,
			},
		},
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants/variant-1/destinations/destination-1/options/transport",
			body: {
				totalCost: 780,
				currency: "EUR",
				transportType: "plane",
				roundTrip: true,
			},
		},
	},
	{
		tool: "add_getting_around_option",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			destinationKey: "destination-1",
			data: { type: "publicTransport", totalCost: 60, currency: "EUR" },
		},
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants/variant-1/destinations/destination-1/options/getting-around",
			body: { type: "publicTransport", totalCost: 60, currency: "EUR" },
		},
	},
	{
		tool: "update_destination_option",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			destinationKey: "destination-1",
			kind: "accommodation",
			optionKey: "option-1",
			data: { totalCost: 1100 },
		},
		expected: {
			method: "PATCH",
			path: "/v1/trips/trip-1/variants/variant-1/destinations/destination-1/options/accommodation/option-1",
			body: { totalCost: 1100 },
		},
	},
	{
		tool: "select_destination_option",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			destinationKey: "destination-1",
			optionId: "option-1",
		},
		expected: {
			method: "PUT",
			path: "/v1/trips/trip-1/variants/variant-1/destinations/destination-1/options/option-1/select",
		},
	},
	{
		tool: "add_event",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			data: { name: "Fushimi Inari at sunrise" },
		},
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants/variant-1/options/event",
			body: { name: "Fushimi Inari at sunrise" },
		},
	},
	{
		tool: "update_event",
		args: {
			tripId: "trip-1",
			variantId: "variant-1",
			eventKey: "event-1",
			data: { totalCost: 25, currency: "EUR" },
		},
		expected: {
			method: "PATCH",
			path: "/v1/trips/trip-1/variants/variant-1/events/event-1",
			body: { totalCost: 25, currency: "EUR" },
		},
	},
	{
		tool: "toggle_event",
		args: { tripId: "trip-1", variantId: "variant-1", eventKey: "event-1" },
		expected: {
			method: "POST",
			path: "/v1/trips/trip-1/variants/variant-1/events/event-1/toggle",
		},
	},
	{
		tool: "delete_trip_item",
		args: {
			target: "variant",
			tripId: "trip-1",
			variantId: "variant-1",
			confirm: true,
		},
		expected: { method: "DELETE", path: "/v1/trips/trip-1/variants/variant-1" },
	},
	{
		tool: "list_goals",
		args: { status: "dreaming" },
		expected: {
			method: "GET",
			path: "/v1/goals",
			query: {
				status: "dreaming",
				collection: undefined,
				tripId: undefined,
			},
		},
	},
	{
		tool: "add_goal",
		args: { data: { input: "See the Northern Lights" } },
		expected: {
			method: "POST",
			path: "/v1/goals/quick-add",
			body: { input: "See the Northern Lights" },
		},
	},
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

describe("tool definitions", () => {
	it("exposes a curated, uniquely named tool set", () => {
		expect(TOOLS.length).toBeGreaterThanOrEqual(15);
		expect(TOOLS.length).toBeLessThanOrEqual(25);
		expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
		for (const tool of TOOLS) {
			expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
			// Descriptions are what an LLM picks tools by — they must say more
			// than the tool name already does.
			expect(tool.description.length).toBeGreaterThan(80);
		}
	});

	it("only references operations that exist in the OpenAPI spec", () => {
		const spec = loadSpec();
		const operationIds = new Set<string>();
		for (const methods of Object.values(spec.paths)) {
			for (const operation of Object.values(methods)) {
				if (operation?.operationId) operationIds.add(operation.operationId);
			}
		}
		for (const tool of TOOLS) {
			for (const operationId of tool.operations) {
				expect(operationIds, `${tool.name} -> ${operationId}`).toContain(
					operationId,
				);
			}
		}
	});

	it("is regenerated from the current OpenAPI snapshot", () => {
		// Guards against hand-edits and against the spec drifting ahead of the
		// committed tools. Fix by running `npm run generate:tools`.
		expect(readFileSync(OUTPUT_PATH, "utf8")).toBe(renderToolsFile());
	});
});

describe("every tool builds the right request", () => {
	it("has a sample call for every tool", () => {
		expect(CASES.map((c) => c.tool).sort()).toEqual(
			TOOLS.map((t) => t.name).sort(),
		);
	});

	it.each(CASES)("$tool", ({ tool: name, args, expected }) => {
		const tool = byName.get(name);
		expect(tool, `unknown tool ${name}`).toBeDefined();
		if (!tool) return;

		// The sample arguments must satisfy the schema the model is handed.
		const parsed = z.object(tool.inputShape).parse(args);
		expect(parsed).toBeTruthy();

		const request = tool.resolve(args);
		expect(request.method).toBe(expected.method);
		expect(request.path).toBe(expected.path);
		expect(request.query ?? {}).toEqual(expected.query ?? {});
		expect(request.body).toEqual(expected.body);
	});
});

describe("grouped tools", () => {
	it("routes delete_trip_item to the right endpoint per target", () => {
		const tool = byName.get("delete_trip_item");
		if (!tool) throw new Error("missing tool");
		const base = { tripId: "t1", variantId: "v1" };

		expect(
			tool.resolve({ ...base, target: "destination", destinationKey: "d1" }).path,
		).toBe("/v1/trips/t1/variants/v1/destinations/d1");
		expect(
			tool.resolve({
				...base,
				target: "option",
				destinationKey: "d1",
				kind: "transport",
				optionKey: "o1",
			}).path,
		).toBe("/v1/trips/t1/variants/v1/destinations/d1/options/transport/o1");
		expect(tool.resolve({ ...base, target: "event", eventKey: "e1" }).path).toBe(
			"/v1/trips/t1/variants/v1/events/e1",
		);
	});

	it("refuses to delete a whole variant without an explicit confirmation", () => {
		const tool = byName.get("delete_trip_item");
		if (!tool) throw new Error("missing tool");
		const args = { target: "variant", tripId: "t1", variantId: "v1" };

		expect(() => tool.resolve(args)).toThrow(/set "confirm" to true/);
		expect(() => tool.resolve({ ...args, confirm: false })).toThrow(
			/set "confirm" to true/,
		);
		// Only the variant branch — the whole-subtree delete — is gated.
		expect(
			tool.resolve({ ...args, target: "event", eventKey: "e1" }).method,
		).toBe("DELETE");
	});

	it("explains which argument is missing instead of building a broken path", () => {
		const tool = byName.get("delete_trip_item");
		if (!tool) throw new Error("missing tool");
		expect(() =>
			tool.resolve({ tripId: "t1", variantId: "v1", target: "event" }),
		).toThrow(/"eventKey" is required when target is "event"/);
	});

	it("deselects when select_destination_option is called without an optionId", () => {
		const tool = byName.get("select_destination_option");
		if (!tool) throw new Error("missing tool");
		const request = tool.resolve({
			action: "deselect",
			tripId: "t1",
			variantId: "v1",
			destinationKey: "d1",
			kind: "accommodation",
		});
		expect(request).toEqual({
			method: "PUT",
			path: "/v1/trips/t1/variants/v1/destinations/d1/options/accommodation/deselect",
		});
	});

	it("defaults to selecting when no action is given", () => {
		const tool = byName.get("select_destination_option");
		if (!tool) throw new Error("missing tool");
		expect(
			tool.resolve({
				tripId: "t1",
				variantId: "v1",
				destinationKey: "d1",
				optionId: "o1",
			}).method,
		).toBe("PUT");
	});
});

describe("request building", () => {
	it("escapes path parameters", () => {
		const tool = byName.get("get_trip");
		if (!tool) throw new Error("missing tool");
		expect(tool.resolve({ tripId: "a/b c" }).path).toBe("/v1/trips/a%2Fb%20c");
	});

	it("drops empty query values and keeps the API base path", () => {
		expect(
			buildUrl("https://api.mynextadventure.cloud/", {
				method: "GET",
				path: "/v1/trips",
				query: { status: "planning", includeExample: undefined },
			}),
		).toBe("https://api.mynextadventure.cloud/v1/trips?status=planning");
	});

	it("serialises boolean query values", () => {
		expect(
			buildUrl("https://api.mynextadventure.cloud", {
				method: "GET",
				path: "/v1/trips/t1",
				query: { includeAllOptions: true },
			}),
		).toBe("https://api.mynextadventure.cloud/v1/trips/t1?includeAllOptions=true");
	});
});
