/**
 * In-Memory Cache Provider - Memory-backed Cache Implementation
 *
 * Implements the CacheProvider interface with in-memory storage.
 * Useful for testing and development where Redis is not available.
 *
 * Features:
 * - Automatic TTL expiration
 * - No external dependencies
 * - Thread-safe for single Node.js process
 *
 * Limitations:
 * - No persistence (data lost on restart)
 * - No dependency tracking / cascade invalidation
 * - Not shared across processes
 *
 * @example
 * const provider = new InMemoryCacheProvider();
 * const cacheService = new CacheService(provider);
 *
 * // Works like Redis provider for basic operations
 * await cacheService.getOrSet(config, params, factory);
 */

import type { CacheProvider } from './types';

interface CacheEntry<T> {
	value: T;
	expiresAt: number | null; // null = no expiration
}

/**
 * In-memory cache provider for testing and development
 *
 * Implements CacheProvider interface with Map-based storage.
 * Does NOT support dependency tracking (cascade invalidation is a no-op).
 */
export class InMemoryCacheProvider implements CacheProvider {
	private readonly store = new Map<string, CacheEntry<unknown>>();

	/**
	 * Get a value from cache
	 *
	 * @param key - The cache key
	 * @returns The value, or null if not found/expired
	 */
	async get<T>(key: string): Promise<T | null> {
		const entry = this.store.get(key);
		if (!entry) {
			return null;
		}

		// Check expiration
		if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return null;
		}

		return entry.value as T;
	}

	/**
	 * Set a value in cache
	 *
	 * @param key - The cache key
	 * @param value - The value to cache
	 * @param ttlSeconds - Time-to-live in seconds (0 for no expiration)
	 */
	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		const entry: CacheEntry<T> = {
			value,
			expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null
		};
		this.store.set(key, entry);
	}

	/**
	 * Delete a key from cache
	 *
	 * @param key - The cache key to delete
	 * @returns Number of keys deleted (0 or 1)
	 */
	async del(key: string): Promise<number> {
		return this.store.delete(key) ? 1 : 0;
	}

	/**
	 * Delete multiple keys from cache
	 *
	 * @param keys - The cache keys to delete
	 * @returns Number of keys deleted
	 */
	async delMany(keys: string[]): Promise<number> {
		let count = 0;
		for (const key of keys) {
			if (this.store.delete(key)) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Check if a key exists in cache
	 *
	 * @param key - The cache key
	 * @returns True if key exists and not expired
	 */
	async exists(key: string): Promise<boolean> {
		const entry = this.store.get(key);
		if (!entry) {
			return false;
		}

		// Check expiration
		if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return false;
		}

		return true;
	}

	/**
	 * Get the remaining TTL of a key in seconds
	 *
	 * @param key - The cache key
	 * @returns TTL in seconds, -1 if no expiry, -2 if key doesn't exist
	 */
	async ttl(key: string): Promise<number> {
		const entry = this.store.get(key);
		if (!entry) {
			return -2;
		}

		// Check expiration
		if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return -2;
		}

		if (entry.expiresAt === null) {
			return -1;
		}

		return Math.ceil((entry.expiresAt - Date.now()) / 1000);
	}

	/**
	 * Clear all entries from cache
	 *
	 * Useful for testing - reset cache between tests.
	 */
	clear(): void {
		this.store.clear();
	}

	/**
	 * Get the number of entries in cache (including expired)
	 *
	 * Useful for testing and debugging.
	 */
	get size(): number {
		return this.store.size;
	}
}
