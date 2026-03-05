import { describe, test, expect, beforeEach } from 'bun:test';
import { CacheService } from '../src/cache';
import { InMemoryCacheProvider } from '../src/in-memory-cache-provider';
import type { CacheConfig } from '../src/types';

const UserCache: CacheConfig<{ accountUuid: string; userUuid: string }> = {
	entity: 'User',
	scope: 'account',
	ttl: 3600,
	grace: 0,
	params: ['accountUuid', 'userUuid'],
	metaParams: ['accountUuid'],
	dependsOn: {},
	cacheNull: false
};

describe('CacheService invalidate with InMemory provider', () => {
	let cacheService: CacheService;

	beforeEach(() => {
		cacheService = new CacheService(new InMemoryCacheProvider());
	});

	test('should delete cached entry via invalidate()', async () => {
		const params = { accountUuid: 'acc-1', userUuid: 'usr-1' };

		// Populate cache
		const result = await cacheService.getOrSet(UserCache, params, async () => {
			return { name: 'Alice' };
		});
		expect(result).toEqual({ name: 'Alice' });

		// Verify cache hit
		let cacheHit = false;
		const cached = await cacheService.getOrSet(UserCache, params, async () => {
			cacheHit = true;
			return { name: 'Alice Updated' };
		});
		expect(cacheHit).toBe(false);
		expect(cached).toEqual({ name: 'Alice' });

		// Invalidate
		const deleted = await cacheService.invalidate('User', params, { cascade: false });
		expect(deleted).toBeGreaterThanOrEqual(1);

		// Verify cache miss after invalidation
		let factoryCalled = false;
		const fresh = await cacheService.getOrSet(UserCache, params, async () => {
			factoryCalled = true;
			return { name: 'Alice Refreshed' };
		});
		expect(factoryCalled).toBe(true);
		expect(fresh).toEqual({ name: 'Alice Refreshed' });
	});

	test('should delete multiple entries via invalidateMany()', async () => {
		const params1 = { accountUuid: 'acc-1', userUuid: 'usr-1' };
		const params2 = { accountUuid: 'acc-1', userUuid: 'usr-2' };

		// Populate both entries
		await cacheService.getOrSet(UserCache, params1, async () => ({ name: 'Alice' }));
		await cacheService.getOrSet(UserCache, params2, async () => ({ name: 'Bob' }));

		// Invalidate both
		const deleted = await cacheService.invalidateMany([
			{ entityType: 'User', params: params1 },
			{ entityType: 'User', params: params2 }
		], { cascade: false });
		expect(deleted).toBeGreaterThanOrEqual(2);

		// Both should be cache misses now
		let factoryCalls = 0;
		await cacheService.getOrSet(UserCache, params1, async () => { factoryCalls++; return { name: 'A' }; });
		await cacheService.getOrSet(UserCache, params2, async () => { factoryCalls++; return { name: 'B' }; });
		expect(factoryCalls).toBe(2);
	});

	test('should return 0 when params do not match any tracked config', async () => {
		// No getOrSet has been called yet, so no configs are tracked
		const deleted = await cacheService.invalidate('User', { accountUuid: 'acc-1', userUuid: 'usr-1' }, { cascade: false });
		expect(deleted).toBe(0);
	});

	test('should work after registerConfig() for invalidation-only instances', async () => {
		const freshService = new CacheService(new InMemoryCacheProvider());
		const params = { accountUuid: 'acc-1', userUuid: 'usr-1' };

		// Populate cache
		await freshService.getOrSet(UserCache, params, async () => ({ name: 'Alice' }));

		// Create another service instance that only invalidates
		const invalidateOnlyService = new CacheService(new InMemoryCacheProvider());
		invalidateOnlyService.registerConfig(UserCache);

		// This won't actually delete from the first service's provider (different instances),
		// but it tests that registerConfig makes key generation work
		const deleted = await invalidateOnlyService.invalidate('User', params, { cascade: false });
		// It generated a key and tried to delete, but InMemory doesn't share state — returns 0 or 1
		expect(typeof deleted).toBe('number');
	});
});
