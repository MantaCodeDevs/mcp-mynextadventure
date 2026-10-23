/**
 * Turns the server's OpenAPI snapshot + the curated tool manifest into the
 * source of `src/generated/tools.ts`.
 *
 * Pure (spec in, TypeScript source out) so tests can assert the committed
 * generated file is in sync with the spec.
 */

import { createHash } from "node:crypto";
import {
	isGrouped,
	PATH_PARAM_DESCRIPTIONS,
	type GroupedTool,
	type ParamOverride,
	type SingleOpTool,
	type ToolAnnotations,
	type ToolSpec,
} from "./tool-manifest";

// ---------------------------------------------------------------- spec types

export interface JsonSchema {
	$ref?: string;
	type?: string;
	format?: string;
	enum?: unknown[];
	nullable?: boolean;
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
	allOf?: JsonSchema[];
}

interface Parameter {
	name: string;
	in: "path" | "query" | "header";
	required?: boolean;
	description?: string;
	schema?: JsonSchema;
}

interface Operation {
	operationId: string;
	summary?: string;
	description?: string;
	parameters?: Parameter[];
	requestBody?: {
		required?: boolean;
		content?: Record<string, { schema?: JsonSchema }>;
	};
}

export interface OpenApiSpec {
	paths: Record<string, Record<string, Operation>>;
	components?: { schemas?: Record<string, JsonSchema> };
}

interface ResolvedOperation {
	operationId: string;
	method: string;
	path: string;
	operation: Operation;
}

// -------------------------------------------------------------- spec helpers

function indexOperations(spec: OpenApiSpec): Map<string, ResolvedOperation> {
	const index = new Map<string, ResolvedOperation>();
	for (const [path, methods] of Object.entries(spec.paths)) {
		for (const [method, operation] of Object.entries(methods)) {
			if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
			index.set(operation.operationId, {
				operationId: operation.operationId,
				method: method.toUpperCase(),
				path,
				operation,
			});
		}
	}
	return index;
}

function deref(schema: JsonSchema, spec: OpenApiSpec): JsonSchema {
	let current = schema;
	let guard = 0;
	while (current.$ref) {
		const name = current.$ref.replace("#/components/schemas/", "");
		const target = spec.components?.schemas?.[name];
		if (!target) throw new Error(`Unresolvable $ref: ${current.$ref}`);
		const { $ref, ...rest } = current;
		current = { ...target, ...rest };
		if (++guard > 20) throw new Error(`Cyclic $ref: ${schema.$ref}`);
	}
	return current;
}

function requestBodySchema(operation: Operation): JsonSchema | undefined {
	return operation.requestBody?.content?.["application/json"]?.schema;
}

// ------------------------------------------------------------ zod code emitter

function quote(value: string): string {
	return JSON.stringify(value);
}

function describeSuffix(description: string | undefined): string {
	return description ? `.describe(${quote(description)})` : "";
}

function zodBase(schema: JsonSchema, spec: OpenApiSpec, indent: string): string {
	const resolved = deref(schema, spec);

	const union = resolved.oneOf ?? resolved.anyOf;
	if (union && union.length > 0) {
		if (union.length === 1) return zodBase(union[0], spec, indent);
		const members = union
			.map((member) => `${indent}\t${zodValue(member, spec, `${indent}\t`, true)}`)
			.join(",\n");
		return `z.union([\n${members},\n${indent}])`;
	}

	if (resolved.allOf && resolved.allOf.length === 1) {
		return zodBase(resolved.allOf[0], spec, indent);
	}

	if (resolved.enum?.every((v) => typeof v === "string")) {
		return `z.enum([${resolved.enum.map((v) => quote(v as string)).join(", ")}])`;
	}

	switch (resolved.type) {
		case "string":
			return "z.string()";
		case "number":
		case "integer":
			return "z.number()";
		case "boolean":
			return "z.boolean()";
		case "array": {
			const items = resolved.items ?? {};
			return `z.array(${zodValue(items, spec, indent, true)})`;
		}
		case "object":
		case undefined: {
			if (!resolved.properties) return "z.record(z.unknown())";
			return objectExpression(resolved, spec, indent);
		}
		default:
			return "z.unknown()";
	}
}

