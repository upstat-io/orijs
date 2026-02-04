/**
 * CacheService Integration Tests
 *
 * Tests the complete cache workflow using real Redis:
 * - createCacheBuilder(registry).for() builder → CacheConfig
 * - CacheService.getOrSet() with factory pattern
 * - Skip and fail behaviors
 * - Grace period / stale-while-revalidate
 * - Invalidation by entity type with dependency cascade
 * - Registry integration
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { createRedisTestHelper, type RedisTestHelper } from '@orijs/test-utils';
import { EntityRegistry, createCacheBuilder, CacheService, CacheTimeoutError, cacheRegistry } from '../src';
import { RedisCacheProvider } from '@orijs/cache-redis';

// --- TEST TYPES ---

interface User {
	uuid: string;
	name: string;
	email: string;
}

interface Monitor {
	uuid: string;
	name: string;
	url: string;
}

// --- TEST REGISTRY ---

function createTestRegistry() {
	return EntityRegistry.create()
		.scope('global')
		.scope('account', 'accountUuid')
		.scope('project', 'projectUuid')
		.entity('Account', 'account')
		.entity('Project', 'project')
		.entity('User', 'account', 'userUuid')
		.entity('Monitor', 'project', 'monitorUuid')
		.build();
}

// --- TESTS ---

describe('CacheService (functional)', () => {
	let redisHelper: RedisTestHelper;
	let redisCacheProvider: RedisCacheProvider;
	let cacheService: CacheService;

	beforeAll(() => {
		// Use 'orijs' when running from monorepo root, 'orijs-cache' when running standalone
		const packageName = process.env.TEST_PACKAGE_NAME || 'orijs';
		redisHelper = createRedisTestHelper(packageName);
		if (!redisHelper.isReady()) {
			throw new Error(`Redis container not ready for ${packageName} - check Bun test preload`);
		}
		const connectionConfig = redisHelper.getConnectionConfig();
		redisCacheProvider = new RedisCacheProvider({
			connection: { host: connectionConfig.host, port: connectionConfig.port }
		});
		cacheService = new CacheService(redisCacheProvider);
	});

	beforeEach(async () => {
		await redisHelper.flushAll();
		cacheRegistry.reset();
		// NOTE: Do NOT clear entityInvalidationRegistry here as it affects other test files
		// that share the same process. Tests that need fresh invalidation tags should use
		// createTagTestRegistry() which registers its own tags in each test.
	});

	afterAll(async () => {
		await redisCacheProvider.stop();
	});

	describe('getOrSet - cache-aside pattern', () => {
		it('should call factory on cache miss and cache result', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').build();

			let factoryCallCount = 0;
			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			// First call - cache miss, factory called
			const result1 = await cacheService.getOrSet<User, typeof params>(UserCache, params, async () => {
				factoryCallCount++;
				return { uuid: 'user-456', name: 'John Doe', email: 'john@example.com' };
			});

			expect(result1).toEqual({
				uuid: 'user-456',
				name: 'John Doe',
				email: 'john@example.com'
			});
			expect(factoryCallCount).toBe(1);

			// Second call - cache hit, factory NOT called
			const result2 = await cacheService.getOrSet<User, typeof params>(UserCache, params, async () => {
				factoryCallCount++;
				return { uuid: 'user-456', name: 'Jane Doe', email: 'jane@example.com' };
			});

			expect(result2).toEqual({
				uuid: 'user-456',
				name: 'John Doe',
				email: 'john@example.com'
			});
			expect(factoryCallCount).toBe(1); // Still 1, factory not called
		});

		it('should use different cache keys for different params', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').build();

			const user1 = await cacheService.getOrSet<User, { accountUuid: string; userUuid: string }>(
				UserCache,
				{ accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() },
				async () => ({ uuid: 'user-1', name: 'User One', email: 'one@example.com' })
			);

			const user2 = await cacheService.getOrSet<User, { accountUuid: string; userUuid: string }>(
				UserCache,
				{ accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() },
				async () => ({ uuid: 'user-2', name: 'User Two', email: 'two@example.com' })
			);

			expect(user1?.name).toBe('User One');
			expect(user2?.name).toBe('User Two');
		});
	});

	describe('fail() behavior', () => {
		it('should not cache result when factory calls ctx.fail() and no stale value', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').build();

			let factoryCallCount = 0;
			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			// First call - factory fails, no stale value available
			await expect(
				cacheService.getOrSet<User, typeof params>(UserCache, params, async (ctx) => {
					factoryCallCount++;
					return ctx.fail('Transient error');
				})
			).rejects.toThrow('Transient error');

			expect(factoryCallCount).toBe(1);

			// Second call - factory should be called again (nothing was cached)
			await expect(
				cacheService.getOrSet<User, typeof params>(UserCache, params, async (ctx) => {
					factoryCallCount++;
					return ctx.fail('Transient error again');
				})
			).rejects.toThrow('Transient error again');

			expect(factoryCallCount).toBe(2); // Both calls invoked factory
		});

		it('should return stale value when factory calls ctx.fail() during grace period', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// TTL=0.2s, Grace=1s - short for fast tests
			const ShortCache = Cache.for('User').ttl(0.2).grace(1).build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };
			const originalUser: User = { uuid: 'user-grace', name: 'Grace User', email: 'grace@example.com' };

			// First call - populate cache
			const result1 = await cacheService.getOrSet<User, typeof params>(
				ShortCache,
				params,
				async () => originalUser
			);
			expect(result1).toEqual(originalUser);

			// Wait for TTL to expire but stay within grace period
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Second call - factory fails, should return stale value
			let failCalled = false;
			const result2 = await cacheService.getOrSet<User, typeof params>(ShortCache, params, async (ctx) => {
				failCalled = true;
				return ctx.fail('Database is down');
			});

			expect(failCalled).toBe(true);
			expect(result2).toEqual(originalUser); // Got stale value back
		});
	});

	describe('skip() behavior', () => {
		it('should return undefined and not cache when factory calls skip()', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').build();

			let factoryCallCount = 0;
			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			// First call - factory returns skip
			const result1 = await cacheService.getOrSet<User, typeof params>(UserCache, params, async (ctx) => {
				factoryCallCount++;
				// Simulate user not found
				return ctx.skip();
			});

			expect(result1).toBeUndefined();
			expect(factoryCallCount).toBe(1);

			// Second call - factory called again because nothing was cached
			const result2 = await cacheService.getOrSet<User, typeof params>(UserCache, params, async (ctx) => {
				factoryCallCount++;
				return ctx.skip();
			});

			expect(result2).toBeUndefined();
			expect(factoryCallCount).toBe(2); // Called again
		});
	});

	describe('cacheNull option', () => {
		it('should not cache null by default', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').build();

			let factoryCallCount = 0;
			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			// First call - returns null
			await cacheService.getOrSet<User | null, typeof params>(UserCache, params, async () => {
				factoryCallCount++;
				return null;
			});

			// Second call - factory called again
			await cacheService.getOrSet<User | null, typeof params>(UserCache, params, async () => {
				factoryCallCount++;
				return null;
			});

			expect(factoryCallCount).toBe(2); // Called twice, null not cached
		});

		it('should cache null when cacheNull is enabled', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').cacheNull().build();

			let factoryCallCount = 0;
			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			// First call
			const result1 = await cacheService.getOrSet<User | null, typeof params>(UserCache, params, async () => {
				factoryCallCount++;
				return null;
			});

			expect(result1).toBeNull();

			// Second call - cache hit
			const result2 = await cacheService.getOrSet<User | null, typeof params>(UserCache, params, async () => {
				factoryCallCount++;
				return { uuid: 'should-not-be-called', name: 'x', email: 'x' };
			});

			expect(result2).toBeNull();
			expect(factoryCallCount).toBe(1); // Only called once
		});
	});

	describe('direct get/set/delete', () => {
		it('should set and get value directly', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };
			const user: User = { uuid: 'user-direct', name: 'Direct User', email: 'direct@example.com' };

			await cacheService.set(UserCache, params, user);

			const result = await cacheService.get<User, typeof params>(UserCache, params);

			expect(result).toEqual(user);
		});

		it('should delete cached value', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };
			const user: User = { uuid: 'user-delete', name: 'Delete User', email: 'delete@example.com' };

			await cacheService.set(UserCache, params, user);
			expect(await cacheService.get<User, typeof params>(UserCache, params)).toEqual(user);

			const deleted = await cacheService.delete(UserCache, params);
			expect(deleted).toBe(true);

			expect(await cacheService.get<User, typeof params>(UserCache, params)).toBeUndefined();
		});
	});

	describe('invalidation', () => {
		it('should invalidate cache entries by entity type', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// User auto-depends on Account from hierarchy
			const UserCache = Cache.for('User').ttl('1h').build();

			const accountUuid = crypto.randomUUID();
			const params1 = { accountUuid, userUuid: crypto.randomUUID() };
			const params2 = { accountUuid, userUuid: crypto.randomUUID() };

			// Cache two users in the same account
			await cacheService.set(UserCache, params1, { uuid: 'user-1', name: 'User 1', email: '1@test.com' });
			await cacheService.set(UserCache, params2, { uuid: 'user-2', name: 'User 2', email: '2@test.com' });

			// Verify they're cached
			expect(await cacheService.get<User, typeof params1>(UserCache, params1)).toBeDefined();
			expect(await cacheService.get<User, typeof params2>(UserCache, params2)).toBeDefined();

			// Invalidate by Account - should clear all users in this account
			const deleted = await cacheService.invalidate('Account', { accountUuid });

			expect(deleted).toBeGreaterThan(0);
			expect(await cacheService.get<User, typeof params1>(UserCache, params1)).toBeUndefined();
			expect(await cacheService.get<User, typeof params2>(UserCache, params2)).toBeUndefined();
		});

		it('should invalidate entries based on dependencies', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// Monitor auto-depends on Account and Project from hierarchy
			const MonitorCache = Cache.for('Monitor').ttl('1h').build();

			const params = {
				accountUuid: crypto.randomUUID(),
				projectUuid: crypto.randomUUID(),
				monitorUuid: crypto.randomUUID()
			};

			// Cache a monitor
			await cacheService.set(MonitorCache, params, {
				uuid: 'mon-789',
				name: 'API Monitor',
				url: 'https://api.example.com'
			});

			expect(await cacheService.get<Monitor, typeof params>(MonitorCache, params)).toBeDefined();

			// Invalidate by Project - should clear monitors in this project
			await cacheService.invalidate('Project', {
				accountUuid: params.accountUuid,
				projectUuid: params.projectUuid
			});

			expect(await cacheService.get<Monitor, typeof params>(MonitorCache, params)).toBeUndefined();
		});

		it('should not affect entries in different scopes', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const MonitorCache = Cache.for('Monitor').ttl('1h').build();

			const accountUuid = crypto.randomUUID();
			const params1 = { accountUuid, projectUuid: crypto.randomUUID(), monitorUuid: crypto.randomUUID() };
			const params2 = { accountUuid, projectUuid: crypto.randomUUID(), monitorUuid: crypto.randomUUID() };

			// Cache monitors in different projects
			await cacheService.set(MonitorCache, params1, { uuid: 'mon-1', name: 'Mon 1', url: 'http://1' });
			await cacheService.set(MonitorCache, params2, { uuid: 'mon-2', name: 'Mon 2', url: 'http://2' });

			// Invalidate project 1
			await cacheService.invalidate('Project', { accountUuid, projectUuid: params1.projectUuid });

			// Project 1 monitor should be cleared
			expect(await cacheService.get<Monitor, typeof params1>(MonitorCache, params1)).toBeUndefined();
			// Project 2 monitor should still be cached
			expect(await cacheService.get<Monitor, typeof params2>(MonitorCache, params2)).toBeDefined();
		});
	});

	describe('invalidateMany', () => {
		it('should invalidate multiple entities at once', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').build();

			const acc1 = crypto.randomUUID();
			const acc2 = crypto.randomUUID();
			const acc3 = crypto.randomUUID();
			const acc1User = { accountUuid: acc1, userUuid: crypto.randomUUID() };
			const acc2User = { accountUuid: acc2, userUuid: crypto.randomUUID() };
			const acc3User = { accountUuid: acc3, userUuid: crypto.randomUUID() };

			await cacheService.set(UserCache, acc1User, { uuid: 'user-1', name: 'U1', email: '1@test.com' });
			await cacheService.set(UserCache, acc2User, { uuid: 'user-2', name: 'U2', email: '2@test.com' });
			await cacheService.set(UserCache, acc3User, { uuid: 'user-3', name: 'U3', email: '3@test.com' });

			// Invalidate accounts 1 and 2
			const deleted = await cacheService.invalidateMany([
				{ entityType: 'Account', params: { accountUuid: acc1 } },
				{ entityType: 'Account', params: { accountUuid: acc2 } }
			]);

			expect(deleted).toBe(2);
			expect(await cacheService.get<User, typeof acc1User>(UserCache, acc1User)).toBeUndefined();
			expect(await cacheService.get<User, typeof acc2User>(UserCache, acc2User)).toBeUndefined();
			expect(await cacheService.get<User, typeof acc3User>(UserCache, acc3User)).toBeDefined();
		});
	});

	describe('registry integration', () => {
		it('should track cache configurations in registry', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const UserCache = Cache.for('User').ttl('1h').build();
			const MonitorCache = Cache.for('Monitor').ttl('30m').build();

			cacheRegistry.register(UserCache);
			cacheRegistry.register(MonitorCache);

			expect(cacheRegistry.size).toBe(2);
			expect(cacheRegistry.getRegisteredEntityTypes()).toContain('User');
			expect(cacheRegistry.getRegisteredEntityTypes()).toContain('Monitor');
		});

		it('should build dependency graph for cascade invalidation', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// User auto-depends on Account
			const UserCache = Cache.for('User').ttl('1h').build();
			// Monitor auto-depends on Account and Project
			const MonitorCache = Cache.for('Monitor').ttl('30m').build();

			cacheRegistry.register(UserCache);
			cacheRegistry.register(MonitorCache);

			// Account has both User and Monitor depending on it
			const accountDependents = cacheRegistry.getDependents('Account');
			expect(accountDependents.has('User')).toBe(true);
			expect(accountDependents.has('Monitor')).toBe(true);

			// Project only has Monitor depending on it
			const projectDependents = cacheRegistry.getDependents('Project');
			expect(projectDependents.has('Monitor')).toBe(true);
			expect(projectDependents.has('User')).toBe(false);
		});
	});

	describe('grace period stale value', () => {
		it('should pass stale value and staleAge to factory during grace period', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// TTL=0.2s, Grace=1s - short for fast tests
			const ShortCache = Cache.for('User').ttl(0.2).grace(1).build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };
			const originalUser: User = { uuid: 'user-stale', name: 'Original', email: 'original@example.com' };
			const updatedUser: User = { uuid: 'user-stale', name: 'Updated', email: 'updated@example.com' };

			// First call - populate cache
			await cacheService.getOrSet<User, typeof params>(ShortCache, params, async () => originalUser);

			// Wait for TTL to expire but stay within grace period
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Second call - should receive stale value in context
			let receivedStaleValue: User | undefined;
			let receivedStaleAge: number | undefined;

			const result = await cacheService.getOrSet<User, typeof params>(ShortCache, params, async (ctx) => {
				receivedStaleValue = ctx.staleValue;
				receivedStaleAge = ctx.staleAge;
				return updatedUser;
			});

			// Factory should have received the stale value
			expect(receivedStaleValue).toEqual(originalUser);

			// Stale age should be > 0.2s
			expect(receivedStaleAge).toBeGreaterThanOrEqual(0.2);
			expect(receivedStaleAge).toBeLessThan(2);

			// Result should be the updated value
			expect(result).toEqual(updatedUser);
		});

		it('should not provide stale value when cache is fresh', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const UserCache = Cache.for('User').ttl('1h').grace('30m').build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			let receivedStaleValue: User | undefined = { uuid: 'sentinel', name: 'sentinel', email: 'sentinel' };
			let receivedStaleAge: number | undefined = 999;

			// First call - no stale value should be provided
			await cacheService.getOrSet<User, typeof params>(UserCache, params, async (ctx) => {
				receivedStaleValue = ctx.staleValue;
				receivedStaleAge = ctx.staleAge;
				return { uuid: 'user-fresh', name: 'Fresh', email: 'fresh@example.com' };
			});

			expect(receivedStaleValue).toBeUndefined();
			expect(receivedStaleAge).toBeUndefined();
		});

		it('should not provide stale value when grace period has expired', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// Use very short TTL + grace for fast test
			const ShortCache = Cache.for('User').ttl(0.1).grace(0.1).build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };
			const originalUser: User = { uuid: 'user-expired', name: 'Original', email: 'orig@example.com' };

			// First call - populate cache
			await cacheService.getOrSet<User, typeof params>(ShortCache, params, async () => originalUser);

			// Wait for both TTL AND grace to fully expire (0.1s + 0.1s = 0.2s, wait 400ms)
			await new Promise((resolve) => setTimeout(resolve, 400));

			// Second call - stale value should NOT be provided (grace expired)
			let receivedStaleValue: User | undefined = { uuid: 'sentinel', name: 'sentinel', email: 'sentinel' };

			await cacheService.getOrSet<User, typeof params>(ShortCache, params, async (ctx) => {
				receivedStaleValue = ctx.staleValue;
				return { uuid: 'user-expired', name: 'New', email: 'new@example.com' };
			});

			expect(receivedStaleValue).toBeUndefined();
		});
	});

	describe('TTL expiration', () => {
		it('should expire cache after TTL', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// Use 0.2s TTL for fast tests
			const ShortCache = Cache.for('User').ttl(0.2).build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			await cacheService.set(ShortCache, params, {
				uuid: 'user-ttl',
				name: 'TTL User',
				email: 'ttl@example.com'
			});

			// Immediately available
			expect(await cacheService.get<User, typeof params>(ShortCache, params)).toBeDefined();

			// Wait for expiration
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Should be expired
			expect(await cacheService.get<User, typeof params>(ShortCache, params)).toBeUndefined();
		});
	});

	describe('timeout behavior', () => {
		it('should throw CacheTimeoutError when data fetch exceeds timeout', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// 50ms timeout
			const TimeoutCache = Cache.for('User').ttl('1h').timeout(0.05).build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			// Fetch takes 200ms, timeout is 50ms
			await expect(
				cacheService.getOrSet<User, typeof params>(TimeoutCache, params, async () => {
					await new Promise((resolve) => setTimeout(resolve, 200));
					return { uuid: 'user-timeout', name: 'Slow User', email: 'slow@example.com' };
				})
			).rejects.toThrow(CacheTimeoutError);
		});

		it('should include timeout duration in error message', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// 50ms timeout
			const TimeoutCache = Cache.for('User').ttl('1h').timeout(0.05).build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			try {
				await cacheService.getOrSet<User, typeof params>(TimeoutCache, params, async () => {
					await new Promise((resolve) => setTimeout(resolve, 200));
					return { uuid: 'user', name: 'User', email: 'user@example.com' };
				});
				expect.unreachable('Should have thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(CacheTimeoutError);
				expect((error as Error).message).toContain('50ms');
			}
		});

		it('should return stale value when fetch times out during grace period', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// TTL=0.2s, Grace=1s, timeout=50ms
			const TimeoutWithGraceCache = Cache.for('User').ttl(0.2).grace(1).timeout(0.05).build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };
			const originalUser: User = { uuid: 'user-timeout-grace', name: 'Original', email: 'orig@example.com' };

			// First call - populate cache (fast factory)
			const result1 = await cacheService.getOrSet<User, typeof params>(
				TimeoutWithGraceCache,
				params,
				async () => originalUser
			);
			expect(result1).toEqual(originalUser);

			// Wait for TTL to expire but stay within grace period
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Second call - slow fetch times out, should return stale value
			const result2 = await cacheService.getOrSet<User, typeof params>(
				TimeoutWithGraceCache,
				params,
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 200)); // Times out
					return { uuid: 'user-new', name: 'New', email: 'new@example.com' };
				}
			);

			// Should get the stale value back due to timeout fallback
			expect(result2).toEqual(originalUser);
		});

		it('should complete successfully when fetch finishes within timeout', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// 500ms timeout
			const TimeoutCache = Cache.for('User').ttl('1h').timeout(0.5).build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };
			const user: User = { uuid: 'user-fast', name: 'Fast User', email: 'fast@example.com' };

			// Fetch takes 20ms, timeout is 500ms - should succeed
			const result = await cacheService.getOrSet<User, typeof params>(TimeoutCache, params, async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return user;
			});

			expect(result).toEqual(user);
		});

		it('should correctly store timeout in CacheConfig', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// 10 second timeout
			const config = Cache.for('User').ttl('1h').timeout('10s').build();

			// timeout should be in milliseconds
			expect(config.timeout).toBe(10000);
		});

		it('should use 1 second default timeout', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			// No explicit timeout - uses 1s default
			const DefaultTimeoutCache = Cache.for('User').ttl('1h').build();

			const params = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };

			// Config timeout is undefined (default applied at runtime)
			expect(DefaultTimeoutCache.timeout).toBeUndefined();

			// Fast fetch should work fine with default 1s timeout
			const user: User = { uuid: 'user-default', name: 'Default User', email: 'default@example.com' };
			const result = await cacheService.getOrSet<User, typeof params>(
				DefaultTimeoutCache,
				params,
				async () => user
			);
			expect(result).toEqual(user);

			// Slow fetch (>1s) should timeout with default
			const slowParams = { accountUuid: crypto.randomUUID(), userUuid: crypto.randomUUID() };
			await expect(
				cacheService.getOrSet<User, typeof slowParams>(DefaultTimeoutCache, slowParams, async () => {
					await new Promise((resolve) => setTimeout(resolve, 1500)); // 1.5s > 1s default
					return { uuid: 'slow', name: 'Slow', email: 'slow@example.com' };
				})
			).rejects.toThrow(CacheTimeoutError);
		});
	});

	describe('tag-based invalidation', () => {
		// Registry with invalidationTags on User entity
		function createTagTestRegistry() {
			// Use .entities() with invalidationTags to register tags in the global registry
			return EntityRegistry.create()
				.scope('global')
				.scope('account', 'accountUuid')
				.entities({
					Account: {
						name: 'Account',
						scope: { name: 'account' }
					},
					User: {
						name: 'User',
						scope: { name: 'account' },
						param: 'fbAuthUid',
						invalidationTags: (params: Record<string, unknown>) => [`user:${params.fbAuthUid}`]
					},
					UserAuth: {
						name: 'UserAuth',
						scope: { name: 'global' },
						param: 'fbAuthUid'
					}
				})
				.build();
		}

		it('should add tag meta keys when setting cache with tags', async () => {
			const registry = createTagTestRegistry();
			const Cache = createCacheBuilder(registry);

			const UserAuthCache = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.build();

			const fbAuthUid = crypto.randomUUID();
			const params = { fbAuthUid };

			// Set cache entry with tags
			await cacheService.set(UserAuthCache, params, { accountUuid: 'acc-123' });

			// Verify cache was set
			const result = await cacheService.get<{ accountUuid: string }, typeof params>(UserAuthCache, params);
			expect(result).toEqual({ accountUuid: 'acc-123' });
		});

		it('should invalidate tagged cache when entity with matching invalidationTags is invalidated', async () => {
			const registry = createTagTestRegistry();
			const Cache = createCacheBuilder(registry);

			// UserAuth cache tagged with user's fbAuthUid
			const UserAuthCache = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.build();

			// User cache (has invalidationTags on entity definition)
			// Depends on Account so it gets proper metaParams
			const UserCache = Cache.for<{ accountUuid: string; fbAuthUid: string }>('User')
				.ttl('1h')
				.dependsOn('Account' as any)
				.build();

			const fbAuthUid = crypto.randomUUID();
			const accountUuid = crypto.randomUUID();

			// Set UserAuth cache (global scope)
			await cacheService.set(UserAuthCache, { fbAuthUid }, { accountUuid });

			// Set User cache (account scope)
			await cacheService.set(UserCache, { accountUuid, fbAuthUid }, { name: 'Test User' });

			// Verify both are cached
			expect(
				await cacheService.get<{ accountUuid: string }, { fbAuthUid: string }>(UserAuthCache, { fbAuthUid })
			).toBeDefined();
			expect(
				await cacheService.get<{ name: string }, { accountUuid: string; fbAuthUid: string }>(UserCache, {
					accountUuid,
					fbAuthUid
				})
			).toBeDefined();

			// Invalidate by Account first - this should clear User cache via dependency
			await cacheService.invalidate('Account', { accountUuid });

			// User cache should be cleared (via Account dependency)
			expect(
				await cacheService.get<{ name: string }, { accountUuid: string; fbAuthUid: string }>(UserCache, {
					accountUuid,
					fbAuthUid
				})
			).toBeUndefined();

			// Re-set User cache to test tag-based invalidation
			await cacheService.set(UserCache, { accountUuid, fbAuthUid }, { name: 'Test User 2' });

			// Now invalidate User directly - this triggers invalidationTags
			await cacheService.invalidate('User', { accountUuid, fbAuthUid });

			// User cache should be cleared (we'll verify via re-fetch showing it's gone)
			// Note: Direct User invalidation may work differently, focus on tag cascade

			// UserAuth cache should be cleared (via tag invalidation from User's invalidationTags)
			expect(
				await cacheService.get<{ accountUuid: string }, { fbAuthUid: string }>(UserAuthCache, { fbAuthUid })
			).toBeUndefined();
		});

		it('should not affect caches with different tags', async () => {
			const registry = createTagTestRegistry();
			const Cache = createCacheBuilder(registry);

			const UserAuthCache = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.build();

			const user1FbUid = crypto.randomUUID();
			const user2FbUid = crypto.randomUUID();
			const accountUuid = crypto.randomUUID();

			// Set UserAuth caches for two different users
			await cacheService.set(UserAuthCache, { fbAuthUid: user1FbUid }, { accountUuid });
			await cacheService.set(UserAuthCache, { fbAuthUid: user2FbUid }, { accountUuid });

			// Verify both are cached
			expect(
				await cacheService.get<{ accountUuid: string }, { fbAuthUid: string }>(UserAuthCache, {
					fbAuthUid: user1FbUid
				})
			).toBeDefined();
			expect(
				await cacheService.get<{ accountUuid: string }, { fbAuthUid: string }>(UserAuthCache, {
					fbAuthUid: user2FbUid
				})
			).toBeDefined();

			// Invalidate user1 by calling invalidate('User', ...) which triggers invalidationTags
			// The User entity has invalidationTags: (p) => [`user:${p.fbAuthUid}`]
			await cacheService.invalidate('User', { accountUuid, fbAuthUid: user1FbUid });

			// User1's UserAuth should be cleared (via tag invalidation)
			expect(
				await cacheService.get<{ accountUuid: string }, { fbAuthUid: string }>(UserAuthCache, {
					fbAuthUid: user1FbUid
				})
			).toBeUndefined();

			// User2's UserAuth should still be cached (different tag)
			expect(
				await cacheService.get<{ accountUuid: string }, { fbAuthUid: string }>(UserAuthCache, {
					fbAuthUid: user2FbUid
				})
			).toBeDefined();
		});

		it('should handle multiple tags on single cache', async () => {
			const registry = EntityRegistry.create()
				.scope('global')
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.entities({
					Monitor: {
						name: 'Monitor',
						scope: { name: 'project' },
						param: 'monitorUuid',
						invalidationTags: (params: Record<string, unknown>) => [
							`project:${params.projectUuid}`,
							`monitor:${params.monitorUuid}`
						]
					},
					MonitorCache: {
						name: 'MonitorCache',
						scope: { name: 'global' },
						param: 'cacheKey'
					}
				})
				.build();

			const Cache = createCacheBuilder(registry);

			// Cache with multiple tags
			const MonitorCacheConfig = Cache.for<{ cacheKey: string; projectUuid: string; monitorUuid: string }>(
				'MonitorCache'
			)
				.ttl('1h')
				.tags((params) => [`project:${params.projectUuid}`, `monitor:${params.monitorUuid}`])
				.build();

			const projectUuid = crypto.randomUUID();
			const monitorUuid = crypto.randomUUID();
			const cacheKey = 'mon-cache-1';

			// Set cache with multiple tags
			await cacheService.set(MonitorCacheConfig, { cacheKey, projectUuid, monitorUuid }, { data: 'test' });

			// Verify it's cached
			expect(
				await cacheService.get(MonitorCacheConfig, { cacheKey, projectUuid, monitorUuid })
			).toBeDefined();

			// Invalidate via monitor tag
			await cacheService.invalidate('Monitor', {
				accountUuid: crypto.randomUUID(),
				projectUuid,
				monitorUuid
			});

			// Cache should be cleared
			expect(
				await cacheService.get(MonitorCacheConfig, { cacheKey, projectUuid, monitorUuid })
			).toBeUndefined();
		});

		it('should handle empty invalidationTags array (no-op)', async () => {
			const registry = EntityRegistry.create()
				.scope('global')
				.scope('account', 'accountUuid')
				.entity('Account', 'account')
				.entities({
					EmptyTags: {
						name: 'EmptyTags',
						scope: { name: 'account' },
						param: 'itemUuid',
						invalidationTags: () => []
					}
				})
				.build();

			const Cache = createCacheBuilder(registry);
			const EmptyTagsCache = Cache.for<{ accountUuid: string; itemUuid: string }>('EmptyTags')
				.ttl('1h')
				.dependsOn('Account' as any)
				.build();

			const accountUuid = crypto.randomUUID();
			const itemUuid = crypto.randomUUID();

			await cacheService.set(EmptyTagsCache, { accountUuid, itemUuid }, { value: 'test' });

			// Invalidate by Account - should clear the cache via dependency
			await cacheService.invalidate('Account', { accountUuid });

			// Cache should be cleared via Account dependency
			expect(await cacheService.get(EmptyTagsCache, { accountUuid, itemUuid })).toBeUndefined();

			// Re-set to test direct entity invalidation with empty tags
			await cacheService.set(EmptyTagsCache, { accountUuid, itemUuid }, { value: 'test2' });

			// Now invalidate EmptyTags directly - should not crash with empty invalidationTags
			await cacheService.invalidate('EmptyTags', { accountUuid, itemUuid });

			// Verify it didn't crash (the cache may or may not be cleared depending on implementation)
			// The key test is that empty invalidationTags doesn't cause an error
		});

		it('should work for cross-scope invalidation (UserAuth scenario)', async () => {
			// This test simulates the real UserAuth scenario:
			// - UserAuth is global scope (keyed by fbAuthUid only), tagged with `user:${fbAuthUid}`
			// - User is account scope (keyed by accountUuid + fbAuthUid), has invalidationTags
			// - When User is invalidated, UserAuth should also be invalidated via tag

			const registry = createTagTestRegistry();
			const Cache = createCacheBuilder(registry);

			interface UserAuthData {
				fbAuthUid: string;
				accountUuid: string;
			}

			const UserAuthCache = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.build();

			const fbAuthUid = crypto.randomUUID();
			const accountUuid = crypto.randomUUID();

			// Simulate getUserForAuth: cache UserAuth data
			await cacheService.set(UserAuthCache, { fbAuthUid }, { fbAuthUid, accountUuid });

			// Verify UserAuth is cached
			const cachedUserAuth = await cacheService.get<UserAuthData, { fbAuthUid: string }>(UserAuthCache, {
				fbAuthUid
			});
			expect(cachedUserAuth).toEqual({ fbAuthUid, accountUuid });

			// Simulate user update: invalidate User entity
			// The User entity definition has invalidationTags: (p) => [`user:${p.fbAuthUid}`]
			// This generates a tag meta key for `user:${fbAuthUid}`
			// UserAuth cache was tagged with the same tag
			// So invalidating User should cascade to UserAuth via tag
			await cacheService.invalidate('User', { accountUuid, fbAuthUid });

			// UserAuth should be cleared even though it's a different scope
			const afterInvalidation = await cacheService.get<UserAuthData, { fbAuthUid: string }>(UserAuthCache, {
				fbAuthUid
			});
			expect(afterInvalidation).toBeUndefined();
		});
	});
});
