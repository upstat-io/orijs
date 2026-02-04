/**
 * Cache Builder Registry Tests
 *
 * Tests the registry-aware cache builder:
 * - Factory creation with registry
 * - Auto-derivation of scope, params, hierarchy dependencies
 * - .dependsOn() with auto-lookup and explicit override
 * - Builder methods (.ttl, .grace, .cacheNull)
 * - Frozen output configuration
 */

import { describe, it, expect } from 'bun:test';
import { EntityRegistry, defineScopes, defineEntities } from '../src/entity-registry';
import { createCacheBuilder } from '../src/cache-builder';

// --- TYPE FOR TESTS ---

/**
 * Common params type for test assertions.
 * When not specified, TParams defaults to `object` and `keyof object = never`,
 * causing params arrays to type as `readonly never[]`.
 */
type TestParams = {
	accountUuid: string;
	projectUuid: string;
	monitorUuid: string;
	configId: string;
	fbAuthUid: string;
	incidentUuid: string;
	teamUuid: string;
};

// --- TEST FIXTURES ---

/**
 * Create a standard test registry with multi-tenant structure
 */
function createTestRegistry() {
	return EntityRegistry.create()
		.scope('global')
		.scope('account', 'accountUuid')
		.scope('project', 'projectUuid')
		.entity('Config', 'global', 'configId')
		.entity('Account', 'account')
		.entity('Project', 'project')
		.entity('User', 'account', 'fbAuthUid')
		.entity('Monitor', 'project', 'monitorUuid')
		.entity('MonitorSettings', 'project', 'monitorUuid')
		.entity('MonitorCollection', 'project')
		.entity('Incident', 'project', 'incidentUuid')
		.entity('Team', 'project', 'teamUuid')
		.build();
}

// --- FACTORY TESTS ---

describe('createCacheBuilder', () => {
	describe('factory creation', () => {
		it('should create cache builder from registry', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			expect(Cache).toBeDefined();
			expect(typeof Cache.for).toBe('function');
		});

		it('should validate entity exists when calling .for()', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			expect(() => {
				// @ts-expect-error - testing runtime error for invalid entity
				Cache.for('NonExistent');
			}).toThrow("Entity 'NonExistent' not found in registry");
		});

		it('should return builder when entity exists', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const builder = Cache.for('Monitor');
			expect(builder).toBeDefined();
			expect(typeof builder.ttl).toBe('function');
		});
	});
});

// --- AUTO-DERIVATION TESTS ---

describe('auto-derivation', () => {
	describe('scope derivation', () => {
		it('should derive scope from entity registry', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(config.scope).toBe('project');
		});

		it('should derive global scope for global entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Config').ttl('1h').build();

			expect(config.scope).toBe('global');
		});

		it('should derive account scope for account entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('User').ttl('1h').build();

			expect(config.scope).toBe('account');
		});
	});

	describe('params derivation', () => {
		it('should derive params from entity (scope params + unique keys)', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('Monitor').ttl('5m').build();

			expect(config.params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		});

		it('should derive params for account-scoped entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('User').ttl('1h').build();

			expect(config.params).toEqual(['accountUuid', 'fbAuthUid']);
		});

		it('should derive params for collection entity (no unique keys)', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('MonitorCollection').ttl('5m').build();

			expect(config.params).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should derive params for global entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('Config').ttl('1h').build();

			expect(config.params).toEqual(['configId']);
		});
	});

	describe('metaParams derivation', () => {
		it('should derive metaParams from scope params', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('Monitor').ttl('5m').build();

			expect(config.metaParams).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should derive empty metaParams for global scope', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('Config').ttl('1h').build();

			expect(config.metaParams).toEqual([]);
		});

		it('should derive account metaParams for account scope', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('User').ttl('1h').build();

			expect(config.metaParams).toEqual(['accountUuid']);
		});
	});

	describe('hierarchy dependencies', () => {
		it('should auto-add Account dependency for project-scoped entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('Monitor').ttl('5m').build();

			expect(config.dependsOn.Account).toEqual(['accountUuid']);
		});

		it('should auto-add Project dependency for project-scoped entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('Monitor').ttl('5m').build();

			expect(config.dependsOn.Project).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should auto-add Account but not Project for account-scoped entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('User').ttl('1h').build();

			expect(config.dependsOn.Account).toEqual(['accountUuid']);
			expect(config.dependsOn.Project).toBeUndefined();
		});

		it('should have no hierarchy deps for global-scoped entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('Config').ttl('1h').build();

			expect(config.dependsOn.Account).toBeUndefined();
			expect(config.dependsOn.Project).toBeUndefined();
		});
	});
});

