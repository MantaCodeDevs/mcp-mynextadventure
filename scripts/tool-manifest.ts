/**
 * Curated mapping from OpenAPI operations to MCP tools.
 *
 * The OpenAPI spec (spec/openapi-v1.json) exposes 59 operations across
 * 43 paths. Handing all of them to an LLM client is counter-productive, so this
 * manifest picks the operations that conversational trip planning actually
 * needs, gives them model-facing names and "when to use this" descriptions, and
 * occasionally groups several operations behind one tool (see `discriminator`).
 *
 * Schemas are NOT written here — `generator.ts` derives them from the spec.
 */

import type { ToolAnnotations } from "../src/tool-types";

export type { ToolAnnotations };

export interface ParamOverride {
	/** Override the spec's `required` flag (NestJS marks every query param required). */
	required?: boolean;
	description?: string;
	/** Narrow a plain string param to an enum. */
	enum?: string[];
}

/**
 * Fields every tool carries, whatever shape it has.
 *
 * `annotations` is deliberately required: the MCP spec defaults are the
 * pessimistic ones, and a tool that silently inherits `destructiveHint: true`
 * gets confirmation-prompted by clients for no reason. See `ToolAnnotations`
 * in src/tool-types.ts for the per-field semantics, and the "How the
 * annotations below were decided" note above TOOL_MANIFEST for our rules.
 */
interface BaseTool {
	name: string;
	/** Human-readable name shown in client UIs; the Claude directory requires one. */
	title: string;
	description: string;
	annotations: ToolAnnotations;
}

export interface SingleOpTool extends BaseTool {
	operationId: string;
	/** Rename spec path params, e.g. `{ id: "tripId" }`. */
	rename?: Record<string, string>;
	paramOverrides?: Record<string, ParamOverride>;
	/** Merge the members of a `oneOf` request body into one flat object. */
	mergeBodyUnion?: boolean;
	/** Description for the nested `data` (request body) argument. */
	bodyDescription?: string;
	/** Override descriptions of individual request-body properties. */
	bodyPropertyDescriptions?: Record<string, string>;
}

export interface GroupedTool extends BaseTool {
	/** Argument the model sets to pick which underlying operation runs. */
	discriminator: {
		name: string;
		description: string;
		/**
		 * discriminator value -> operationId. Request-body properties of a
		 * grouped operation are flattened into top-level tool arguments, so
		 * `rename` can line a body field up with a path param of another case.
		 */
		cases: Record<string, string>;
		/** When omitted the discriminator itself is optional (see select_destination_option). */
		optional?: boolean;
		/** Value implied when the discriminator is omitted. */
		defaultCase?: string;
	};
	rename?: Record<string, string>;
	paramOverrides?: Record<string, ParamOverride>;
	/**
	 * Extra confirmation flags for destructive branches: the named boolean must
	 * be `true` or the call is rejected before any HTTP request is made.
	 */
	caseGuards?: Record<string, { name: string; description: string }>;
}

export type ToolSpec = SingleOpTool | GroupedTool;

export function isGrouped(tool: ToolSpec): tool is GroupedTool {
	return "discriminator" in tool;
}

/** Descriptions for path params, which the OpenAPI spec does not document. */
export const PATH_PARAM_DESCRIPTIONS: Record<string, string> = {
	tripId: "Id of the trip, as returned by list_trips or get_trip.",
	variantId:
		"Id of the trip variant (an alternative version of the trip), from get_trip.",
	destinationKey:
		'Key of the destination inside the variant, from get_trip (e.g. "destination-1").',
	optionId:
		"Key of the accommodation / transport / getting-around option, from get_trip. Same value that other tools call optionKey — the API names it inconsistently.",
	optionKey:
		"Key of the accommodation / transport / getting-around option, from get_trip. Same value that select_destination_option calls optionId — the API names it inconsistently.",
	eventKey: "Key of the event on the variant, from get_trip.",
	goalId: "Id of the travel goal, from list_goals.",
	kind: "Which kind of destination option this is.",
};

