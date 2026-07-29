#!/usr/bin/env node
/**
 * Regenerates src/generated/tools.ts from the server's OpenAPI snapshot.
 *
 *   npm run generate:tools
 *
 * The snapshot lives in the same repo (spec/openapi-v1.json) and is kept
 * fresh from the live spec: https://api.mynextadventure.cloud/api/v1/openapi.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateToolsFile, type OpenApiSpec } from "./generator";
import { TOOL_MANIFEST } from "./tool-manifest";

const here = dirname(fileURLToPath(import.meta.url));

export const SPEC_PATH = join(here, "..", "spec", "openapi-v1.json");
export const OUTPUT_PATH = join(here, "..", "src", "generated", "tools.ts");

export function loadSpec(): OpenApiSpec {
	return JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiSpec;
}

export function renderToolsFile(): string {
	return generateToolsFile(loadSpec(), TOOL_MANIFEST);
}

function main(): void {
	const source = renderToolsFile();
	mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
	writeFileSync(OUTPUT_PATH, source, "utf8");
	console.log(
		`Generated ${TOOL_MANIFEST.length} tools -> ${OUTPUT_PATH} (${source.length} bytes)`,
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
