/**
 * RouteKey - Type-safe route metadata keys
 *
 * Creates strongly-typed symbols for attaching metadata to routes.
 * Guards and handlers read route data via ctx.get(key).
 *
 * @example
 * ```ts
 * const RateLimitKey = createRouteKey<RateLimitConfig>('RateLimit');
 *
 * class MyController implements OriController {
 *   configure(r: RouteBuilder) {
 *     r.guard(RateLimiterGuard);
 *
 *     r.post('/login', this.login);
 *     r.set(RateLimitKey, { ip: { windowMs: 60_000, maxRequests: 10 } });
 *   }
 * }
 *
 * // In guard:
 * const config = ctx.get(RateLimitKey); // RateLimitConfig | undefined
 * ```
 *
 * @module
 */

/**
 * A typed route metadata key (symbol with type information).
 *
 * RouteKey<T> is a symbol that carries type information about what value
 * it maps to. This enables type-safe route metadata that guards and
 * handlers can read via ctx.get(key).
 *
 * @template T - The type of the value this key maps to
 */
export type RouteKey<T> = symbol & { readonly __routeType?: T };

/**
 * Creates a typed route metadata key.
 *
 * @template T - The type of the value this key will map to
 * @param name - A descriptive name for the key (used in debugging)
 * @returns A typed symbol for use with r.set() and ctx.get()
 */
export function createRouteKey<T>(name: string): RouteKey<T> {
	return Symbol(name) as RouteKey<T>;
}

/**
 * Type guard to check if a value is a RouteKey.
 *
 * @param value - The value to check
 * @returns True if the value is a symbol (RouteKey)
 */
export function isRouteKey(value: unknown): value is RouteKey<unknown> {
	return typeof value === 'symbol';
}
