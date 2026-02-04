/**
 * OriResponse - Typed response utilities for OriJS controllers.
 *
 * Provides type-safe static methods for creating HTTP responses
 * with generic type parameters for compile-time safety.
 *
 * @example
 * ```ts
 * // Typed JSON response
 * return OriResponse.json<ResponseStatus>({ status: 'success' });
 *
 * // With status code
 * return OriResponse.json<User>(user, { status: 201 });
 *
 * // Text response
 * return OriResponse.text('Hello, World!');
 *
 * // No content
 * return OriResponse.noContent();
 * ```
 */
export const OriResponse = {
	/**
	 * Create a typed JSON response.
	 *
	 * @param data - The data to serialize as JSON
	 * @param init - Optional ResponseInit (status, headers, etc.)
	 * @returns Response instance
	 *
	 * @example
	 * ```ts
	 * return OriResponse.json<ResponseStatus>({ status: 'success' });
	 * return OriResponse.json<User>(user, { status: 201 });
	 * ```
	 */
	json<T>(data: T, init?: ResponseInit): Response {
		return Response.json(data, init);
	},

	/**
	 * Create a text response.
	 *
	 * @param text - The text content
	 * @param init - Optional ResponseInit (status, headers, etc.)
	 * @returns Response instance
	 *
	 * @example
	 * ```ts
	 * return OriResponse.text('Hello, World!');
	 * return OriResponse.text('Created', { status: 201 });
	 * ```
	 */
	text(text: string, init?: ResponseInit): Response {
		const headers = init?.headers
			? { 'Content-Type': 'text/plain', ...(init.headers as Record<string, string>) }
			: { 'Content-Type': 'text/plain' };
		return new Response(text, { ...init, headers });
	},

	/**
	 * Create a 204 No Content response.
	 *
	 * @returns Response instance with no body and 204 status
	 *
	 * @example
	 * ```ts
	 * return OriResponse.noContent();
	 * ```
	 */
	noContent(): Response {
		return new Response(null, { status: 204 });
	},

	/**
	 * Create a redirect response.
	 *
	 * @param url - The URL to redirect to
	 * @param status - HTTP status code (default: 302)
	 * @returns Response instance
	 *
	 * @example
	 * ```ts
	 * return OriResponse.redirect('/login');
	 * return OriResponse.redirect('/dashboard', 301);
	 * ```
	 */
	redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
		return new Response(null, {
			status,
			headers: { Location: url }
		});
	},

	/**
	 * Create a 201 Created response with optional Location header.
	 *
	 * @param data - The data to serialize as JSON
	 * @param location - Optional Location header for the created resource
	 * @returns Response instance
	 *
	 * @example
	 * ```ts
	 * return OriResponse.created<User>(user, '/users/123');
	 * return OriResponse.created<ResponseStatus>({ status: 'success' });
	 * ```
	 */
	created<T>(data: T, location?: string): Response {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (location) {
			headers['Location'] = location;
		}
		return new Response(JSON.stringify(data), { status: 201, headers });
	}
} as const;

/**
 * Type for OriResponse return values.
 * Use this in handler signatures for type safety.
 */
export type OriResponseType = Response;
