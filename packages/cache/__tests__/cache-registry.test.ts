/**
 * CacheRegistry Unit Tests
 *
 * Tests the cache registry functionality:
 * - Entity-type indexed storage
 * - Forward/reverse dependency graphs
 * - Cycle detection
 * - getDependents/getDependencies queries
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { cacheRegistry } from '../src/cache-registry';
import { EntityRegistry } from '../src/entity-registry';
import { createCacheBuilder } from '../src/cache-builder';

// --- TEST REGISTRY ---

/**
 * Create a test registry with standard multi-tenant structure
 */
function createTestRegistry() {
	return EntityRegistry.create()
		.scope('global')
		.scope('account', 'accountUuid')
		.scope('project', 'projectUuid')
		.entity('Account', 'account')
		.entity('Project', 'project')
		.entity('User', 'account', 'userUuid')
		.entity('Monitor', 'project', 'monitorUuid')
		.entity('Alert', 'project', 'alertUuid')
		.build();
}

// --- TESTS ---

describe('CacheRegistry', () => {
	beforeEach(() => {
		cacheRegistry.reset();
	});

	describe('register()', () => {
		it('should register a cache configuration', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('User').ttl('1h').build();

			cacheRegistry.register(config);

			expect(cacheRegistry.size).toBe(1);
		});

		it('should allow multiple configs for same entity type', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config1 = Cache.for('User').ttl('1h').build();
			const config2 = Cache.for('User').ttl('5m').build();

			cacheRegistry.register(config1);
			cacheRegistry.register(config2);

			expect(cacheRegistry.size).toBe(2);
			expect(cacheRegistry.getByEntityType('User').length).toBe(2);
		});

		it('should build forward dependency graph', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// Monitor has auto-derived dependencies on Account and Project
			const config = Cache.for('Monitor').ttl('1h').build();

			cacheRegistry.register(config);

			const dependencies = cacheRegistry.getDependencies('Monitor');
			expect(dependencies.has('Account')).toBe(true);
			expect(dependencies.has('Project')).toBe(true);
			expect(dependencies.size).toBe(2);
		});

		it('should build reverse dependency graph', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('Monitor').ttl('1h').build();

			cacheRegistry.register(config);

			// Account has Monitor depending on it
			const accountDependents = cacheRegistry.getDependents('Account');
			expect(accountDependents.has('Monitor')).toBe(true);

			// Project has Monitor depending on it
			const projectDependents = cacheRegistry.getDependents('Project');
			expect(projectDependents.has('Monitor')).toBe(true);
		});
	});

	describe('getByEntityType()', () => {
		it('should return empty array for unregistered entity', () => {
			const configs = cacheRegistry.getByEntityType('UnknownEntity');
			expect(configs).toEqual([]);
		});

		it('should return all configs for registered entity', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const userConfig = Cache.for('User').ttl('1h').build();
			const monitorConfig = Cache.for('Monitor').ttl('5m').build();

			cacheRegistry.register(userConfig);
			cacheRegistry.register(monitorConfig);

			const userConfigs = cacheRegistry.getByEntityType('User');
			expect(userConfigs.length).toBe(1);
			expect(userConfigs[0]!.entity).toBe('User');
			expect(userConfigs[0]!.ttl).toBe(3600); // 1h in seconds
		});
	});

	describe('getDependents()', () => {
		it('should return empty set for entity with no dependents', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// User only depends on Account, not the other way around
			const config = Cache.for('User').ttl('1h').build();

			cacheRegistry.register(config);

			// User has Account depending on it? No, User depends on Account
			const dependents = cacheRegistry.getDependents('User');
			expect(dependents.size).toBe(0);
		});

		it('should return all dependents for entity with dependents', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// User depends on Account
			const userConfig = Cache.for('User').ttl('1h').build();

			// Monitor depends on Account and Project
			const monitorConfig = Cache.for('Monitor').ttl('5m').build();

			cacheRegistry.register(userConfig);
			cacheRegistry.register(monitorConfig);

			// Account is depended upon by both User and Monitor
			const accountDependents = cacheRegistry.getDependents('Account');
			expect(accountDependents.has('User')).toBe(true);
			expect(accountDependents.has('Monitor')).toBe(true);
			expect(accountDependents.size).toBe(2);
		});
	});

	describe('getDependencies()', () => {
		it('should return dependencies from auto-derived hierarchy', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// User depends on Account (auto-derived)
			const config = Cache.for('User').ttl('1h').build();

			cacheRegistry.register(config);

			const deps = cacheRegistry.getDependencies('User');
			expect(deps.has('Account')).toBe(true);
			expect(deps.size).toBe(1);
		});

		it('should return all dependencies including explicit ones', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// Alert has auto-derived Account and Project deps, plus explicit Monitor dep
			const config = Cache.for('Alert').ttl('1h').dependsOn('Monitor').build();

			cacheRegistry.register(config);

			const deps = cacheRegistry.getDependencies('Alert');
			expect(deps.has('Account')).toBe(true);
			expect(deps.has('Project')).toBe(true);
			expect(deps.has('Monitor')).toBe(true);
			expect(deps.size).toBe(3);
		});
	});

	describe('validateNoCycles()', () => {
		it('should pass for empty registry', () => {
			expect(() => cacheRegistry.validateNoCycles()).not.toThrow();
		});

		it('should pass for acyclic dependencies', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// User -> Account (no cycle)
			const userConfig = Cache.for('User').ttl('1h').build();

			// Monitor -> Account, Project (no cycle)
			const monitorConfig = Cache.for('Monitor').ttl('5m').build();

			cacheRegistry.register(userConfig);
			cacheRegistry.register(monitorConfig);

			expect(() => cacheRegistry.validateNoCycles()).not.toThrow();
		});

		it('should detect direct cycle (A -> A)', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// Self-reference via explicit dependsOn
			const config = Cache.for('User').ttl('1h').dependsOn('User').build();

			cacheRegistry.register(config);

			expect(() => cacheRegistry.validateNoCycles()).toThrow(/Circular cache dependency detected/);
		});

		it('should detect indirect cycle (A -> B -> A)', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// User depends on Monitor (explicit)
			const userConfig = Cache.for('User').ttl('1h').dependsOn('Monitor').build();

			// Monitor depends on User (explicit, creates cycle)
			const monitorConfig = Cache.for('Monitor').ttl('5m').dependsOn('User').build();

			cacheRegistry.register(userConfig);
			cacheRegistry.register(monitorConfig);

			expect(() => cacheRegistry.validateNoCycles()).toThrow(/Circular cache dependency detected/);
		});
	});

	describe('getRegisteredEntityTypes()', () => {
		it('should return empty array for empty registry', () => {
			expect(cacheRegistry.getRegisteredEntityTypes()).toEqual([]);
		});

		it('should return all registered entity types', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const userConfig = Cache.for('User').ttl('1h').build();
			const monitorConfig = Cache.for('Monitor').ttl('5m').build();

			cacheRegistry.register(userConfig);
			cacheRegistry.register(monitorConfig);

			const types = cacheRegistry.getRegisteredEntityTypes();
			expect(types).toContain('User');
			expect(types).toContain('Monitor');
			expect(types.length).toBe(2);
		});
	});

	describe('size', () => {
		it('should return 0 for empty registry', () => {
			expect(cacheRegistry.size).toBe(0);
		});

		it('should count all registered configs', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const userConfig1 = Cache.for('User').ttl('1h').build();
			const userConfig2 = Cache.for('User').ttl('5m').build();
			const monitorConfig = Cache.for('Monitor').ttl('5m').build();

			cacheRegistry.register(userConfig1);
			cacheRegistry.register(userConfig2);
			cacheRegistry.register(monitorConfig);

			expect(cacheRegistry.size).toBe(3);
		});
	});

	describe('reset()', () => {
		it('should clear all data', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('User').ttl('1h').build();

			cacheRegistry.register(config);
			expect(cacheRegistry.size).toBe(1);

			cacheRegistry.reset();

			expect(cacheRegistry.size).toBe(0);
			expect(cacheRegistry.getRegisteredEntityTypes()).toEqual([]);
			expect(cacheRegistry.getDependents('Account').size).toBe(0);
		});
	});

	describe('getSummary()', () => {
		it('should return correct summary', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			// User depends on Account (1 auto-derived dep)
			const userConfig = Cache.for('User').ttl('1h').build();

			// Monitor depends on Account and Project (2 auto-derived deps)
			const monitorConfig = Cache.for('Monitor').ttl('5m').build();

			cacheRegistry.register(userConfig);
			cacheRegistry.register(monitorConfig);

			const summary = cacheRegistry.getSummary();
			expect(summary.entityTypes).toBe(2);
			expect(summary.totalConfigs).toBe(2);
			expect(summary.dependencyEdges).toBe(3); // User->Account, Monitor->Account, Monitor->Project
		});
	});
});
