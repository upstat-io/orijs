/**
 * Cache Service - High-Level Cache Operations
 *
 * Provides a high-level caching API with:
 * - getOrSet() for cache-aside pattern with factory
 * - Singleflight for thundering herd prevention
 * - FactoryContext for factory control (skip, fail, stale access)
 * - Grace period / stale-while-revalidate support
 * - Cascade invalidation via dependency tracking (Redis only)
 *
 * Works with any CacheProvider implementation:
 * - RedisCacheProvider: Full features including cascade invalidation
 * - InMemoryCacheProvider: Basic caching for testing (no cascade)
 *
 * @example
 * // Production with Redis
 * const cacheService = new CacheService(new RedisCacheProvider(redis));
 *
 * // Testing with InMemory
 * const cacheService = new CacheService(new InMemoryCacheProvider());
 *
 * // Define a cache configuration
 * const UserCache = Cache.define<UserParams>('User')
 *   .scope('account')
 *   .ttl('1h')
 *   .params('accountUuid', 'userUuid')
 *   .build();
 *
 * // Use getOrSet in a repository
 * const user = await cacheService.getOrSet(
 *   UserCache,
 *   { accountUuid: 'abc', userUuid: 'def' },
 *   async (ctx) => {
 *     const user = await db.findById(params);
 *     if (!user) return ctx.skip();
 *     return user;
 *   }
 * );
 */

import {
	hasMetaSupport,
	type CacheConfig,
	type CacheEntry,
	type CacheProvider,
	type CacheServiceOptions,
	type FactoryContext
} from './types';
import {
	generateCacheKey,
	generateMetaKey,
	generateConfigMetaKey,
	generateTagMetaKey
} from './key-generator';
import { getEntityInvalidationTags } from './entity-registry';
import { Singleflight } from './singleflight';
import { parseDuration } from './duration';

/**
 * Options for cache invalidation
 */
export interface InvalidateOptions {
	/**
	 * Whether to cascade invalidation to dependent caches.
	 * Default: true
	 *
	 * When true (Redis only):
	 * - Finds all caches that depend on this entity via meta keys
	 * - Deletes all dependent cache entries
	 *
	 * When false:
	 * - Only deletes the direct cache entry for this entity
	 *
	 * Note: Cascade is only supported with RedisCacheProvider.
	 * For InMemoryCacheProvider, this option is ignored.
	 */
	cascade?: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// FACTORY CONTEXT IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Sentinel value for skip() - tells getOrSet to not cache and return undefined
 */
const SKIP_SENTINEL = Symbol('CACHE_SKIP');

/**
 * Error thrown by fail() - tells getOrSet to use stale value if available
 */
class CacheFailError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CacheFailError';
	}
}

/**
 * Error thrown when data fetch exceeds configured timeout
 */
