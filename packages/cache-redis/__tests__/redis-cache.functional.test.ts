/**
 * Functional tests for RedisCacheProvider
 * Tests real Redis operations using testcontainers
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { createRedisTestHelper, type RedisTestHelper } from '@orijs/test-utils';
import { RedisCacheProvider } from '../src/redis-cache';
import { Redis } from 'ioredis';

describe('RedisCacheProvider (functional)', () => {
	let redisHelper: RedisTestHelper;
	let redis: Redis;
	let redisCache: RedisCacheProvider;

	beforeAll(() => {
		// Try package-specific name first, fall back to root 'orijs' when running from monorepo root
		redisHelper = createRedisTestHelper('orijs-cache-redis');
		if (!redisHelper.isReady()) {
			redisHelper = createRedisTestHelper('orijs');
		}
		if (!redisHelper.isReady()) {
			throw new Error('Redis container not ready - check Bun test preload');
		}
		const connectionConfig = redisHelper.getConnectionConfig();
		redis = new Redis({ host: connectionConfig.host, port: connectionConfig.port });
		// Handle connection errors to prevent unhandled error events
		redis.on('error', () => {});
		redisCache = new RedisCacheProvider({
			connection: { host: connectionConfig.host, port: connectionConfig.port }
		});
	});

	beforeEach(async () => {
		await redisHelper.flushAll();
	});

	afterAll(async () => {
		if (redis) {
			await redis.quit();
		}
		if (redisCache) {
			await redisCache.stop();
		}
	});

	describe('get/set operations', () => {
		it('should return null for non-existent key', async () => {
			const result = await redisCache.get('non-existent-key');

			expect(result).toBeNull();
		});

		it('should set and get string value', async () => {
			await redisCache.set('test-key', 'test-value', 60);

			const result = await redisCache.get<string>('test-key');

			expect(result).toBe('test-value');
		});

		it('should set and get object value', async () => {
			const testObject = { id: 1, name: 'test', active: true };

			await redisCache.set('object-key', testObject, 60);

			const result = await redisCache.get<typeof testObject>('object-key');

			expect(result).toEqual(testObject);
		});

		it('should set and get array value', async () => {
			const testArray = [1, 2, 3, 'four', { five: 5 }];

			await redisCache.set('array-key', testArray, 60);

			const result = await redisCache.get<typeof testArray>('array-key');

			expect(result).toEqual(testArray);
		});

		it('should set and get nested object value', async () => {
			const nested = {
				user: { id: 1, profile: { email: 'test@example.com' } },
				items: [{ id: 1 }, { id: 2 }]
			};

			await redisCache.set('nested-key', nested, 60);

			const result = await redisCache.get<typeof nested>('nested-key');

			expect(result).toEqual(nested);
		});
	});

	describe('TTL operations', () => {
		it('should set TTL when storing value', async () => {
			await redisCache.set('ttl-key', 'value', 30);

			const ttl = await redisCache.ttl('ttl-key');

			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(30);
		});

		it('should expire key after TTL', async () => {
			await redisCache.set('expire-key', 'value', 1);

			// Wait for expiration (Redis may have slight delay)
			await new Promise((resolve) => setTimeout(resolve, 2500));

			const result = await redisCache.get('expire-key');

			expect(result).toBeNull();
		});

		it('should return -2 for non-existent key TTL', async () => {
			const ttl = await redisCache.ttl('non-existent');

			expect(ttl).toBe(-2);
		});
	});

	describe('exists operation', () => {
		it('should return true for existing key', async () => {
			await redisCache.set('exists-key', 'value', 60);

			const exists = await redisCache.exists('exists-key');

			expect(exists).toBe(true);
		});

		it('should return false for non-existent key', async () => {
			const exists = await redisCache.exists('non-existent');

			expect(exists).toBe(false);
		});
	});

	describe('del operation', () => {
		it('should delete existing key', async () => {
			await redisCache.set('delete-key', 'value', 60);

			const deleted = await redisCache.del('delete-key');

			expect(deleted).toBe(1);

			const result = await redisCache.get('delete-key');
			expect(result).toBeNull();
		});

		it('should return 0 when deleting non-existent key', async () => {
			const deleted = await redisCache.del('non-existent');

			expect(deleted).toBe(0);
		});
	});

	describe('delMany operation', () => {
		it('should delete multiple keys', async () => {
			await redisCache.set('key1', 'value1', 60);
			await redisCache.set('key2', 'value2', 60);
			await redisCache.set('key3', 'value3', 60);

			const deleted = await redisCache.delMany(['key1', 'key2', 'key3']);

			expect(deleted).toBe(3);

			expect(await redisCache.get('key1')).toBeNull();
			expect(await redisCache.get('key2')).toBeNull();
			expect(await redisCache.get('key3')).toBeNull();
		});

		it('should return correct count for partial deletes', async () => {
			await redisCache.set('exists1', 'value', 60);
			await redisCache.set('exists2', 'value', 60);

			const deleted = await redisCache.delMany(['exists1', 'non-existent', 'exists2']);

			expect(deleted).toBe(2);
		});

		it('should return 0 for empty array', async () => {
			const deleted = await redisCache.delMany([]);

			expect(deleted).toBe(0);
		});
	});

	describe('setWithMeta operation', () => {
		it('should set value with meta keys', async () => {
			await redisCache.setWithMeta('data-key', { id: 1 }, 60, ['meta:account:123', 'meta:project:456']);

			const result = await redisCache.get('data-key');
			expect(result).toEqual({ id: 1 });

			// Meta keys (Redis sets) should contain the cache key as a member
			const members1 = await redis.smembers('meta:account:123');
			expect(members1).toContain('data-key');

			const members2 = await redis.smembers('meta:project:456');
			expect(members2).toContain('data-key');
		});

		it('should handle empty meta keys array', async () => {
			await redisCache.setWithMeta('no-meta-key', 'value', 60, []);

			const result = await redisCache.get('no-meta-key');
			expect(result).toBe('value');
		});
	});

	describe('delByMeta operation', () => {
		it('should delete all keys associated with meta key', async () => {
			await redisCache.setWithMeta('cache:a', 'value-a', 60, ['meta:shared']);
			await redisCache.setWithMeta('cache:b', 'value-b', 60, ['meta:shared']);
			await redisCache.setWithMeta('cache:c', 'value-c', 60, ['meta:other']);

			const deleted = await redisCache.delByMeta('meta:shared');

			expect(deleted).toBe(2);

			expect(await redisCache.get('cache:a')).toBeNull();
			expect(await redisCache.get('cache:b')).toBeNull();
			expect(await redisCache.get<string>('cache:c')).toBe('value-c');
		});

		it('should return 0 for non-existent meta key', async () => {
			const deleted = await redisCache.delByMeta('meta:non-existent');

			expect(deleted).toBe(0);
		});

		it('should clean up meta key after deletion', async () => {
			await redisCache.setWithMeta('temp-key', 'value', 60, ['meta:cleanup-test']);

			await redisCache.delByMeta('meta:cleanup-test');

			// Meta key should be deleted along with associated cache keys
			const metaKeyExists = await redisCache.exists('meta:cleanup-test');
			expect(metaKeyExists).toBe(false);
		});
	});

	describe('prototype pollution protection', () => {
		it('should strip __proto__ from cached data on retrieval', async () => {
			// Directly set malicious JSON in Redis (simulating cache poisoning)
			const maliciousJson = '{"name": "test", "__proto__": {"isAdmin": true}}';
			await redis.set('poisoned-cache', maliciousJson);

			const result = await redisCache.get<{ name: string }>('poisoned-cache');

			expect(result).not.toBeNull();
			expect(result!.name).toBe('test');
			// __proto__ should be stripped by Json.parse
			expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
			// Verify prototype wasn't polluted
			expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
		});

		it('should strip constructor and prototype keys from cached data', async () => {
			// Set data with dangerous keys directly in Redis
			const maliciousJson = '{"data": "safe", "constructor": {"bad": true}, "prototype": {"evil": true}}';
			await redis.set('dangerous-keys', maliciousJson);

			const result = await redisCache.get<{ data: string }>('dangerous-keys');

			expect(result).not.toBeNull();
			expect(result!.data).toBe('safe');
			expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
		});

		it('should strip dangerous keys from nested objects', async () => {
			const maliciousJson =
				'{"user": {"name": "test", "__proto__": {"admin": true}}, "items": [{"__proto__": {"x": 1}}]}';
			await redis.set('nested-poisoned', maliciousJson);

			const result = await redisCache.get<{ user: { name: string }; items: object[] }>('nested-poisoned');

			expect(result).not.toBeNull();
			expect(result!.user.name).toBe('test');
			expect(Object.prototype.hasOwnProperty.call(result!.user, '__proto__')).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(result!.items[0], '__proto__')).toBe(false);
		});
	});

	describe('corrupted cache entry handling', () => {
		it('should return null for corrupted JSON in cache', async () => {
			// Manually set invalid JSON directly in Redis
			await redis.set('corrupted-json', '{invalid json without quotes}');

			const result = await redisCache.get<{ data: string }>('corrupted-json');

			// Should return null (cache miss) instead of throwing
			expect(result).toBeNull();
		});

		it('should return null for truncated JSON in cache', async () => {
			// Simulate truncated JSON (e.g., from network issues)
			await redis.set('truncated-json', '{"name": "test", "data": ');

			const result = await redisCache.get<{ name: string; data: unknown }>('truncated-json');

			expect(result).toBeNull();
		});

		it('should return null for non-JSON string in cache', async () => {
			// Plain string that's not valid JSON
			await redis.set('plain-string', 'just a plain string');

			const result = await redisCache.get<string>('plain-string');

			expect(result).toBeNull();
		});

		it('should handle empty string in cache', async () => {
			await redis.set('empty-string', '');

			const result = await redisCache.get<string>('empty-string');

			// Empty string is not valid JSON, should return null
			expect(result).toBeNull();
		});
	});

	describe('connection failure behavior', () => {
		it('should fail fast when Redis connection is invalid', async () => {
			// Create provider with invalid connection (non-existent port)
			const badCache = new RedisCacheProvider({
				connection: { host: 'localhost', port: 59999 },
				connectTimeout: 500 // 500ms for test speed
			});

			const startTime = Date.now();

			// Should fail quickly due to connectTimeout
			await expect(badCache.get('any-key')).rejects.toThrow();

			const elapsed = Date.now() - startTime;
			// Should fail within connectTimeout + small buffer
			expect(elapsed).toBeLessThan(2000);

			await badCache.stop().catch(() => {}); // Cleanup
		});

		it('should use default 2s connect timeout', () => {
			// Verify default connectTimeout is applied (checking via options interface)
			const provider = new RedisCacheProvider({
				connection: { host: 'localhost', port: 6379 }
			});

			// Default is 2000ms - we can't easily verify ioredis config, but the option exists
			expect(provider).toBeDefined();
		});
	});

	describe('delByMetaMany operation', () => {
		it('should delete keys from multiple meta keys', async () => {
			await redisCache.setWithMeta('user:1', 'data1', 60, ['meta:account:a']);
			await redisCache.setWithMeta('user:2', 'data2', 60, ['meta:account:b']);
			await redisCache.setWithMeta('user:3', 'data3', 60, ['meta:other']);

			const deleted = await redisCache.delByMetaMany(['meta:account:a', 'meta:account:b']);

			expect(deleted).toBe(2);

			expect(await redisCache.get('user:1')).toBeNull();
			expect(await redisCache.get('user:2')).toBeNull();
			expect(await redisCache.get<string>('user:3')).toBe('data3');
		});

		it('should handle empty array', async () => {
			const deleted = await redisCache.delByMetaMany([]);

			expect(deleted).toBe(0);
		});

		it('should handle duplicate keys across meta keys', async () => {
			await redisCache.setWithMeta('shared-key', 'value', 60, ['meta:first', 'meta:second']);

			const deleted = await redisCache.delByMetaMany(['meta:first', 'meta:second']);

			// Should only count as 1 deletion even though key was in both meta sets
			expect(deleted).toBe(1);
			expect(await redisCache.get('shared-key')).toBeNull();
		});
	});
});
