/**
 * Redis Cache Provider - Redis-backed Cache Implementation
 *
 * Implements the CacheProvider interface with Redis backend.
 * Also provides Redis-specific features for dependency tracking via meta keys.
 *
 * NOTE: This is the LOW-LEVEL cache layer. For high-level operations
 * with getOrSet, singleflight, and FactoryContext, use CacheService.
 *
 * Meta keys are Redis sets that track which cache keys depend on a given entity.
 * When an entity changes, we use delByMeta to find and delete all dependent caches.
 * This is a Redis-specific feature not part of the generic CacheProvider interface.
 *
 * @example
 * const redis = new Redis();
 * const provider = new RedisCacheProvider(redis);
 *
 * // Basic operations (CacheProvider interface)
 * await provider.set('key', { data: 'value' }, 300);  // 5 minute TTL
 * const result = await provider.get<{ data: string }>('key');
 * await provider.del('key');
 *
 * // Redis-specific: meta keys for dependency tracking
 * await provider.setWithMeta(
 *   'cache:abc123xyz',
 *   productData,
 *   300,
 *   ['cache:meta:product123']  // Associate with product entity
 * );
 *
 * // When product changes, delete all dependent caches
 * await provider.delByMeta('cache:meta:product123');
 */

import { Redis } from 'ioredis';
import type { Logger } from '@orijs/logging';
import type { CacheProvider } from '@orijs/cache';
import { Json } from '@orijs/validation';

/**
 * Buffer added to TTL for meta keys to ensure they outlive data keys.
 * This prevents orphaned meta keys while ensuring dependency tracking works.
 */
const META_KEY_TTL_BUFFER_SECONDS = 60;

/**
 * Connection options for Redis.
 */
export interface RedisConnectionOptions {
	readonly host: string;
	readonly port: number;
}

/**
 * Options for creating a RedisCacheProvider instance
 */
export interface RedisCacheProviderOptions {
	/** Redis connection configuration */
	readonly connection: RedisConnectionOptions;
	/** Optional logger for error reporting. If not provided, errors are silently ignored. */
	readonly logger?: Logger;
	/** Connection timeout in milliseconds (default: 2000ms). Fail fast if Redis is unavailable. */
	readonly connectTimeout?: number;
}

/**
 * Redis-backed cache provider
 *
 * Implements CacheProvider interface with Redis backend.
 * Creates and manages its own Redis connection from config.
 * Also provides Redis-specific meta key operations for dependency tracking.
 * Use CacheService for high-level operations with getOrSet.
 */
export class RedisCacheProvider implements CacheProvider {
	private readonly redis: Redis;
	private readonly logger?: Logger;

	constructor(options: RedisCacheProviderOptions) {
		// Default 2s connect timeout - fail fast if Redis unavailable
		const connectTimeout = options.connectTimeout ?? 2000;
		this.redis = new Redis({
			...options.connection,
			connectTimeout,
			maxRetriesPerRequest: 1 // Fail fast on connection issues
		});
		this.logger = options.logger;

		// Handle connection errors to prevent unhandled error events.
		// Operations will still throw/reject - this just prevents the
		// global 'error' event from becoming an unhandled exception.
		this.redis.on('error', (err) => {
			this.logger?.warn('Redis connection error', { error: err.message });
		});
	}

	/**
	 * Get a value from cache
	 *
	 * @param key - The cache key
	 * @returns The deserialized value, or null if not found/corrupted
	 */
	async get<T>(key: string): Promise<T | null> {
		const value = await this.redis.get(key);
		if (value === null) {
			return null;
		}
		try {
			// Use Json.parse for prototype pollution protection
			return Json.parse<T>(value);
		} catch {
			// Corrupted cache entry - treat as cache miss
			return null;
		}
	}

