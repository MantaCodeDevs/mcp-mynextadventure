import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/generated/tools";
import type { ToolAnnotations } from "../src/tool-types";

/**
 * The authoritative classification of every tool, written out by hand rather
 * than derived from the manifest presets — so a preset applied to the wrong
 * tool fails here instead of shipping.
 *
 * Columns are the four MCP `ToolAnnotations` hints in spec order:
 * readOnlyHint, destructiveHint, idempotentHint, openWorldHint.
 *
 * These are not cosmetic. Clients decide what to run unattended and what to
 * put behind a confirmation prompt from these values, and connector-directory
 * reviews check them against what the tool actually does.
 */
const EXPECTED: Record<string, ToolAnnotations> = {
	// --- reads: never touch stored data ------------------------------------
	// whoami / list_trips / get_trip resolve profiles through Kinde (and
	// get_trip can hit Google Places and currency conversion), hence openWorld.
	whoami: read({ openWorld: true }),
	list_trips: read({ openWorld: true }),
	get_trip: read({ openWorld: true }),
	list_goals: read(),

	// --- creates: a second identical call adds a second record --------------
	create_trip: write({ idempotent: false }),
	create_variant: write({ idempotent: false }),
	duplicate_variant: write({ idempotent: false }),
	add_destination: write({ idempotent: false }),
	add_getting_around_option: write({ idempotent: false }),
	add_goal: write({ idempotent: false }),
	// These three resolve a googlePlaceId through Google Places when one is
	// supplied, so their world is open.
	add_accommodation_option: write({ idempotent: false, openWorld: true }),
	add_transport_option: write({ idempotent: false, openWorld: true }),
	add_event: write({ idempotent: false, openWorld: true }),

	// --- updates and selections: converge on re-run -------------------------
	update_trip: write({ idempotent: true }),
	update_variant: write({ idempotent: true }),
	select_variant: write({ idempotent: true }),
	update_destination: write({ idempotent: true }),
	// Sends an absolute order, not a relative move.
	reorder_destinations: write({ idempotent: true }),
	// Assignment, not a toggle; deselect sets the field to null.
	select_destination_option: write({ idempotent: true }),
	// The API returns the existing share token instead of minting a new one.
	create_trip_share_link: write({ idempotent: true }),
	update_destination_option: write({ idempotent: true, openWorld: true }),
	update_event: write({ idempotent: true, openWorld: true }),

	// --- the odd one out ----------------------------------------------------
	// Flips `selected`, so calling it twice returns the event to where it began.
	toggle_event: write({ idempotent: false }),

	// --- the only destructive tool -----------------------------------------
	delete_trip_item: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
};

function read({ openWorld = false } = {}): ToolAnnotations {
	return {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: openWorld,
	};
}

function write({
	idempotent,
	openWorld = false,
}: { idempotent: boolean; openWorld?: boolean }): ToolAnnotations {
	return {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: idempotent,
		openWorldHint: openWorld,
	};
}

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

describe("tool annotations", () => {
	it("covers every tool, and only tools that exist", () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(TOOLS.map((t) => t.name).sort());
	});

	it("states all four hints explicitly on every tool", () => {
		// The MCP defaults are the pessimistic ones (destructiveHint defaults to
		// true, openWorldHint to true), so an omitted hint is a real regression:
		// clients would prompt for confirmation on every write.
		for (const tool of TOOLS) {
			expect(tool.annotations, tool.name).toBeDefined();
			for (const hint of [
				"readOnlyHint",
				"destructiveHint",
				"idempotentHint",
				"openWorldHint",
			] as const) {
				expect(typeof tool.annotations[hint], `${tool.name}.${hint}`).toBe("boolean");
			}
		}
	});

	it.each(Object.entries(EXPECTED))("%s is classified correctly", (name, expected) => {
		const tool = byName.get(name);
		expect(tool, `unknown tool ${name}`).toBeDefined();
		expect(tool?.annotations).toEqual(expected);
	});

	it("keeps read tools on GET and write tools off it", () => {
		// Cross-check the readOnlyHint claim against the HTTP verb the tool
		// actually issues, so the hint cannot drift away from the request.
		for (const tool of TOOLS) {
			const method = sampleMethod(tool.name);
			if (tool.annotations.readOnlyHint) {
				expect(method, `${tool.name} claims readOnly`).toBe("GET");
			} else {
				expect(method, `${tool.name} claims it writes`).not.toBe("GET");
			}
		}
	});

	it("marks exactly one tool destructive, and gates it behind a confirmation", () => {
		const destructive = TOOLS.filter((t) => t.annotations.destructiveHint);
		expect(destructive.map((t) => t.name)).toEqual(["delete_trip_item"]);
		// destructiveHint is only meaningful when the tool is not read-only.
		for (const tool of destructive) {
			expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
		}
		// The one destructive branch that cascades still refuses to run blind.
		const del = byName.get("delete_trip_item");
		expect(() => del?.resolve({ target: "variant", tripId: "t1", variantId: "v1" })).toThrow(
			/set "confirm" to true/,
		);
	});

	it("never claims a tool is both read-only and destructive", () => {
		for (const tool of TOOLS) {
			if (tool.annotations.readOnlyHint) {
				expect(tool.annotations.destructiveHint, tool.name).toBe(false);
			}
		}
	});

	it("splits into the expected read / write / destructive counts", () => {
		const readOnly = TOOLS.filter((t) => t.annotations.readOnlyHint);
		expect(readOnly.map((t) => t.name).sort()).toEqual([
			"get_trip",
			"list_goals",
			"list_trips",
			"whoami",
		]);
		expect(TOOLS.length - readOnly.length).toBe(20);
		expect(TOOLS.filter((t) => t.annotations.destructiveHint)).toHaveLength(1);
	});
});

/** The HTTP method a tool resolves to, using minimal valid arguments. */
function sampleMethod(name: string): string {
	const tool = byName.get(name);
	if (!tool) throw new Error(`unknown tool ${name}`);
	const args: Record<string, unknown> = {
		tripId: "t1",
		variantId: "v1",
		destinationKey: "d1",
		optionKey: "o1",
		optionId: "o1",
		eventKey: "e1",
		kind: "accommodation",
		// delete_trip_item's guarded branch.
		confirm: true,
	};
	// Grouped tools need their discriminator; the defaults below pick a branch
	// that exercises the same verb as every other branch of that tool.
	if (name === "delete_trip_item") args.target = "event";
	return tool.resolve(args).method;
}
