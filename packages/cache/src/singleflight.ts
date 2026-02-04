/**
 * Singleflight - Thundering Herd Prevention
 *
 * Prevents duplicate concurrent requests for the same key.
 * When multiple callers request the same key simultaneously:
 * - First caller executes the function
 * - Subsequent callers wait for and share the same result
 * - Only one computation happens per key
 *
 * Error Caching:
 * - Errors are cached for a configurable TTL (default 5 seconds)
 * - Prevents thundering herd on error (100 concurrent requests won't all retry)
 * - Error cache is cleared on successful execution
 *
 * @example
 * const sf = new Singleflight();
 *
 * // These 3 concurrent calls result in only 1 database query
 * const [a, b, c] = await Promise.all([
 *   sf.do('user:123', () => fetchUser(123)),
 *   sf.do('user:123', () => fetchUser(123)),
 *   sf.do('user:123', () => fetchUser(123)),
 * ]);
 *
 * @example
 * // With custom error TTL (10 seconds)
 * const sf = new Singleflight({ errorTtlMs: 10000 });
 */

/** Configuration options for Singleflight */
export interface SingleflightOptions {
	/**
	 * How long to cache errors before allowing retry (in milliseconds).
	 * Default: 5000 (5 seconds)
	 */
	errorTtlMs?: number;
}

interface Flight<T> {
	promise: Promise<T>;
}

interface CachedError {
	error: Error;
	until: number;
}

/** Default error cache TTL: 5 seconds */
const DEFAULT_ERROR_TTL_MS = 5000;

export class Singleflight {
	private readonly flights = new Map<string, Flight<unknown>>();
	private readonly errors = new Map<string, CachedError>();
	private readonly errorTtlMs: number;

	constructor(options: SingleflightOptions = {}) {
		this.errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
	}

	/**
	 * Execute a function with singleflight protection
	 *
	 * If another call with the same key is already in flight,
	 * this call will wait for and return the same result.
	 *
	 * If a recent error is cached for this key, it will be re-thrown
	 * without executing the function (prevents thundering herd on errors).
	 *
	 * @param key - Unique identifier for this operation
	 * @param fn - Async function to execute
	 * @returns Promise resolving to the function result
	 * @throws Cached error if one exists and hasn't expired
	 */
	async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
		// Check for cached error first
		const cachedError = this.errors.get(key);
		if (cachedError && cachedError.until > Date.now()) {
			throw cachedError.error;
		}

		// Check for existing in-flight request
		const existing = this.flights.get(key) as Flight<T> | undefined;
		if (existing) {
			return existing.promise;
		}

		// Create the flight promise
		const promise = (async () => {
			try {
				const result = await fn();
				// Clear error cache on success
				this.errors.delete(key);
				return result;
			} catch (error) {
				// Cache the error
				this.errors.set(key, {
					error: error as Error,
					until: Date.now() + this.errorTtlMs
				});
				throw error;
			} finally {
				// Clean up flight when done (success or failure)
				this.flights.delete(key);
			}
		})();

		// Store the flight
		this.flights.set(key, { promise } as Flight<unknown>);

		return promise;
	}

	/**
	 * Remove an in-flight request and cached error, allowing the next call to execute fresh
	 *
	 * Use when you know the cached computation is stale and want
	 * the next caller to recompute instead of waiting for the current result.
	 *
	 * @param key - Key to forget
	 */
	forget(key: string): void {
		this.flights.delete(key);
		this.errors.delete(key);
	}

	/**
	 * Clear only the cached error for a key, allowing retry on next call
	 *
	 * Use when you want to allow retry after an error without affecting
	 * any in-flight request.
	 *
	 * @param key - Key to clear error for
	 */
	forgetError(key: string): void {
		this.errors.delete(key);
	}

	/**
	 * Check if a key is currently in flight
	 *
	 * @param key - Key to check
	 * @returns True if there's an in-flight request for this key
	 */
	isInflight(key: string): boolean {
		return this.flights.has(key);
	}

	/**
	 * Check if a key has a cached error that hasn't expired
	 *
	 * @param key - Key to check
	 * @returns True if there's a cached error for this key
	 */
	hasError(key: string): boolean {
		const cached = this.errors.get(key);
		return cached !== undefined && cached.until > Date.now();
	}

	/**
	 * Get the number of currently in-flight requests
	 *
	 * Useful for monitoring and testing.
	 *
	 * @returns Number of in-flight requests
	 */
	getInflightCount(): number {
		return this.flights.size;
	}

	/**
	 * Get the number of cached errors (including expired ones)
	 *
	 * Useful for monitoring and testing.
	 *
	 * @returns Number of cached errors
	 */
	getErrorCount(): number {
		return this.errors.size;
	}

	/**
	 * Clear all in-flight requests and cached errors
	 *
	 * Use with caution - this may cause unexpected behavior
	 * for callers waiting on in-flight requests.
	 * Primarily for testing.
	 */
	clear(): void {
		this.flights.clear();
		this.errors.clear();
	}
}

/**
 * Global singleflight instance for convenience
 *
 * Use this for simple cases. Create separate instances
 * when you need isolation between different subsystems.
 */
export const globalSingleflight = new Singleflight();