// --- DEPENDENCY TESTS ---

describe('dependsOn', () => {
	describe('auto-lookup', () => {
		it('should auto-lookup params from registry', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('MonitorSettings').ttl('5m').dependsOn('Monitor').build();

			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		});

		it('should accumulate multiple dependencies', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('MonitorSettings')
				.ttl('5m')
				.dependsOn('Monitor')
				.dependsOn('Team')
				.build();

			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
			expect(config.dependsOn.Team).toEqual(['accountUuid', 'projectUuid', 'teamUuid']);
		});

		it('should merge with hierarchy deps', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<TestParams>('MonitorSettings').ttl('5m').dependsOn('Monitor').build();

			// Hierarchy deps
			expect(config.dependsOn.Account).toEqual(['accountUuid']);
			expect(config.dependsOn.Project).toEqual(['accountUuid', 'projectUuid']);
			// Additional dep
			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		});
	});

	describe('explicit override', () => {
		it('should use explicit params when provided', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ accountUuid: string; projectUuid: string; monitorUuid: string }>(
				'MonitorSettings'
			)
				.ttl('5m')
				.dependsOn('Team', ['accountUuid', 'projectUuid'])
				.build();

			expect(config.dependsOn.Team).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should allow empty params array', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ accountUuid: string }>('User').ttl('1h').dependsOn('Account', []).build();

			expect(config.dependsOn.Account).toEqual([]);
		});

		it('should override hierarchy dep with explicit params', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ accountUuid: string; projectUuid: string; monitorUuid: string }>('Monitor')
				.ttl('5m')
				.dependsOn('Account', [])
				.build();

			// Override replaces the auto-derived hierarchy dep
			expect(config.dependsOn.Account).toEqual([]);
		});
	});
});

// --- BUILDER METHOD TESTS ---

describe('builder methods', () => {
	describe('ttl()', () => {
		it('should set TTL in seconds for numeric input', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl(300).build();

			expect(config.ttl).toBe(300);
		});

		it('should parse TTL from duration string', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(config.ttl).toBe(300);
		});

		it('should parse hours', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('1h').build();

			expect(config.ttl).toBe(3600);
		});

		it('should parse days', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('1d').build();

			expect(config.ttl).toBe(86400);
		});

		it('should require ttl before build', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const builder = Cache.for('Monitor');

			expect(() => {
				// @ts-expect-error - testing runtime validation
				builder.build();
			}).toThrow("ttl() is required before build() for entity 'Monitor'");
		});

		it('should accept DefaultTTL values (type-constrained)', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// These are all valid DefaultTTL values
			const config1 = Cache.for('Monitor').ttl('5m').build();
			const config2 = Cache.for('Monitor').ttl('1h').build();
			const config3 = Cache.for('Monitor').ttl('1d').build();

			expect(config1.ttl).toBe(300);
			expect(config2.ttl).toBe(3600);
			expect(config3.ttl).toBe(86400);
		});

		it('should accept custom TTL values via generic', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// Define custom TTL type
			type MyTTL = '2m' | '32m' | '2h';

			// Use generic to allow custom values
			const config = Cache.for('Monitor').ttl<MyTTL>('32m').build();

			expect(config.ttl).toBe(32 * 60); // 32 minutes = 1920 seconds
		});

		it('should always accept numeric TTL values', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl(450).build();

			expect(config.ttl).toBe(450);
		});
	});

	describe('grace()', () => {
		it('should set grace period', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').grace('1m').build();

			expect(config.grace).toBe(60);
		});

		it('should default grace to 0', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(config.grace).toBe(0);
		});
	});

	describe('cacheNull()', () => {
		it('should enable caching null values', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').cacheNull().build();

			expect(config.cacheNull).toBe(true);
		});

		it('should disable caching null when false', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').cacheNull(false).build();

			expect(config.cacheNull).toBe(false);
		});

		it('should default cacheNull to false', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(config.cacheNull).toBe(false);
		});
	});

	describe('build()', () => {
		it('should return frozen config', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(Object.isFrozen(config)).toBe(true);
		});

		it('should return frozen params array', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(Object.isFrozen(config.params)).toBe(true);
		});

		it('should return frozen metaParams array', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(Object.isFrozen(config.metaParams)).toBe(true);
		});

		it('should return frozen dependsOn object', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(Object.isFrozen(config.dependsOn)).toBe(true);
		});

		it('should set entity name in config', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('5m').build();

			expect(config.entity).toBe('Monitor');
		});
	});
});