export class CacheTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Cache fetch timed out after ${timeoutMs}ms`);
		this.name = 'CacheTimeoutError';
	}
}

/**
 * Wrap a promise with a timeout
 * Uses chained promise handlers to avoid unhandled rejection
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeoutId: Timer | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new CacheTimeoutError(timeoutMs));
		}, timeoutMs);
	});

	// Use Promise.race and chain cleanup to avoid parallel handlers
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
	});
}

/**
 * Create a FactoryContext for use in factory functions
 */
function createFactoryContext<T>(staleValue: T | undefined, staleAge: number | undefined): FactoryContext<T> {
	return {
		skip(): never {
			throw SKIP_SENTINEL;
		},
		fail(message: string): never {
			throw new CacheFailError(message);
		},
		staleValue,
		staleAge
	};
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE SERVICE
// ════════════════════════════════════════════════════════════════════════════

/**
 * High-level cache service with getOrSet pattern
 *
 * Works with any CacheProvider implementation. Cascade invalidation
 * is only available when using providers that support meta keys
 * (e.g., RedisCacheProvider from @orijs/cache-redis).
 */
export class CacheService {
	// Disable error caching - CacheService has its own error handling logic
	// and factories may return different results on retry
	private readonly singleflight = new Singleflight({ errorTtlMs: 0 });
	private readonly defaultGraceSeconds: number;

	constructor(
		private readonly provider: CacheProvider,
		options: CacheServiceOptions = {}
	) {
		this.defaultGraceSeconds = options.defaultGrace ? parseDuration(options.defaultGrace) : 0;
	}

	/**
	 * Get or set a cached value using a factory function.
	 *
	 * This is the primary method for cache-aside pattern:
	 * 1. Check cache for existing value
	 * 2. If fresh hit, return immediately
	 * 3. If stale (within grace period), call factory with stale value available as fallback
	 * 4. If miss/expired, call factory to compute new value
	 *
	 * ## Cache Entry States
	 *
	 * ```
	 * Timeline: |-------- TTL --------|-------- Grace --------|--- Expired ---|
	 *           ^                     ^                       ^
	 *           createdAt             expiresAt               graceExpiresAt
	 *
	 * FRESH (now < expiresAt):
	 *   - Return cached value immediately
	 *   - No factory call
	 *
	 * STALE (expiresAt <= now < graceExpiresAt):
	 *   - Call factory to revalidate
	 *   - Factory receives staleValue and staleAge in context
	 *   - If factory succeeds: cache new value, return it
	 *   - If factory fails/times out: return stale value as fallback
	 *
	 * EXPIRED (now >= graceExpiresAt) or MISS (no entry):
	 *   - Call factory to compute value
	 *   - No stale fallback available
	 *   - If factory fails: error propagates to caller
	 * ```
	 *
	 * ## Factory Context
	 *
	 * The factory function receives a context object with:
	 * - `skip()`: Don't cache the result, return undefined to caller
	 * - `fail(msg)`: Signal error; if stale value exists, return it instead
	 * - `staleValue`: The stale cached value (undefined if not in grace period)
	 * - `staleAge`: Seconds since the entry was created (undefined if not stale)
	 *
	 * @param config - Cache configuration from builder
	 * @param params - Parameters for cache key and factory
	 * @param factory - Async function to compute value on cache miss/stale
	 * @returns Cached or computed value, or undefined if skipped
	 */
	async getOrSet<T, TParams extends object>(
		config: CacheConfig<TParams>,
		params: TParams,
		factory: (ctx: FactoryContext<T>) => Promise<T>
	): Promise<T | undefined> {
		const cacheKey = generateCacheKey(config, params);

		// Use singleflight to prevent thundering herd
		return this.singleflight.do(cacheKey, async () => {
			// Try to get existing entry
			const entry = await this.getEntry<T>(cacheKey);
			const now = Date.now();

			// Fresh cache hit - return immediately
			if (entry && entry.expiresAt > now) {
				return entry.value;
			}

			// Determine stale state for factory context
			const isStale = entry && entry.graceExpiresAt && entry.graceExpiresAt > now;
			const staleValue = isStale ? entry.value : undefined;
			// staleAge in seconds (keep decimal for sub-second precision)
			const staleAge = isStale ? (now - entry.createdAt) / 1000 : undefined;

			// Create factory context
			const ctx = createFactoryContext<T>(staleValue, staleAge);

			try {
				// Call factory with timeout (default 1s for cache operations)
				const timeoutMs = config.timeout ?? 1000;
				const value = await withTimeout(factory(ctx), timeoutMs);

				// Cache the result
				await this.setEntry(config, params, cacheKey, value);

				return value;
			} catch (error) {
				// Handle skip sentinel
				if (error === SKIP_SENTINEL) {
					return undefined;
				}

				// Handle fail with stale fallback
				if (error instanceof CacheFailError && staleValue !== undefined) {
					// Return stale value on failure
					return staleValue;
				}

				// Handle timeout with stale fallback
				if (error instanceof CacheTimeoutError && staleValue !== undefined) {
					// Return stale value on timeout
					return staleValue;
				}

				// Re-throw other errors
				throw error;
			}
		});
	}

	/**
	 * Get a value directly from cache (no factory)
	 *
	 * @param config - Cache configuration
	 * @param params - Parameters for cache key
	 * @returns Cached value or undefined if not found/expired
	 */
	async get<T, TParams extends object>(
		config: CacheConfig<TParams>,
		params: TParams
	): Promise<T | undefined> {
		const cacheKey = generateCacheKey(config, params);
		const entry = await this.getEntry<T>(cacheKey);

		if (!entry) {
			return undefined;
		}

		// Check if expired (but still within grace period for stale reads)
		const now = Date.now();
		if (entry.expiresAt > now) {
			return entry.value;
		}

		// Check grace period
		if (entry.graceExpiresAt && entry.graceExpiresAt > now) {
			return entry.value;
		}

		return undefined;
	}

	/**
	 * Set a value directly in cache
	 *
	 * @param config - Cache configuration
	 * @param params - Parameters for cache key
	 * @param value - Value to cache
	 */
	async set<T, TParams extends object>(
		config: CacheConfig<TParams>,
		params: TParams,
		value: T
	): Promise<void> {
		const cacheKey = generateCacheKey(config, params);
		await this.setEntry(config, params, cacheKey, value);
	}

	/**
	 * Delete a cache entry
	 *
	 * @param config - Cache configuration
	 * @param params - Parameters for cache key
	 * @returns True if entry was deleted
	 */
	async delete<TParams extends object>(config: CacheConfig<TParams>, params: TParams): Promise<boolean> {
		const cacheKey = generateCacheKey(config, params);
		const deleted = await this.provider.del(cacheKey);
		return deleted > 0;
	}

	/**
	 * Invalidate cache entries for an entity
	 *
	 * **Cascade Mechanism (RedisCacheProvider only):**
	 * 1. Generates a meta key: `cache:meta:{entityType}:{param1}:{param2}:...`
	 * 2. Meta key is a Redis SET containing all cache keys that depend on this entity
	 * 3. SMEMBERS retrieves dependent keys, DEL removes them all atomically
	 * 4. Returns count of deleted cache entries
	 *
	 * **InMemoryCacheProvider:**
	 * Only direct deletion is performed (no cascade support).
	 * Returns 0 or 1 depending on whether the meta key existed.
	 *
	 * @template TEntityName - The entity type string (consumer-defined)
	 * @template TParams - The parameters object type
	 * @param entityType - The entity type to invalidate
	 * @param params - Scope parameters (e.g., { accountUuid, projectUuid } or custom scope)
	 * @param options - Invalidation options (cascade defaults to true)
	 * @returns Number of cache entries deleted (0 if none found)
	 *
	 * @example
	 * // Cascade invalidation (default) - deletes entity and all dependents
	 * await cacheService.invalidate('User', { accountUuid: 'abc' });
	 *
	 * // Direct only - just delete this entity's cache
	 * await cacheService.invalidate('UserPresence', { accountUuid, userUuid }, { cascade: false });
	 */
	async invalidate<TEntityName extends string, TParams extends object>(
		entityType: TEntityName,
		params: TParams,
		options: InvalidateOptions = {}
	): Promise<number> {
		const { cascade = true } = options;

		// Generate meta key for this entity
		const metaKey = generateMetaKey(entityType, params);

		// Cascade: use Redis-specific delByMeta if available
		if (cascade && hasMetaSupport(this.provider)) {
			// Get entity's invalidationTags and generate tag meta keys
			const invalidationTags = getEntityInvalidationTags(entityType, params as Record<string, unknown>);
			const tagMetaKeys = invalidationTags.map(generateTagMetaKey);

			// Invalidate both entity meta key AND tag meta keys
			if (tagMetaKeys.length > 0) {
				const allMetaKeys = [metaKey, ...tagMetaKeys];
				return await this.provider.delByMetaMany(allMetaKeys);
			}

			return await this.provider.delByMeta(metaKey);
		}

		// Direct deletion only (or InMemory provider)
		return await this.provider.del(metaKey);
	}

	/**
	 * Invalidate multiple entities at once
	 *
	 * Cascades by default. For non-cascade behavior, call invalidate()
	 * individually with { cascade: false }.
	 *
	 * @template TEntityName - The entity type string (consumer-defined)
	 * @template TParams - The parameters object type
	 * @param invalidations - Array of entity + params to invalidate
	 * @param options - Invalidation options (cascade defaults to true)
	 * @returns Total number of entries deleted
	 */
	async invalidateMany<TEntityName extends string, TParams extends object>(
		invalidations: Array<{
			entityType: TEntityName;
			params: TParams;
		}>,
		options: InvalidateOptions = {}
	): Promise<number> {
		const { cascade = true } = options;

		const metaKeys = invalidations.map((inv) => generateMetaKey(inv.entityType, inv.params));

		// Cascade: use Redis-specific delByMetaMany if available
		if (cascade && hasMetaSupport(this.provider)) {
			return await this.provider.delByMetaMany(metaKeys);
		}

		// Direct deletion only (or InMemory provider)
		return await this.provider.delMany(metaKeys);
	}

	// ══════════════════════════════════════════════════════════════════════════
	// INTERNAL METHODS
	// ══════════════════════════════════════════════════════════════════════════

	/**
	 * Get a cache entry (internal format with metadata)
	 */
	private async getEntry<T>(cacheKey: string): Promise<CacheEntry<T> | null> {
		return await this.provider.get<CacheEntry<T>>(cacheKey);
	}

	/**
	 * Set a cache entry with metadata and meta key associations
	 *
	 * When using RedisCacheProvider, also stores meta key associations
	 * for dependency tracking and cascade invalidation.
	 */
	private async setEntry<T, TParams extends object>(
		config: CacheConfig<TParams>,
		params: TParams,
		cacheKey: string,
		value: T
	): Promise<void> {
		// Check if we should cache null/undefined
		if ((value === null || value === undefined) && !config.cacheNull) {
			return;
		}

		const now = Date.now();
		const graceSeconds = config.grace || this.defaultGraceSeconds;

		// Create cache entry with metadata
		const entry: CacheEntry<T> = {
			value,
			createdAt: now,
			expiresAt: now + config.ttl * 1000,
			graceExpiresAt: graceSeconds > 0 ? now + (config.ttl + graceSeconds) * 1000 : undefined
		};

		// Total TTL includes grace period
		const totalTtl = config.ttl + graceSeconds;

		// Redis: store with meta key associations for dependency tracking
		if (hasMetaSupport(this.provider)) {
			const metaKeys = this.generateMetaKeys(config, params);
			await this.provider.setWithMeta(cacheKey, entry, totalTtl, metaKeys);
		} else {
			// Other providers: simple set without dependency tracking
			await this.provider.set(cacheKey, entry, totalTtl);
		}
	}

	/**
	 * Generate meta keys for a cache entry based on its dependencies
	 *
	 * Uses config.metaParams to determine which params are used for the
	 * entity's own meta key (invalidation granularity).
	 *
	 * Also generates tag meta keys if config.tags is defined.
	 */
	private generateMetaKeys<TParams extends object>(config: CacheConfig<TParams>, params: TParams): string[] {
		const metaKeys: string[] = [];

		// Generate meta key for the entity itself using config.metaParams
		const selfMetaKey = generateConfigMetaKey(config, params);
		metaKeys.push(selfMetaKey);

		// Generate meta keys for each dependency
		for (const [entityType, paramKeys] of Object.entries(config.dependsOn)) {
			if (!paramKeys || paramKeys.length === 0) continue;

			// Extract relevant params for this dependency
			const depParams: Record<string, unknown> = {};
			for (const key of paramKeys) {
				const value = params[key as keyof TParams];
				if (value !== undefined) {
					depParams[key as string] = value;
				}
			}

			const depMetaKey = generateMetaKey(entityType, depParams);
			if (!metaKeys.includes(depMetaKey)) {
				metaKeys.push(depMetaKey);
			}
		}

		// Generate tag meta keys if config.tags is defined
		if (config.tags) {
			const tags = config.tags(params);
			for (const tag of tags) {
				const tagMetaKey = generateTagMetaKey(tag);
				if (!metaKeys.includes(tagMetaKey)) {
					metaKeys.push(tagMetaKey);
				}
			}
		}

		return metaKeys;
	}
}
