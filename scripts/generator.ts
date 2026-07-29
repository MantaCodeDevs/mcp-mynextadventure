/**
 * Turns the server's OpenAPI snapshot + the curated tool manifest into the
 * source of `src/generated/tools.ts`.
 *
 * Pure (spec in, TypeScript source out) so tests can assert the committed
 * generated file is in sync with the spec.
 */

import {
	isGrouped,
	PATH_PARAM_DESCRIPTIONS,
	type GroupedTool,
	type ParamOverride,
	type SingleOpTool,
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

function paramEntry(
	parameter: Parameter,
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
		`\t\tdescription: ${quote(tool.description)},`,
		`\t\toperations: [${quote(tool.operationId)}],`,
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

	// Collect path params per case; grouped operations must be body-less.
	const paramCases = new Map<string, { parameter: Parameter; cases: string[] }>();
	for (const [caseName, operationId] of Object.entries(discriminator.cases)) {
		const resolved = index.get(operationId);
		if (!resolved) throw new Error(`Unknown operationId: ${operationId}`);
		if (requestBodySchema(resolved.operation)) {
			throw new Error(
				`Grouped tool "${tool.name}" case "${caseName}" (${operationId}) has a request body; grouping only supports body-less operations.`,
			);
		}
		for (const parameter of resolved.operation.parameters ?? []) {
			if (parameter.in !== "path") {
				throw new Error(
					`Grouped tool "${tool.name}" case "${caseName}" has a ${parameter.in} parameter, which grouping does not support.`,
				);
			}
			const name = rename(parameter.name);
			const entry = paramCases.get(name);
			if (entry) entry.cases.push(caseName);
			else paramCases.set(name, { parameter, cases: [caseName] });
		}
	}
	// `kind` only appears in the path of some cases but is meaningful to name.
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
	for (const [name, entry] of paramCases) {
		const alwaysRequired = entry.cases.length === caseNames.length;
		const override = tool.paramOverrides?.[name];
		const suffix = alwaysRequired
			? undefined
			: `Required when ${discriminator.name} is ${humanList(entry.cases)}.`;
		shape.push(
			paramEntry(
				entry.parameter,
				spec,
				name,
				override,
				alwaysRequired,
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

	const branches = Object.entries(discriminator.cases).map(([caseName, operationId]) => {
		const resolved = index.get(operationId) as ResolvedOperation;
		const template = pathTemplate(resolved.path, (param) => {
			const argName = rename(param);
			const entry = paramCases.get(argName);
			const alwaysRequired = entry?.cases.length === caseNames.length;
			return alwaysRequired
				? `args[${quote(argName)}]`
				: `req(args, ${quote(argName)}, ${quote(discriminator.name)}, ${quote(caseName)})`;
		});
		const guard = tool.caseGuards?.[caseName];
		if (!guard) {
			return [
				`\t\t\t\tcase ${quote(caseName)}:`,
				"\t\t\t\t\treturn {",
				`\t\t\t\t\t\tmethod: ${quote(resolved.method)},`,
				`\t\t\t\t\t\tpath: \`${template}\`,`,
				"\t\t\t\t\t};",
			].join("\n");
		}
		return [
			`\t\t\t\tcase ${quote(caseName)}: {`,
			`\t\t\t\t\tconfirmed(args, ${quote(guard.name)}, ${quote(discriminator.name)}, ${quote(caseName)});`,
			"\t\t\t\t\treturn {",
			`\t\t\t\t\t\tmethod: ${quote(resolved.method)},`,
			`\t\t\t\t\t\tpath: \`${template}\`,`,
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
		`\t\tdescription: ${quote(tool.description)},`,
		`\t\toperations: [${Object.values(discriminator.cases)
			.map(quote)
			.join(", ")}],`,
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
export const TOOLS: ToolDefinition[] = [
${bodies.join("\n")}
];
`;
}