function objectExpression(
	schema: JsonSchema,
	spec: OpenApiSpec,
	indent: string,
): string {
	const required = new Set(schema.required ?? []);
	const entries = Object.entries(schema.properties ?? {}).map(([name, property]) => {
		const value = zodValue(property, spec, `${indent}\t`, required.has(name));
		return `${indent}\t${name}: ${value}`;
	});
	if (entries.length === 0) return "z.record(z.unknown())";
	return `z.object({\n${entries.join(",\n")},\n${indent}})`;
}

/** Full zod expression for a schema: base type + description + optionality. */
function zodValue(
	schema: JsonSchema,
	spec: OpenApiSpec,
	indent: string,
	required: boolean,
	descriptionOverride?: string,
): string {
	const resolved = deref(schema, spec);
	let code = zodBase(schema, spec, indent);

	let description = descriptionOverride ?? resolved.description;
	if (resolved.format === "date-time") {
		const hint = "ISO 8601 date-time, e.g. 2026-05-21T09:00:00.000Z.";
		description = description ? `${description} ${hint}` : hint;
	}
	code += describeSuffix(description);
	if (resolved.nullable) code += ".nullable()";
	if (!required) code += ".optional()";
	return code;
}

// -------------------------------------------------------------- tool emitters

interface ShapeEntry {
	name: string;
	code: string;
}

/** Where a tool argument comes from: a spec parameter, or a request-body property. */
interface ArgSource {
	name: string;
	required?: boolean;
	description?: string;
	schema?: JsonSchema;
}

function paramEntry(
	parameter: ArgSource,
	spec: OpenApiSpec,
	name: string,
	override: ParamOverride | undefined,
	requiredOverride?: boolean,
	descriptionSuffix?: string,
): ShapeEntry {
	const schema: JsonSchema = override?.enum
		? { type: "string", enum: override.enum }
		: (parameter.schema ?? { type: "string" });
	const required =
		requiredOverride ?? override?.required ?? parameter.required ?? false;
	let description =
		override?.description ??
		parameter.description ??
		PATH_PARAM_DESCRIPTIONS[name] ??
		undefined;
	if (descriptionSuffix) {
		description = description
			? `${description} ${descriptionSuffix}`
			: descriptionSuffix;
	}
	return {
		name,
		code: zodValue(schema, spec, "\t\t\t", required, description),
	};
}

function pathTemplate(path: string, resolveArg: (param: string) => string): string {
	return path.replace(/\{(\w+)\}/g, (_match, param: string) =>
		`\${enc(${resolveArg(param)})}`,
	);
}

/** Structural identity, ignoring documentation-only differences. */
function structuralKey(schema: JsonSchema): string {
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip);
		if (value && typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>)
				.filter(([key]) => key !== "description" && key !== "example")
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, inner]) => [key, strip(inner)]);
			return Object.fromEntries(entries);
		}
		return value;
	};
	return JSON.stringify(strip(schema));
}

/** Merge the members of a `oneOf` body into a single flat object schema. */
function mergeUnion(schema: JsonSchema, spec: OpenApiSpec): JsonSchema {
	const members = (schema.oneOf ?? schema.anyOf ?? []).map((m) => deref(m, spec));
	const properties: Record<string, JsonSchema> = {};
	for (const member of members) {
		for (const [name, property] of Object.entries(member.properties ?? {})) {
			const existing = properties[name];
			if (!existing) {
				properties[name] = property;
				continue;
			}
			const existingMembers = existing.oneOf ?? [existing];
			if (existingMembers.some((m) => structuralKey(m) === structuralKey(property))) {
				continue;
			}
			properties[name] = {
				oneOf: [...existingMembers, property],
				description: existing.description ?? property.description,
			};
		}
	}
	// A field is only required if every member requires it.
	const required = (members[0]?.required ?? []).filter((name) =>
		members.every((member) => (member.required ?? []).includes(name)),
	);
	return { type: "object", properties, required };
}

/**
 * MCP `ToolAnnotations`, emitted in the spec's own field order so the generated
 * file is stable regardless of how the manifest object was built up.
 */
function emitAnnotations(annotations: ToolAnnotations): string[] {
	const fields: Array<keyof ToolAnnotations> = [
		"readOnlyHint",
		"destructiveHint",
		"idempotentHint",
		"openWorldHint",
	];
	return [
		"\t\tannotations: {",
		...fields.map((field) => `\t\t\t${field}: ${annotations[field]},`),
		"\t\t},",
	];
}

