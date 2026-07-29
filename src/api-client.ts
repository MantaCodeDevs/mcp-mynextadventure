import type { ApiRequest } from "./tool-types";

export const DEFAULT_API_BASE_URL = "https://api.mynextadventure.cloud";

export interface ApiResult {
	ok: boolean;
	status: number;
	text: string;
}

/** Build the absolute URL for an ApiRequest. Pure — covered by tests. */
export function buildUrl(baseUrl: string, request: ApiRequest): string {
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	const url = new URL(base + request.path);
	for (const [key, value] of Object.entries(request.query ?? {})) {
		if (value === undefined || value === null || value === "") continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}

/**
 * Call the MyNextAdventure public API with the caller's API key.
 * Never throws — network/HTTP failures come back as `ok: false` so the tool
 * handler can hand a readable message to the model.
 */
export async function callApi(
	baseUrl: string,
	apiKey: string,
	request: ApiRequest,
): Promise<ApiResult> {
	const url = buildUrl(baseUrl, request);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"X-API-Key": apiKey,
	};
	if (request.body !== undefined) {
		headers["Content-Type"] = "application/json";
	}

	try {
		const response = await fetch(url, {
			method: request.method,
			headers,
			body: request.body === undefined ? undefined : JSON.stringify(request.body),
			signal: AbortSignal.timeout(60_000),
		});
		const text = await response.text();
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				text: `MyNextAdventure API returned ${response.status} ${response.statusText} for ${request.method} ${request.path}: ${text || "(empty body)"}`,
			};
		}
		return { ok: true, status: response.status, text: text || "{}" };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			text: `Failed to reach the MyNextAdventure API (${request.method} ${request.path}): ${(error as Error).message}`,
		};
	}
}
