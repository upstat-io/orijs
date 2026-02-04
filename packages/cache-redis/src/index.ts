/**
 * @orijs/cache-redis - Redis cache provider for OriJS
 *
 * Provides Redis-backed caching with dependency tracking via meta keys.
 * Each provider creates and manages its own Redis connection.
 *
 * @example
 * import { createRedisCacheProvider } from '@orijs/cache-redis';
 * import { CacheService } from '@orijs/cache';
 *
 * const provider = createRedisCacheProvider({
 *   connection: { host: 'localhost', port: 6379 }
 * });
 * const cacheService = new CacheService(provider);
 */

// Re-export Redis for cases where direct Redis access is needed
export { Redis } from 'ioredis';

export {
	RedisCacheProvider,
	createRedisCacheProvider,
	type RedisCacheProviderOptions,
	type RedisConnectionOptions
} from './redis-cache';
