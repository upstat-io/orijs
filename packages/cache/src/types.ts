/**
 * Cache System Types
 *
 * Core type definitions for the OriJS cache system.
 * Designed for full type safety with generic parameters.
 *
 * Key Design Points:
 * - Factory is NOT in CacheConfig - it's provided at getOrSet() call site
 * - Scope is GENERIC - apps define their own scope config
 * - Params are type-checked against TParams interface
 * - Meta params are explicitly specified for invalidation granularity
 * - Entity names are GENERIC - consumers define their own entity types
 */

// --- DURATION ---

/**
 * Human-readable duration or seconds
 *
 * @example
 * '5m'   // 5 minutes
 * '1h'   // 1 hour
 * '30s'  // 30 seconds
 * '1d'   // 1 day
 * 300    // 300 seconds
 * '0'    // Zero (no caching)
 */
export type Duration = `${number}${'s' | 'm' | 'h' | 'd'}` | number | '0';

/**
 * Pre-defined TTL values for common use cases.
 *
 * Used as the default constraint for `.ttl()` method.
 * To use custom TTL values, provide your own type:
 *
 * @example
 * ```typescript
 * // Default - only allows DefaultTTL values
 * Cache.for(Entities.Product).ttl('5m').build();  // OK
 * Cache.for(Entities.Product).ttl('32m').build(); // Type error
 *
 * // Custom - define your own allowed values
 * type MyTTL = '2m' | '32m' | '2h';
 * Cache.for(Entities.Product).ttl<MyTTL>('32m').build(); // OK
 * ```
 */
export type DefaultTTL = '30s' | '1m' | '5m' | '15m' | '30m' | '1h' | '6h' | '12h' | '1d' | '7d';

// --- CACHE CONFIGURATION ---

/**
 * Cache configuration (immutable, returned by builder.build())
 *
 * NOTE: Factory is NOT included here. Factory is provided at getOrSet() call site.
 *
 * @template TParams - Type of the parameters object
 * @template TScope - The scope name (string literal type)
 * @template TEntityName - The entity name type (consumer-defined, e.g., 'User' | 'Product')
 */
export interface CacheConfig<
	TParams extends object = object,
	TScope extends string = string,
	TEntityName extends string = string
> {
	/** Entity type (e.g., 'User', 'Product', 'Order') - consumer-defined */
	readonly entity: TEntityName;

	/** Cache scope (app-defined, e.g., 'global', 'account', 'project') */
	readonly scope: TScope;

	/** Time-to-live in seconds */
	readonly ttl: number;

	/** Grace period in seconds for stale-while-revalidate (0 = disabled) */
	readonly grace: number;

	/** Parameter keys used for cache key generation */
	readonly params: readonly (keyof TParams)[];

	/**
	 * Parameter keys used for meta key generation (invalidation granularity)
	 *
	 * Meta keys determine how granular invalidation is:
	 * - ['accountUuid'] → invalidate all caches in account
	 * - ['accountUuid', 'userUuid'] → invalidate only specific user's cache
	 *
	 * Defaults to scope-required params if not specified.
	 */
	readonly metaParams: readonly (keyof TParams)[];

	/** Entity dependencies for cascade invalidation */
	readonly dependsOn: Readonly<Partial<Record<string, readonly (keyof TParams)[]>>>;

	/** Whether to cache null/undefined results */
	readonly cacheNull: boolean;

	/**
	 * Timeout in milliseconds for fetching data on cache miss
	 *
	 * If fetching takes longer than this, a CacheTimeoutError is thrown.
	 * Default: 1000ms (1 second)
	 *
	 * @example
	 * Cache.for(Entities.User).ttl('5m').timeout('10s').build();
	 */
	readonly timeout?: number;

	/**
	 * Tags for cross-scope invalidation
	 *
	 * When another entity is invalidated and its invalidationTags match this cache's tags,
	 * this cache entry will also be invalidated.
	 *
	 * @example
	 * // Cache tagged with user's fbAuthUid
	 * Cache.for(Entities.UserAuth).ttl('1h').tags(params => [`user:${params.fbAuthUid}`]).build();
	 *
	 * // When User entity with invalidationTags: (p) => [`user:${p.fbAuthUid}`] is invalidated,
	 * // this UserAuth cache will also be cleared
	 */
	readonly tags?: (params: TParams) => string[];
}

// --- FACTORY CONTEXT ---

/**
 * Context passed to factory function during cache miss
 *
 * Provides control over cache behavior:
 * - skip(): Don't cache the result
 * - fail(): Signal error but use stale value if in grace period
 * - staleValue: Access stale data during grace period
 * - staleAge: How old the stale value is
 *
 * @template T - Type of the cached value
 */
export interface FactoryContext<T = unknown> {
	/**
	 * Don't cache this result, return undefined to caller
	 * Use when the factory determines the value shouldn't be cached
	 *
	 * @example
	 * if (!user) return ctx.skip();
	 */
	skip(): never;