function emitSingleTool(
	tool: SingleOpTool,
	resolved: ResolvedOperation,
	spec: OpenApiSpec,
): string {
	const { operation, method, path } = resolved;
	const rename = (name: string) => tool.rename?.[name] ?? name;
	const shape: ShapeEntry[] = [];
	const queryNames: string[] = [];

	for (const parameter of operation.parameters ?? []) {
		if (parameter.in === "header") continue;
		const name = rename(parameter.name);
		const override = tool.paramOverrides?.[name] ?? tool.paramOverrides?.[parameter.name];
		const requiredOverride = parameter.in === "path" ? true : undefined;
		shape.push(paramEntry(parameter, spec, name, override, requiredOverride));
		if (parameter.in === "query") queryNames.push(parameter.name);
	}

	const bodySchemaRaw = requestBodySchema(operation);
	let bodyRequired = false;
	if (bodySchemaRaw) {
		let bodySchema = tool.mergeBodyUnion
			? mergeUnion(bodySchemaRaw, spec)
			: bodySchemaRaw;
		if (tool.bodyPropertyDescriptions) {
			const resolvedBody = deref(bodySchema, spec);
			const properties = { ...(resolvedBody.properties ?? {}) };
			for (const [name, description] of Object.entries(tool.bodyPropertyDescriptions)) {
				if (!properties[name]) {
					throw new Error(
						`Tool "${tool.name}" overrides description of unknown body property "${name}".`,
					);
				}
				properties[name] = { ...deref(properties[name], spec), description };
			}
			bodySchema = { ...resolvedBody, properties };
		}
		bodyRequired = (deref(bodySchema, spec).required ?? []).length > 0;
		shape.push({
			name: "data",
			code: zodValue(bodySchema, spec, "\t\t\t", bodyRequired, tool.bodyDescription),
		});
	}

	const queryEntries = queryNames
		.map((name) => `${name}: args[${quote(rename(name))}]`)
		.join(", ");
	const template = pathTemplate(path, (param) => `args[${quote(rename(param))}]`);

	const requestLines = [
		`\t\t\tmethod: ${quote(method)},`,
		`\t\t\tpath: \`${template}\`,`,
	];
	if (queryNames.length > 0) requestLines.push(`\t\t\tquery: { ${queryEntries} },`);
	if (bodySchemaRaw) requestLines.push("\t\t\tbody: args.data ?? {},");

	return [
		"\t{",
		`\t\tname: ${quote(tool.name)},`,
		`\t\ttitle: ${quote(tool.title)},`,
		`\t\tdescription: ${quote(tool.description)},`,
		`\t\toperations: [${quote(tool.operationId)}],`,
		...emitAnnotations(tool.annotations),
		...(shape.length === 0
			? ["\t\tinputShape: {},"]
			: [
					"\t\tinputShape: {",
					...shape.map((entry) => `\t\t\t${entry.name}: ${entry.code},`),
					"\t\t},",
				]),
		`\t\tresolve: ${shape.length === 0 ? "()" : "(args)"} => ({`,
		...requestLines,
		"\t\t}),",
		"\t},",
	].join("\n");
}

function humanList(values: string[]): string {
	if (values.length === 1) return `'${values[0]}'`;
	return `${values
		.slice(0, -1)
		.map((v) => `'${v}'`)
		.join(", ")} or '${values[values.length - 1]}'`;
}