const OPTION_KIND_ENUM = ["accommodation", "transport", "getting-around"];

// ------------------------------------------------------------- annotations
//
// How the annotations below were decided. Every tool states all four hints
// explicitly (see ToolAnnotations in src/tool-types.ts); these presets exist so
// the intent is legible at each call site, not to hide the values. The
// authoritative expected table lives in test/annotations.test.ts, written out
// tool by tool so a mis-applied preset here fails the build.
//
// readOnlyHint    — true for the GET-backed lookups, false for everything that
//                   writes to a trip.
// destructiveHint — true only for delete_trip_item. Every other write is
//                   additive or an in-place field edit that the user can redo;
//                   nothing else removes a record. Note the spec default is
//                   `true`, so this is the hint most worth stating.
// idempotentHint  — true where re-running with identical arguments genuinely
//                   lands on the same state. That means the PATCH updates, the
//                   PUT selections (straight assignments, not toggles),
//                   reorder_destinations (it sends an absolute order),
//                   delete_trip_item (already-gone stays gone) and
//                   create_trip_share_link (the API returns the existing token
//                   rather than minting a second one). It is false for every
//                   create/add — a second call adds a second record — and false
//                   for toggle_event, which flips a boolean, so calling it
//                   twice returns the event to where it started.
// openWorldHint   — true for the tools that can make an outbound third-party
//                   call while serving the request: Google Places lookups when
//                   an option carries a googlePlaceId, plus the Kinde profile
//                   fetch and currency conversion behind the read tools.
//                   Everything else is pure MyNextAdventure storage, i.e. a
//                   closed domain. Verified against the API server, not assumed.

const READ: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

/** Adds a record. Running it again adds another one. */
const CREATE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};

/** Sets fields (or a selection) to the values given — converges on re-run. */
const UPDATE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

/** Flips a flag — a second call undoes the first, so it is NOT idempotent. */
const TOGGLE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};

/** Removes data for good. */
const DELETE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
};

/** Same behaviour, but the request can reach a third-party API on the way. */
const openWorld = (base: ToolAnnotations): ToolAnnotations => ({
	...base,
	openWorldHint: true,
});