// --- ENTITY DEF INPUT TESTS ---

describe('EntityDef input', () => {
	describe('Cache.for(EntityDef)', () => {
		it('should accept EntityDef object instead of string', () => {
			const Scope = defineScopes({
				Global: { name: 'global' },
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			});

			const Entities = defineEntities({
				Monitor: { name: 'Monitor', scope: Scope.Project, param: 'monitorUuid' }
			});

			const registry = EntityRegistry.create().scopes(Scope).entities(Entities).build();

			const Cache = createCacheBuilder(registry);

			// Use EntityDef object instead of string
			const config = Cache.for<TestParams>(Entities.Monitor).ttl('5m').build();

			expect(config.entity).toBe('Monitor');
			expect(config.scope).toBe('project');
			expect(config.params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		});

		it('should derive all properties correctly from EntityDef', () => {
			const Scope = defineScopes({
				Global: { name: 'global' },
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			});

			const Entities = defineEntities({
				Account: { name: 'Account', scope: Scope.Account },
				Project: { name: 'Project', scope: Scope.Project },
				User: { name: 'User', scope: Scope.Account, param: 'fbAuthUid' }
			});

			const registry = EntityRegistry.create().scopes(Scope).entities(Entities).build();

			const Cache = createCacheBuilder(registry);

			const UserCache = Cache.for<TestParams>(Entities.User).ttl('1h').build();

			expect(UserCache.entity).toBe('User');
			expect(UserCache.scope).toBe('account');
			expect(UserCache.params).toEqual(['accountUuid', 'fbAuthUid']);
			expect(UserCache.metaParams).toEqual(['accountUuid']);
			expect(UserCache.dependsOn.Account).toEqual(['accountUuid']);
		});

		it('should work with .dependsOn() accepting EntityDef', () => {
			const Scope = defineScopes({
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			});

			const Entities = defineEntities({
				Account: { name: 'Account', scope: Scope.Account },
				Project: { name: 'Project', scope: Scope.Project },
				Monitor: { name: 'Monitor', scope: Scope.Project, param: 'monitorUuid' },
				MonitorSettings: { name: 'MonitorSettings', scope: Scope.Project, param: 'monitorUuid' }
			});

			const registry = EntityRegistry.create().scopes(Scope).entities(Entities).build();

			const Cache = createCacheBuilder(registry);

			// Use EntityDef in both .for() AND .dependsOn()
			const config = Cache.for<TestParams>(Entities.MonitorSettings)
				.ttl('5m')
				.dependsOn(Entities.Monitor)
				.build();

			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		});

		it('should throw error when EntityDef references non-existent entity', () => {
			const Scope = defineScopes({
				Account: { name: 'account', param: 'accountUuid' }
			});

			const Entities = defineEntities({
				User: { name: 'User', scope: Scope.Account, param: 'fbAuthUid' }
			});

			// Build registry without User entity
			const registry = EntityRegistry.create().scopes(Scope).build();

			const Cache = createCacheBuilder(registry);

			expect(() => {
				// @ts-expect-error - intentionally passing EntityDef not in registry to test error
				Cache.for(Entities.User);
			}).toThrow("Entity 'User' not found in registry");
		});

		it('should work interchangeably with string input', () => {
			const Scope = defineScopes({
				Account: { name: 'account', param: 'accountUuid' }
			});

			const Entities = defineEntities({
				User: { name: 'User', scope: Scope.Account, param: 'fbAuthUid' }
			});

			const registry = EntityRegistry.create().scopes(Scope).entities(Entities).build();

			const Cache = createCacheBuilder(registry);

			// Both should produce identical configs
			const configFromString = Cache.for<TestParams>('User').ttl('1h').build();
			const configFromEntityDef = Cache.for<TestParams>(Entities.User).ttl('1h').build();

			expect(configFromString).toEqual(configFromEntityDef);
		});
	});
});

// --- FUNCTIONAL TESTS ---

describe('functional tests', () => {
	it('should build complete production-style cache config', () => {
		const registry = EntityRegistry.create()
			.scope('global')
			.scope('account', 'accountUuid')
			.scope('project', 'projectUuid')
			.entity('Account', 'account')
			.entity('Project', 'project')
			.entity('Monitor', 'project', 'monitorUuid')
			.entity('MonitorSettings', 'project', 'monitorUuid')
			.build();

		const Cache = createCacheBuilder(registry);

		const MonitorCache = Cache.for<TestParams>('Monitor').ttl('5m').build();

		expect(MonitorCache).toEqual({
			entity: 'Monitor',
			scope: 'project',
			ttl: 300,
			grace: 0,
			params: ['accountUuid', 'projectUuid', 'monitorUuid'],
			metaParams: ['accountUuid', 'projectUuid'],
			dependsOn: {
				Account: ['accountUuid'],
				Project: ['accountUuid', 'projectUuid']
			},
			cacheNull: false
		});
	});

	it('should build cache with all options', () => {
		const registry = createTestRegistry();
		const Cache = createCacheBuilder(registry);

		const config = Cache.for<TestParams>('MonitorSettings')
			.ttl('5m')
			.grace('1m')
			.dependsOn('Monitor')
			.cacheNull()
			.build();

		expect(config.entity).toBe('MonitorSettings');
		expect(config.scope).toBe('project');
		expect(config.ttl).toBe(300);
		expect(config.grace).toBe(60);
		expect(config.params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		expect(config.metaParams).toEqual(['accountUuid', 'projectUuid']);
		expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		expect(config.dependsOn.Account).toEqual(['accountUuid']);
		expect(config.dependsOn.Project).toEqual(['accountUuid', 'projectUuid']);
		expect(config.cacheNull).toBe(true);
	});

	it('should work with .use() composition in registry', () => {
		function addMonitorEntities<T extends string, S extends string>(
			reg: import('../src/entity-registry.types').EntityRegistryBuilder<T, S>
		) {
			return reg
				.entity('Monitor', 'project' as S, 'monitorUuid')
				.entity('MonitorSettings', 'project' as S, 'monitorUuid');
		}

		const registry = EntityRegistry.create()
			.scope('global')
			.scope('account', 'accountUuid')
			.scope('project', 'projectUuid')
			.entity('Account', 'account')
			.entity('Project', 'project')
			.use(addMonitorEntities)
			.build();

		const Cache = createCacheBuilder(registry);

		const MonitorCache = Cache.for<TestParams>('Monitor').ttl('5m').build();
		const MonitorSettingsCache = Cache.for<TestParams>('MonitorSettings')
			.ttl('5m')
			.dependsOn('Monitor')
			.build();

		expect(MonitorCache.scope).toBe('project');
		expect(MonitorSettingsCache.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
	});

	it('should build cache config using factory-based workflow', () => {
		// Step 1: Define scopes using factory
		const Scope = defineScopes({
			Global: { name: 'global' },
			Account: { name: 'account', param: 'accountUuid' },
			Project: { name: 'project', param: 'projectUuid' }
		});

		// Step 2: Define entities using factory
		const Entities = defineEntities({
			Account: { name: 'Account', scope: Scope.Account },
			Project: { name: 'Project', scope: Scope.Project },
			Monitor: { name: 'Monitor', scope: Scope.Project, param: 'monitorUuid' },
			MonitorSettings: { name: 'MonitorSettings', scope: Scope.Project, param: 'monitorUuid' }
		});

		// Step 3: Build registry using bulk registration
		const registry = EntityRegistry.create().scopes(Scope).entities(Entities).build();

		// Step 4: Create cache builder
		const Cache = createCacheBuilder(registry);

		// Step 5: Define caches using EntityDef objects (no string literals!)
		const MonitorCache = Cache.for<TestParams>(Entities.Monitor).ttl('5m').build();

		const MonitorSettingsCache = Cache.for<TestParams>(Entities.MonitorSettings)
			.ttl('5m')
			.grace('1m')
			.dependsOn(Entities.Monitor)
			.build();

		// Verify Monitor cache
		expect(MonitorCache.entity).toBe('Monitor');
		expect(MonitorCache.scope).toBe('project');
		expect(MonitorCache.params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		expect(MonitorCache.metaParams).toEqual(['accountUuid', 'projectUuid']);
		expect(MonitorCache.dependsOn.Account).toEqual(['accountUuid']);
		expect(MonitorCache.dependsOn.Project).toEqual(['accountUuid', 'projectUuid']);

		// Verify MonitorSettings cache
		expect(MonitorSettingsCache.entity).toBe('MonitorSettings');
		expect(MonitorSettingsCache.grace).toBe(60);
		expect(MonitorSettingsCache.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
	});
});