function emitGroupedTool(
	tool: GroupedTool,
	index: Map<string, ResolvedOperation>,
	spec: OpenApiSpec,
): string {
	const rename = (name: string) => tool.rename?.[name] ?? name;
	const discriminator = tool.discriminator;
	const caseNames = Object.keys(discriminator.cases);

	// Path params and request-body properties both become flat tool arguments,
	// keyed by argument name so that a `kind` in one case's path and the same
	// `kind` in another case's body collapse into a single argument.
	const argCases = new Map<
		string,
		{ source: ArgSource; required: boolean; cases: string[] }
	>();
	const caseBodyFields = new Map<string, Array<{ property: string; argName: string }>>();

	const register = (argName: string, source: ArgSource, caseName: string) => {
		const entry = argCases.get(argName);
		if (!entry) {
			argCases.set(argName, {
				source,
				required: source.required !== false,
				cases: [caseName],
			});
			return;
		}
		entry.cases.push(caseName);
		entry.required = entry.required && source.required !== false;
	};

	for (const [caseName, operationId] of Object.entries(discriminator.cases)) {
		const resolved = index.get(operationId);
		if (!resolved) throw new Error(`Unknown operationId: ${operationId}`);
		for (const parameter of resolved.operation.parameters ?? []) {
			if (parameter.in !== "path") {
				throw new Error(
					`Grouped tool "${tool.name}" case "${caseName}" has a ${parameter.in} parameter, which grouping does not support.`,
				);
			}
			register(rename(parameter.name), parameter, caseName);
		}

		const rawBody = requestBodySchema(resolved.operation);
		if (!rawBody) continue;
		const body = deref(rawBody, spec);
		if (!body.properties) {
			throw new Error(
				`Grouped tool "${tool.name}" case "${caseName}" (${operationId}) has a request body with no named properties; grouping cannot flatten it into arguments.`,
			);
		}
		const bodyRequired = new Set(body.required ?? []);
		caseBodyFields.set(
			caseName,
			Object.entries(body.properties).map(([property, propertySchema]) => {
				const argName = rename(property);
				register(
					argName,
					{
						name: property,
						required: bodyRequired.has(property),
						description: deref(propertySchema, spec).description,
						schema: propertySchema,
					},
					caseName,
				);
				return { property, argName };
			}),
		);
	}

	/** True when every case needs this argument, so it can be plainly required. */
	const alwaysPresent = (argName: string): boolean => {
		const entry = argCases.get(argName);
		return entry?.required === true && entry.cases.length === caseNames.length;
	};

	const shape: ShapeEntry[] = [
		{
			name: discriminator.name,
			code: zodValue(
				{ type: "string", enum: caseNames },
				spec,
				"\t\t\t",
				!discriminator.optional,
				discriminator.description,
			),
		},
	];
	for (const [name, entry] of argCases) {
		const required = alwaysPresent(name);
		const override = tool.paramOverrides?.[name];
		const suffix =
			required || !entry.required
				? undefined
				: `Required when ${discriminator.name} is ${humanList(entry.cases)}.`;
		shape.push(
			paramEntry(
				entry.source,
				spec,
				name,
				override,
				required,
				override?.description ? undefined : suffix,
			),
		);
	}

	for (const [caseName, guard] of Object.entries(tool.caseGuards ?? {})) {
		if (!caseNames.includes(caseName)) {
			throw new Error(
				`Tool "${tool.name}" guards unknown ${discriminator.name} "${caseName}".`,
			);
		}
		shape.push({
			name: guard.name,
			code: zodValue({ type: "boolean" }, spec, "\t\t\t", false, guard.description),
		});
	}

	/** How a branch reads an argument: plainly, or guarded when it is case-specific. */
	const argExpression = (argName: string, caseName: string): string => {
		const entry = argCases.get(argName);
		if (!entry?.required || alwaysPresent(argName)) return `args[${quote(argName)}]`;
		return `req(args, ${quote(argName)}, ${quote(discriminator.name)}, ${quote(caseName)})`;
	};

	const branches = Object.entries(discriminator.cases).map(([caseName, operationId]) => {
		const resolved = index.get(operationId) as ResolvedOperation;
		const template = pathTemplate(resolved.path, (param) =>
			argExpression(rename(param), caseName),
		);
		const requestLines = [
			`\t\t\t\t\t\tmethod: ${quote(resolved.method)},`,
			`\t\t\t\t\t\tpath: \`${template}\`,`,
		];
		const bodyFields = caseBodyFields.get(caseName) ?? [];
		if (bodyFields.length > 0) {
			const entries = bodyFields
				.map(({ property, argName }) => `${property}: ${argExpression(argName, caseName)}`)
				.join(", ");
			requestLines.push(`\t\t\t\t\t\tbody: { ${entries} },`);
		}
		const guard = tool.caseGuards?.[caseName];
		if (!guard) {
			return [
				`\t\t\t\tcase ${quote(caseName)}:`,
				"\t\t\t\t\treturn {",
				...requestLines,
				"\t\t\t\t\t};",
			].join("\n");
		}
		return [
			`\t\t\t\tcase ${quote(caseName)}: {`,
			`\t\t\t\t\tconfirmed(args, ${quote(guard.name)}, ${quote(discriminator.name)}, ${quote(caseName)});`,
			"\t\t\t\t\treturn {",
			...requestLines,
			"\t\t\t\t\t};",
			"\t\t\t\t}",
		].join("\n");
	});

	const selector = discriminator.optional
		? `(args[${quote(discriminator.name)}] as string | undefined) ?? ${quote(
				discriminator.defaultCase ?? caseNames[0],
			)}`
		: `args[${quote(discriminator.name)}] as string`;

	return [
		"\t{",
		`\t\tname: ${quote(tool.name)},`,
		`\t\ttitle: ${quote(tool.title)},`,
		`\t\tdescription: ${quote(tool.description)},`,
		`\t\toperations: [${Object.values(discriminator.cases)
			.map(quote)
			.join(", ")}],`,
		...emitAnnotations(tool.annotations),
		"\t\tinputShape: {",
		...shape.map((entry) => `\t\t\t${entry.name}: ${entry.code},`),
		"\t\t},",
		"\t\tresolve: (args) => {",
		`\t\t\tconst ${discriminator.name} = ${selector};`,
		`\t\t\tswitch (${discriminator.name}) {`,
		...branches,
		"\t\t\t\tdefault:",
		"\t\t\t\t\tthrow new Error(",
		`\t\t\t\t\t\t\`Unknown ${discriminator.name} "\${String(${discriminator.name})}" — expected one of: ${caseNames.join(", ")}.\`,`,
		"\t\t\t\t\t);",
		"\t\t\t}",
		"\t\t},",
		"\t},",
	].join("\n");
}