export const TOOL_MANIFEST: ToolSpec[] = [
	// ---------------------------------------------------------------- account
	{
		name: "whoami",
		title: "Who Am I",
		description:
			"Check which MyNextAdventure account the current API key belongs to. Use this when you are unsure whether the connection is authenticated, or to confirm whose trips you are about to change before making edits.",
		operationId: "MeV1Controller_getMe",
		annotations: openWorld(READ),
	},

	// ------------------------------------------------------------------ trips
	{
		name: "list_trips",
		title: "List Trips",
		description:
			"List the trips the user owns or collaborates on. Start here whenever the user refers to a trip by name (\"my Japan trip\") so you can resolve it to a trip id. Statuses: 'planning' is actively being worked on, 'ready' is planned but not taken yet, 'finished' is in the past, 'cancelled' was dropped. Call with no filters to see everything.",
		operationId: "TripsV1Controller_findAll",
		annotations: openWorld(READ),
		paramOverrides: {
			includeExample: {
				required: false,
				description:
					"Include the built-in example trip in the results. Leave unset for real trips only.",
			},
			status: {
				required: false,
				enum: ["planning", "ready", "finished", "cancelled"],
				description: "Only return trips in this lifecycle status.",
			},
		},
	},
	{
		name: "get_trip",
		title: "Get Trip",
		description:
			"Fetch one trip in full: its variants, destinations, accommodation / transport / getting-around options and events. Call this before changing anything — every other tool needs the variant ids, destination keys and option keys this returns.",
		operationId: "TripsV1Controller_findOne",
		annotations: openWorld(READ),
		rename: { id: "tripId" },
		paramOverrides: {
			includeAllOptions: {
				required: false,
				description:
					"Also return the options that are not currently selected. Set true when comparing alternatives.",
			},
		},
	},
	{
		name: "create_trip",
		title: "Create Trip",
		description:
			"Create a new, empty trip — the container everything else hangs off. This is step 1 of planning: create the trip, then create_variant for the dates, then add_destination, then the accommodation / transport / event options. Ask the user for a name if they have not given one.",
		operationId: "TripWritesV1Controller_create",
		annotations: CREATE,
		bodyDescription: "The new trip's details.",
	},
	{
		name: "update_trip",
		title: "Update Trip",
		description:
			"Change top-level trip fields: rename it, set a cover photo, or move it through its lifecycle (planning -> ready once the plan is settled, finished or cancelled afterwards). Does not touch variants, destinations or options.",
		operationId: "TripWritesV1Controller_update",
		annotations: UPDATE,
		rename: { id: "tripId" },
		bodyDescription: "Fields to change. Omitted fields are left as they are.",
	},
	{
		name: "create_trip_share_link",
		title: "Create Trip Share Link",
		description:
			"Create (or refresh) a public read-only link to the trip so the user can send the plan to people without an account. Returns the shareable URL. Use when the user asks to share, send or publish a trip.",
		operationId: "TripWritesV1Controller_createShareLink",
		annotations: UPDATE,
		rename: { id: "tripId" },
	},

	// --------------------------------------------------------------- variants
	{
		name: "create_variant",
		title: "Create Variant",
		description:
			"Add an alternative version of the trip — \"Beach option\" vs \"Mountain option\", or the same route on different dates. A trip needs at least one variant before it can hold destinations or options, so create one right after create_trip. Dates live on the variant: either exact start/end dates or a flexible window with min/max nights.",
		operationId: "VariantsV1Controller_create",
		annotations: CREATE,
		rename: { id: "tripId" },
		bodyDescription: "The new variant's name, dates and notes.",
	},
	{
		name: "duplicate_variant",
		title: "Duplicate Variant",
		description:
			"Copy a variant, with all of its destinations and options, into a new variant on the same trip. Use when the user wants to explore a tweak (\"same trip but a week later\", \"same route, cheaper hotels\") without losing the original.",
		operationId: "VariantsV1Controller_duplicate",
		annotations: CREATE,
		rename: { id: "tripId" },
	},
	{
		name: "update_variant",
		title: "Update Variant",
		description:
			"Rename a variant, change its dates (exact dates or a flexible window), edit its notes, or set who is travelling. Returns the variant as it now stands — read the response to confirm your change landed rather than assuming it did.",
		operationId: "VariantsV1Controller_update",
		annotations: UPDATE,
		rename: { id: "tripId" },
		bodyDescription: "Fields to change. Omitted fields are left as they are.",
	},
	{
		name: "select_variant",
		title: "Select Variant",
		description:
			"Mark one variant as the trip's chosen plan. Use when the user decides between alternatives; the choice is reversible, so selecting a different variant later is fine.",
		operationId: "TripsV1Controller_selectVariant",
		annotations: UPDATE,
		rename: { id: "tripId" },
	},

	// ----------------------------------------------------------- destinations
	{
		name: "add_destination",
		title: "Add Destination",
		description:
			"Add a place the traveller will stay at within a variant, in itinerary order (e.g. \"Lisbon, Portugal\"). Destinations are what accommodation, transport and getting-around options attach to, so add these before adding options. Set isReturnToHome for the final leg home.",
		operationId: "DestinationsV1Controller_create",
		annotations: CREATE,
		rename: { id: "tripId" },
		bodyDescription: "The destination to add.",
	},
	{
		name: "update_destination",
		title: "Update Destination",
		description:
			"Change a destination's place name, its arrival/departure dates, or its notes. Use this to pin down when the traveller is in each place once the dates firm up, rather than deleting and re-adding the stop.",
		operationId: "DestinationsV1Controller_update",
		annotations: UPDATE,
		rename: { id: "tripId" },
		bodyDescription: "Fields to change. Omitted fields are left as they are.",
	},
	{
		name: "reorder_destinations",
		title: "Reorder Destinations",
		description:
			"Rearrange the itinerary order of a variant's destinations. Use after adding stops out of order, instead of deleting and re-adding them.",
		operationId: "DestinationsV1Controller_reorder",
		annotations: UPDATE,
		rename: { id: "tripId" },
		bodyDescription: "The desired destination order.",
	},

	// ------------------------------------------------------- options (create)
	{
		name: "add_accommodation_option",
		title: "Add Accommodation Option",
		description:
			"Propose somewhere to stay at a destination — hotel, hostel, apartment, house or camping. Add several options to the same destination so the user can compare them, then use select_destination_option once they pick one. Always include the total cost and currency, otherwise the trip budget will be wrong. Keep name a clean display name — price, town, dates and commentary belong in their own fields, not in name.",
		operationId: "TripsV1Controller_addAccommodationOption",
		annotations: openWorld(CREATE),
		rename: { id: "tripId" },
		bodyDescription: "The accommodation option to propose.",
		bodyPropertyDescriptions: {
			roomDetails:
				"Room count and size. Required, but may be an empty object {} when the listing does not say.",
			location:
				"Where it is. Required, but a name alone is enough when you have no coordinates or place id.",
		},
	},
	{
		name: "add_transport_option",
		title: "Add Transport Option",
		description:
			"Propose a way of travelling TO a destination — flight, train, bus, ferry, car. One option per candidate itinerary; add several so the user can compare price against travel time. Set roundTrip when the price covers the return leg too. For moving around once there, use add_getting_around_option instead.",
		operationId: "TripsV1Controller_addTransportOption",
		annotations: openWorld(CREATE),
		rename: { id: "tripId" },
		bodyDescription: "The transport option to propose.",
	},
	{
		name: "add_getting_around_option",
		title: "Add Getting-Around Option",
		description:
			"Propose how the traveller moves around locally once at a destination — walking, public transport, rental car, bike, ride share. Use this for local mobility budgets; the journey between destinations belongs in add_transport_option.",
		operationId: "TripsV1Controller_addGettingAroundOption",
		annotations: CREATE,
		rename: { id: "tripId" },
		bodyDescription: "The getting-around option to propose.",
	},
	{
		name: "update_destination_option",
		title: "Update Destination Option",
		description:
			"Edit an existing accommodation, transport or getting-around option — correct a price, add a booking link, adjust check-in dates. Say which kind of option it is and pass the option key from get_trip. Only the fields you send are changed.",
		operationId: "OptionsWritesV1Controller_update",
		annotations: openWorld(UPDATE),
		rename: { id: "tripId" },
		mergeBodyUnion: true,
		paramOverrides: {
			kind: {
				enum: OPTION_KIND_ENUM,
				description: "Which kind of option is being edited.",
			},
		},
		bodyDescription:
			"Fields to change. Send only the fields that apply to this kind of option.",
		bodyPropertyDescriptions: {
			type: "Accommodation kind (hotel, hostel, apartment, house, camping, other) when kind is 'accommodation'; travel mode (walk, publicTransport, rentalCar, ...) when kind is 'getting-around'.",
		},
	},
	{
		name: "select_destination_option",
		title: "Select Destination Option",
		description:
			"Mark one accommodation / transport / getting-around option as the one the traveller will actually use, or clear the current choice. Always say which kind of option it is; pass optionId to select that option, or omit optionId to deselect whatever is currently selected of that kind. Returns the destination as it now stands, so you can see which option ended up selected. Prefer this over deleting the alternatives — they stay available for comparison.",
		annotations: UPDATE,
		discriminator: {
			name: "action",
			description:
				"'select' (default) marks optionId as chosen; 'deselect' clears the current choice for the given kind.",
			cases: {
				select: "TripsV1Controller_selectOption",
				deselect: "OptionsWritesV1Controller_deselect",
			},
			optional: true,
			defaultCase: "select",
		},
		// The select body's `type` is the same value as the deselect path's `kind`.
		rename: { id: "tripId", type: "kind" },
		paramOverrides: {
			kind: {
				enum: OPTION_KIND_ENUM,
				description:
					"Which kind of option this is. The option key alone does not say which of the three lists it belongs to.",
			},
		},
	},

	// ----------------------------------------------------------------- events
	{
		name: "add_event",
		title: "Add Event",
		description:
			"Add something to do during the trip — a museum, concert, restaurant, tour or activity. Events belong to the variant rather than to a single destination, and can be scheduled with start/end times or left unscheduled as ideas.",
		operationId: "TripsV1Controller_addEventOption",
		annotations: openWorld(CREATE),
		rename: { id: "tripId" },
		bodyDescription: "The event to add.",
	},
	{
		name: "update_event",
		title: "Update Event",
		description:
			"Edit an existing event: fix its time, price, location, booking link or notes. Use when the user has new information about an activity that is already on the plan (\"the tour starts at 10, not 9\").",
		operationId: "EventsWritesV1Controller_update",
		annotations: openWorld(UPDATE),
		rename: { id: "tripId" },
		bodyDescription: "Fields to change. Omitted fields are left as they are.",
	},
	{
		name: "toggle_event",
		title: "Toggle Event",
		description:
			"Flip an event between \"we are doing this\" and \"just an idea\" on the variant. Use when the user commits to, or backs out of, an activity — this keeps the event around, unlike delete_trip_item.",
		operationId: "EventsWritesV1Controller_toggle",
		annotations: TOGGLE,
		rename: { id: "tripId" },
	},

	// ----------------------------------------------------------------- delete
	{
		name: "delete_trip_item",
		title: "Delete Trip Item",
		description:
			"Permanently delete part of a trip: a variant, a destination, a destination option, or an event. Use only when the user rejects something outright — if they might still want it later, deselect the option or toggle the event instead. Deleting a variant or a destination also deletes everything inside it, so confirm with the user first.",
		annotations: DELETE,
		discriminator: {
			name: "target",
			description: "What to delete.",
			cases: {
				variant: "VariantsV1Controller_delete",
				destination: "DestinationsV1Controller_delete",
				option: "OptionsWritesV1Controller_delete",
				event: "EventsWritesV1Controller_delete",
			},
		},
		rename: { id: "tripId" },
		paramOverrides: {
			kind: {
				enum: OPTION_KIND_ENUM,
				description:
					"Which kind of option is being deleted. Required when target is 'option'.",
			},
		},
		caseGuards: {
			variant: {
				name: "confirm",
				description:
					"Must be true — confirms deleting the ENTIRE variant and everything inside it (all destinations, options and events). Ask the user before setting it.",
			},
		},
	},

	// ------------------------------------------------------------------ goals
	{
		name: "list_goals",
		title: "List Goals",
		description:
			"List the user's travel goals — the places and experiences on their bucket list (\"See the Northern Lights\"). Use this for inspiration when starting a new trip, or when the user asks what is on their list. Statuses: 'dreaming' is not planned yet, 'planning' is already linked to a trip, 'visited' is done.",
		operationId: "GoalsV1Controller_list",
		annotations: READ,
		paramOverrides: {
			status: { description: "Only return goals in this status." },
			collection: { description: "Only return goals in this collection id." },
			tripId: { description: "Only return goals linked to this trip id." },
		},
	},
	{
		name: "add_goal",
		title: "Add Goal",
		description:
			"Add a travel goal to the user's bucket list from a plain name or a URL — the server works out which and enriches it. Use when the user mentions something they would love to do some day but is not planning right now.",
		operationId: "GoalsV1Controller_quickAdd",
		annotations: CREATE,
		bodyDescription: "The goal to add.",
	},
];