	/**
	 * Set a value in cache
	 *
	 * @param key - The cache key
	 * @param value - The value to cache (will be JSON serialized)
	 * @param ttlSeconds - Time-to-live in seconds (0 for no expiration, supports fractional)
	 */
	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		const serialized = JSON.stringify(value);
		if (ttlSeconds > 0) {
			// Use PSETEX (milliseconds) for sub-second precision
			const ttlMs = Math.ceil(ttlSeconds * 1000);
			await this.redis.psetex(key, ttlMs, serialized);
		} else {
			await this.redis.set(key, serialized);
		}
	}

	/**
	 * Delete a key from cache
	 *
	 * @param key - The cache key to delete
	 * @returns Number of keys deleted (0 or 1)
	 */
	async del(key: string): Promise<number> {
		return await this.redis.del(key);
	}

	/**
	 * Delete multiple keys from cache
	 *
	 * @param keys - The cache keys to delete
	 * @returns Number of keys deleted
	 */
	async delMany(keys: string[]): Promise<number> {
		if (keys.length === 0) {
			return 0;
		}
		return await this.redis.del(...keys);
	}

	/**
	 * Set a value and associate it with meta keys for dependency tracking
	 *
	 * Meta keys are Redis sets that store references to cache keys.
	 * This allows efficient lookup of all caches that depend on a given entity.
	 *
	 * @param key - The cache key
	 * @param value - The value to cache
	 * @param ttlSeconds - Time-to-live in seconds
	 * @param metaKeys - Meta keys to associate with this cache entry
	 */
	async setWithMeta(key: string, value: unknown, ttlSeconds: number, metaKeys: string[]): Promise<void> {
		const pipeline = this.redis.pipeline();
		const serialized = JSON.stringify(value);

		// Store the cache value
		if (ttlSeconds > 0) {
			// Use PSETEX (milliseconds) for sub-second precision
			const ttlMs = Math.ceil(ttlSeconds * 1000);
			pipeline.psetex(key, ttlMs, serialized);
		} else {
			pipeline.set(key, serialized);
		}

		// Add cache key to each meta key set
		// Also set TTL on meta keys to prevent orphaned sets
		for (const metaKey of metaKeys) {
			pipeline.sadd(metaKey, key);
			if (ttlSeconds > 0) {
				// Give meta keys slightly longer TTL to outlive cache entries
				// Meta keys use integer seconds (ceiling + buffer is always >= 1 second)
				const metaTtlSeconds = Math.ceil(ttlSeconds) + META_KEY_TTL_BUFFER_SECONDS;
				pipeline.expire(metaKey, metaTtlSeconds);
			}
		}

		const results = await pipeline.exec();
		// Check for pipeline errors (results is array of [error, value] tuples)
		if (results) {
			for (const [err] of results) {
				if (err) {
					// Log but don't throw - cache operations should be resilient
					this.logger?.warn('Redis pipeline operation failed', { error: err.message });
				}
			}
		}
	}

	/**
	 * Delete all cache entries associated with a meta key
	 *
	 * Used for cascade invalidation: when an entity changes,
	 * delete all caches that depend on it.
	 *
	 * Uses Lua script for atomic operation in a single round-trip.
	 * This is ~50-65% faster than SMEMBERS + pipeline DEL approach.
	 *
	 * @param metaKey - The meta key (Redis set of cache keys)
	 * @returns Number of cache entries deleted
	 */
	async delByMeta(metaKey: string): Promise<number> {
		return this.delByMetaMany([metaKey]);
	}

	/**
	 * Lua script for atomic deletion of cache entries by meta keys.
	 * Prevents race condition where new keys could be added between
	 * SMEMBERS lookup and DEL operations.
	 *
	 * KEYS: meta keys to process
	 * Returns: number of cache entries deleted
	 */
	private static readonly DEL_BY_META_SCRIPT = `
		local cacheKeys = {}
		local seen = {}

		-- Gather all cache keys from all meta sets
		for i, metaKey in ipairs(KEYS) do
			local members = redis.call('SMEMBERS', metaKey)
			for j, member in ipairs(members) do
				if not seen[member] then
					seen[member] = true
					table.insert(cacheKeys, member)
				end
			end
		end

		-- Delete all cache keys
		local deleted = 0
		for i, cacheKey in ipairs(cacheKeys) do
			deleted = deleted + redis.call('DEL', cacheKey)
		end

		-- Delete all meta keys
		for i, metaKey in ipairs(KEYS) do
			redis.call('DEL', metaKey)
		end

		return deleted
	`;

	/**
	 * Delete all cache entries for multiple meta keys
	 *
	 * Uses a Lua script for atomic operation - prevents race condition
	 * where new keys could be added between lookup and deletion.
	 *
	 * @param metaKeys - Array of meta keys to process
	 * @returns Total number of cache entries deleted
	 */
	async delByMetaMany(metaKeys: string[]): Promise<number> {
		if (metaKeys.length === 0) {
			return 0;
		}

		try {
			const result = await this.redis.eval(
				RedisCacheProvider.DEL_BY_META_SCRIPT,
				metaKeys.length,
				...metaKeys
			);
			return typeof result === 'number' ? result : 0;
		} catch (error) {
			this.logger?.warn('Redis Lua script failed', {
				error: error instanceof Error ? error.message : 'Unknown error'
			});
			return 0;
		}
	}

	/**
	 * Check if a key exists in cache
	 *
	 * @param key - The cache key
	 * @returns True if key exists
	 */
	async exists(key: string): Promise<boolean> {
		const result = await this.redis.exists(key);
		return result === 1;
	}

	/**
	 * Get the remaining TTL of a key in seconds
	 *
	 * @param key - The cache key
	 * @returns TTL in seconds, -1 if no expiry, -2 if key doesn't exist
	 */
	async ttl(key: string): Promise<number> {
		return await this.redis.ttl(key);
	}

	/**
	 * Gracefully close Redis connection.
	 * Call during application shutdown.
	 */
	async stop(): Promise<void> {
		try {
			if (this.redis && this.redis.status === 'ready') {
				await this.redis.quit();
			}
		} catch {
			// Force disconnect if quit fails
			this.redis?.disconnect();
		}
	}
}

/**
 * Factory function to create RedisCacheProvider.
 * Consistent with createBullMQWorkflowProvider pattern.
 */
export function createRedisCacheProvider(options: RedisCacheProviderOptions): RedisCacheProvider {
	return new RedisCacheProvider(options);
}

// Backwards compatibility aliases
/** @deprecated Use RedisCacheProvider instead */
export const RedisCache = RedisCacheProvider;
/** @deprecated Use RedisCacheProviderOptions instead */
export type RedisCacheOptions = RedisCacheProviderOptions;