// ------------------------------------------------------------------- entrypoint

const HEADER = `// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
//
// Generated by scripts/generate-tools.ts from spec/openapi-v1.json using
// the curated tool list in scripts/tool-manifest.ts.
// Regenerate with: npm run generate:tools
//
// The tool list is intentionally a curated subset of the public API: every entry
// exists because conversational trip planning needs it.

import { z } from "zod";
import type { ToolDefinition } from "../tool-types";

const enc = (value: unknown): string => encodeURIComponent(String(value));

/** Path params that only apply to some branches of a grouped tool. */
function req(
	args: Record<string, unknown>,
	name: string,
	discriminator: string,
	caseName: string,
): unknown {
	const value = args[name];
	if (value === undefined || value === null || value === "") {
		throw new Error(
			\`"\${name}" is required when \${discriminator} is "\${caseName}".\`,
		);
	}
	return value;
}

/** Destructive branches refuse to run without an explicit confirmation flag. */
function confirmed(
	args: Record<string, unknown>,
	name: string,
	discriminator: string,
	caseName: string,
): void {
	if (args[name] !== true) {
		throw new Error(
			\`Refusing to run: set "\${name}" to true to confirm this \${discriminator} "\${caseName}" operation. Check with the user first — it cannot be undone.\`,
		);
	}
}
`;

/**
 * Fingerprint of the OpenAPI snapshot these tools were generated from. A client
 * caches tool schemas at connect time, so "my schema lacks a field the API has"
 * and "the API really lacks it" look identical from the outside. Comparing this
 * against the server's own contract hash tells the two apart in one call.
 */
function contractHash(spec: OpenApiSpec): string {
	return createHash("sha256")
		.update(JSON.stringify(spec.components?.schemas ?? {}))
		.digest("hex")
		.slice(0, 12);
}

export function generateToolsFile(spec: OpenApiSpec, manifest: ToolSpec[]): string {
	const index = indexOperations(spec);
	const bodies = manifest.map((tool) => {
		if (isGrouped(tool)) return emitGroupedTool(tool, index, spec);
		const resolved = index.get(tool.operationId);
		if (!resolved) {
			throw new Error(
				`Manifest references unknown operationId "${tool.operationId}" (tool "${tool.name}").`,
			);
		}
		return emitSingleTool(tool, resolved, spec);
	});

	return `${HEADER}
/** Fingerprint of the API contract these tools were generated from. */
export const CONTRACT_HASH = "${contractHash(spec)}";

export const TOOLS: ToolDefinition[] = [
${bodies.join("\n")}
];
`;
}
