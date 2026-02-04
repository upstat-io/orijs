/**
 * Adds a value to the query object, handling repeated keys as arrays.
 * Uses null-prototype object to prevent prototype pollution.
 */
function addQueryValue(query: Record<string, string | string[]>, key: string, value: string): void {
	const existing = query[key];
	if (existing === undefined) {
		query[key] = value;
	} else if (Array.isArray(existing)) {
		existing.push(value);
	} else {
		query[key] = [existing, value];
	}
}

/**
 * Safely decodes a URI component, returning the original string if decoding fails.
 */
function safeDecodeURIComponent(str: string): string {
	try {
		return decodeURIComponent(str);
	} catch {
		// Return raw string if decoding fails (e.g., malformed %XX sequences)
		return str;
	}
}

/**
 * Parses query string parameters from a URL.
 * Repeated keys are returned as arrays.
 * @param url - The URL to parse
 * @returns Record of query parameter key-value pairs (arrays for repeated keys)
 */
export function parseQuery(url: URL): Record<string, string | string[]> {
	// Use null-prototype object to prevent prototype pollution
	const query: Record<string, string | string[]> = Object.create(null);
	url.searchParams.forEach((value, key) => {
		addQueryValue(query, key, value);
	});
	return query;
}

/**
 * Fast query string parser that works directly on the raw query string.
 * Avoids creating a URL object for better performance.
 * @param queryString - The raw query string (without the leading '?')
 * @returns Record of query parameter key-value pairs (arrays for repeated keys)
 */
export function parseQueryString(queryString: string): Record<string, string | string[]> {
	if (!queryString) {
		// Use null-prototype object to prevent prototype pollution
		return Object.create(null);
	}

	// Use null-prototype object to prevent prototype pollution
	const query: Record<string, string | string[]> = Object.create(null);
	const pairs = queryString.split('&');

	for (let i = 0; i < pairs.length; i++) {
		const pair = pairs[i]!;
		const eqIndex = pair.indexOf('=');

		let key: string;
		let value: string;

		if (eqIndex === -1) {
			key = safeDecodeURIComponent(pair);
			value = '';
		} else {
			key = safeDecodeURIComponent(pair.slice(0, eqIndex));
			value = safeDecodeURIComponent(pair.slice(eqIndex + 1));
		}

		addQueryValue(query, key, value);
	}

	return query;
}
