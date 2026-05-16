/**
 * Cache Cascade End-to-End Tests (BUG-11-083 cure verification)
 *
 * Verifies that Collection.dependsOn(Individual) cascade ACTUALLY FIRES when an
 * Individual is invalidated. The bug specifically lives on the Redis meta-key path
 * (cache.ts:592 hasMetaSupport branch); the InMemory provider takes the else branch
 * and doesn't generate meta keys at all. Therefore these tests MUST use a real
 * RedisCacheProvider via test-utils (per gemini Phase 1.75 Q5 + Plan TPR Round 0
 * agreement-cluster B).
 *
 * Test shape per Plan §03:
 * - Seed Individual entities
 * - Seed Collection cache via list call (caches the result)
 * - Mutate (invalidate) an Individual
 * - Re-read Collection through the same cache path
 * - Assert Collection MISS (cascade fired, entry was removed)
 *
 * Pre-cure: cascade silently failed; Collection persisted post-Individual-invalidate.
 * Post-cure: auto-narrow drops the source's extra params; meta-keys match at set + invalidate;
 * cascade walker finds the Collection and removes it.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { createRedisTestHelper, type RedisTestHelper } from '@orijs/test-utils';
import { EntityRegistry, createCacheBuilder, CacheService, cacheRegistry } from '../src';
import { RedisCacheProvider } from '@orijs/cache-redis';

// --- TEST FIXTURES ---

type TestParams = {
	accountUuid: string;
	projectUuid: string;
	monitorUuid: string;
};

interface Monitor {
	uuid: string;
	name: string;
}

function createTestRegistry() {
	return EntityRegistry.create()
		.scope('global')
		.scope('account', 'accountUuid')
		.scope('project', 'projectUuid')
		.entity('Account', 'account')
		.entity('Project', 'project')
		.entity('Monitor', 'project', 'monitorUuid')
		.entity('MonitorCollection', 'project')
		.build();
}

const ACCT_A = 'acct-a';
const ACCT_B = 'acct-b';
const PROJ_A = 'proj-a';
const PROJ_B = 'proj-b';

describe('CacheBuilder cascade end-to-end (BUG-11-083 cure verification)', () => {
	let redisHelper: RedisTestHelper;
	let redisCacheProvider: RedisCacheProvider;
	let cacheService: CacheService;

	beforeAll(() => {
		const packageName = process.env.TEST_PACKAGE_NAME || 'orijs';
		redisHelper = createRedisTestHelper(packageName);
		if (!redisHelper.isReady()) {
			throw new Error(`Redis container not ready for ${packageName} — check Bun test preload`);
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
	});

	afterAll(async () => {
		await redisCacheProvider.stop();
	});

	describe('Collection.dependsOn(Individual) cascade — same-scope, source has extra params', () => {
		it('semantic pin: invalidating Individual cascades to Collection (Collection cache miss after invalidate)', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const MonitorCache = Cache.for<TestParams>('Monitor').ttl('1h').build();
			const MonitorCollectionCache = Cache.for<TestParams>('MonitorCollection')
				.ttl('1h')
				.dependsOn('Monitor') // auto-narrowed to [accountUuid, projectUuid] per BUG-11-083 cure
				.build();

			let monitorFactoryCalls = 0;
			let collectionFactoryCalls = 0;

			const monitorFactory = async (): Promise<Monitor> => {
				monitorFactoryCalls++;
				return { uuid: 'm-1', name: 'Monitor 1' };
			};
			const collectionFactory = async (): Promise<Monitor[]> => {
				collectionFactoryCalls++;
				return [{ uuid: 'm-1', name: 'Monitor 1' }];
			};

			// Prime caches
			await cacheService.getOrSet(MonitorCache, { accountUuid: ACCT_A, projectUuid: PROJ_A, monitorUuid: 'm-1' }, monitorFactory);
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_A, projectUuid: PROJ_A }, collectionFactory);
			expect(monitorFactoryCalls).toBe(1);
			expect(collectionFactoryCalls).toBe(1);

			// Verify both cached (no factory call on re-read)
			await cacheService.getOrSet(MonitorCache, { accountUuid: ACCT_A, projectUuid: PROJ_A, monitorUuid: 'm-1' }, monitorFactory);
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_A, projectUuid: PROJ_A }, collectionFactory);
			expect(monitorFactoryCalls).toBe(1);
			expect(collectionFactoryCalls).toBe(1);

			// Invalidate the Monitor (cascade should hit MonitorCollection)
			await cacheService.invalidate('Monitor', { accountUuid: ACCT_A, projectUuid: PROJ_A, monitorUuid: 'm-1' });

			// Re-read MonitorCollection: cascade fired, cache miss, factory called again
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_A, projectUuid: PROJ_A }, collectionFactory);
			expect(collectionFactoryCalls).toBe(2); // SEMANTIC PIN: cascade fired

			// Re-read Monitor too: invalidated directly, factory called again
			await cacheService.getOrSet(MonitorCache, { accountUuid: ACCT_A, projectUuid: PROJ_A, monitorUuid: 'm-1' }, monitorFactory);
			expect(monitorFactoryCalls).toBe(2);
		});

		it('negative pin: invalidating an unrelated Individual (different uuid) does NOT cascade to Collection', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const MonitorCache = Cache.for<TestParams>('Monitor').ttl('1h').build();
			const MonitorCollectionCache = Cache.for<TestParams>('MonitorCollection')
				.ttl('1h')
				.dependsOn('Monitor')
				.build();

			let collectionFactoryCalls = 0;
			const collectionFactory = async (): Promise<Monitor[]> => {
				collectionFactoryCalls++;
				return [{ uuid: 'm-1', name: 'Monitor 1' }];
			};

			// Prime collection
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_A, projectUuid: PROJ_A }, collectionFactory);
			expect(collectionFactoryCalls).toBe(1);

			// Invalidate a Monitor in a DIFFERENT project
			await cacheService.invalidate('Monitor', { accountUuid: ACCT_A, projectUuid: PROJ_B, monitorUuid: 'm-other' });

			// Collection in PROJ_A should still be cached (factory NOT called again)
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_A, projectUuid: PROJ_A }, collectionFactory);
			expect(collectionFactoryCalls).toBe(1); // NEGATIVE PIN: cascade scope-correct
		});

		it('tenant isolation: invalidating Individual in tenant A does NOT cascade to Collection in tenant B', async () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);
			const MonitorCache = Cache.for<TestParams>('Monitor').ttl('1h').build();
			const MonitorCollectionCache = Cache.for<TestParams>('MonitorCollection')
				.ttl('1h')
				.dependsOn('Monitor')
				.build();

			let collectionAFactoryCalls = 0;
			let collectionBFactoryCalls = 0;
			const collectionAFactory = async (): Promise<Monitor[]> => {
				collectionAFactoryCalls++;
				return [{ uuid: 'm-a', name: 'A' }];
			};
			const collectionBFactory = async (): Promise<Monitor[]> => {
				collectionBFactoryCalls++;
				return [{ uuid: 'm-b', name: 'B' }];
			};

			// Prime both tenants' collections
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_A, projectUuid: PROJ_A }, collectionAFactory);
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_B, projectUuid: PROJ_B }, collectionBFactory);
			expect(collectionAFactoryCalls).toBe(1);
			expect(collectionBFactoryCalls).toBe(1);

			// Invalidate a Monitor in tenant A
			await cacheService.invalidate('Monitor', { accountUuid: ACCT_A, projectUuid: PROJ_A, monitorUuid: 'm-a' });

			// Tenant A collection: cascade fires, factory called again
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_A, projectUuid: PROJ_A }, collectionAFactory);
			expect(collectionAFactoryCalls).toBe(2);

			// Tenant B collection: NOT invalidated, factory NOT called again
			await cacheService.getOrSet(MonitorCollectionCache, { accountUuid: ACCT_B, projectUuid: PROJ_B }, collectionBFactory);
			expect(collectionBFactoryCalls).toBe(1); // TENANT ISOLATION: cross-tenant cascade did NOT fire
		});

		it('multi-source cascade: Collection dependsOn(Individual1).dependsOn(Individual2) — invalidating either cascades', async () => {
			const registry = EntityRegistry.create()
				.scope('global')
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.entity('Account', 'account')
				.entity('Project', 'project')
				.entity('Monitor', 'project', 'monitorUuid')
				.entity('Incident', 'project', 'incidentUuid')
				.entity('MonitorIncidentSummary', 'project')
				.build();
			const Cache = createCacheBuilder(registry);
			const SummaryCache = Cache.for<{
				accountUuid: string;
				projectUuid: string;
				monitorUuid: string;
				incidentUuid: string;
			}>('MonitorIncidentSummary')
				.ttl('1h')
				.dependsOn('Monitor')
				.dependsOn('Incident')
				.build();

			let factoryCalls = 0;
			const factory = async (): Promise<{ count: number }> => {
				factoryCalls++;
				return { count: 1 };
			};

			// Prime
			await cacheService.getOrSet(SummaryCache, { accountUuid: ACCT_A, projectUuid: PROJ_A } as any, factory);
			expect(factoryCalls).toBe(1);

			// Invalidate Monitor → cascade fires
			await cacheService.invalidate('Monitor', { accountUuid: ACCT_A, projectUuid: PROJ_A, monitorUuid: 'm-1' });
			await cacheService.getOrSet(SummaryCache, { accountUuid: ACCT_A, projectUuid: PROJ_A } as any, factory);
			expect(factoryCalls).toBe(2);

			// Invalidate Incident → cascade fires again
			await cacheService.invalidate('Incident', { accountUuid: ACCT_A, projectUuid: PROJ_A, incidentUuid: 'i-1' });
			await cacheService.getOrSet(SummaryCache, { accountUuid: ACCT_A, projectUuid: PROJ_A } as any, factory);
			expect(factoryCalls).toBe(3);
		});
	});
});