	/**
	 * Signal error but preserve stale value if within grace period
	 * If no stale value, the error will be thrown
	 *
	 * @example
	 * if (dbError && ctx.staleValue) return ctx.fail('DB unavailable');
	 */
	fail(message: string): never;

	/**
	 * Access stale value when within grace period
	 * Undefined if no stale value or outside grace period
	 */
	readonly staleValue: T | undefined;

	/**
	 * How old the stale value is (in seconds)
	 * Undefined if no stale value
	 */
	readonly staleAge: number | undefined;
}

// --- CACHE SERVICE OPTIONS ---

/**
 * Options for CacheService constructor
 */
export interface CacheServiceOptions {
	/** Default grace period if not specified per-cache */
	defaultGrace?: Duration;

	/** Key prefix for all cache keys (default: 'cache') */
	keyPrefix?: string;
}

// --- CACHE ENTRY (Internal) ---

/**
 * Internal cache entry structure stored in Redis
 */
export interface CacheEntry<T> {
	/** The cached value */
	value: T;

	/** Timestamp when this entry was created (ms since epoch) */
	createdAt: number;

	/** Timestamp when this entry expires - TTL (ms since epoch) */
	expiresAt: number;

	/** Timestamp when grace period ends (ms since epoch), undefined if no grace */
	graceExpiresAt?: number;
}

// --- CACHE PROVIDER ---

/**
 * Generic cache provider interface
 *
 * Defines basic cache operations that any backend can implement.
 * Redis-specific features (meta keys, dependency tracking) are NOT part
 * of this interface - they are implementation details of RedisCacheProvider.
 *
 * @example
 * // Redis implementation (production)
 * const provider = new RedisCacheProvider(redis);
 *
 * // InMemory implementation (testing)
 * const provider = new InMemoryCacheProvider();
 *
 * // Both work with CacheService
 * const cacheService = new CacheService(provider);
 */
export interface CacheProvider {
	/**
	 * Get a value from cache
	 *
	 * @param key - The cache key
	 * @returns The deserialized value, or null if not found/expired
	 */
	get<T>(key: string): Promise<T | null>;

	/**
	 * Set a value in cache
	 *
	 * @param key - The cache key
	 * @param value - The value to cache (will be JSON serialized)
	 * @param ttlSeconds - Time-to-live in seconds (0 for no expiration)
	 */
	set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;

	/**
	 * Delete a key from cache
	 *
	 * @param key - The cache key to delete
	 * @returns Number of keys deleted (0 or 1)
	 */
	del(key: string): Promise<number>;

	/**
	 * Delete multiple keys from cache
	 *
	 * @param keys - The cache keys to delete
	 * @returns Number of keys deleted
	 */
	delMany(keys: string[]): Promise<number>;

	/**
	 * Check if a key exists in cache
	 *
	 * @param key - The cache key
	 * @returns True if key exists
	 */
	exists(key: string): Promise<boolean>;

	/**
	 * Get the remaining TTL of a key in seconds
	 *
	 * @param key - The cache key
	 * @returns TTL in seconds, -1 if no expiry, -2 if key doesn't exist
	 */
	ttl(key: string): Promise<number>;
}

/**
 * Extended cache provider interface with meta key support
 *
 * Meta keys enable dependency tracking for cascade invalidation.
 * Providers like RedisCacheProvider implement this interface.
 */
export interface CacheProviderWithMeta extends CacheProvider {
	/**
	 * Set a value and associate it with meta keys for dependency tracking
	 */
	setWithMeta(key: string, value: unknown, ttlSeconds: number, metaKeys: string[]): Promise<void>;

	/**
	 * Delete all cache entries associated with a meta key
	 */
	delByMeta(metaKey: string): Promise<number>;

	/**
	 * Delete all cache entries for multiple meta keys atomically
	 */
	delByMetaMany(metaKeys: string[]): Promise<number>;
}

/**
 * Type guard to check if a provider supports meta key operations
 */
export function hasMetaSupport(provider: CacheProvider): provider is CacheProviderWithMeta {
	return (
		'setWithMeta' in provider &&
		'delByMeta' in provider &&
		'delByMetaMany' in provider &&
		typeof (provider as CacheProviderWithMeta).setWithMeta === 'function' &&
		typeof (provider as CacheProviderWithMeta).delByMeta === 'function' &&
		typeof (provider as CacheProviderWithMeta).delByMetaMany === 'function'
	);
}

// --- KEY PREFIXES ---

/**
 * Cache key prefix for cached values
 * Must match NestJS: cache:{hash}
 */
export const CACHE_KEY_PREFIX = 'cache:';

/**
 * Meta key prefix for dependency tracking sets
 * Must match NestJS: cache:meta:{hash}
 */
export const META_KEY_PREFIX = 'cache:meta:';

/**
 * Tag meta key prefix for cross-scope invalidation
 * Format: cache:tag:{hash}
 */
export const TAG_META_KEY_PREFIX = 'cache:tag:';
