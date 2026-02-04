/**
 * EntityRegistry Unit Tests
 *
 * Tests the entity registry fluent builder:
 * - Scope definition and param inheritance
 * - Entity definition with auto-derived params
 * - Modular .use() composition
 * - Frozen registry after build
 * - Type-safe entity lookups
 * - Error handling for duplicates and invalid references
 */

import { describe, it, expect } from 'bun:test';
import { EntityRegistry, defineScopes, defineEntities } from '../src/entity-registry';
import type { EntityRegistryBuilder } from '../src/entity-registry.types';

// --- SCOPE TESTS ---

describe('EntityRegistry', () => {
	describe('scope()', () => {
		it('should define a scope with no params', () => {
			const registry = EntityRegistry.create().scope('global').build();

			const scope = registry.getScope('global');
			expect(scope.name).toBe('global');
			expect(scope.params).toEqual([]);
		});

		it('should define a scope with params', () => {
			const registry = EntityRegistry.create().scope('account', 'accountUuid').build();

			const scope = registry.getScope('account');
			expect(scope.name).toBe('account');
			expect(scope.params).toEqual(['accountUuid']);
		});

		it('should define a scope with multiple params', () => {
			const registry = EntityRegistry.create().scope('project', 'accountUuid', 'projectUuid').build();

			const scope = registry.getScope('project');
			expect(scope.params).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should inherit params from previous scopes', () => {
			const registry = EntityRegistry.create()
				.scope('global')
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.build();

			expect(registry.getScope('global').params).toEqual([]);
			expect(registry.getScope('account').params).toEqual(['accountUuid']);
			expect(registry.getScope('project').params).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should throw error for duplicate scope name', () => {
			expect(() => {
				EntityRegistry.create().scope('account', 'accountUuid').scope('account', 'tenantId');
			}).toThrow("Scope 'account' already defined");
		});

		it('should return all scope names', () => {
			const registry = EntityRegistry.create()
				.scope('global')
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.build();

			const scopeNames = registry.getScopeNames();
			expect(scopeNames).toEqual(['global', 'account', 'project']);
		});
	});

	// --- ENTITY TESTS ---

	describe('entity()', () => {
		it('should define an entity with unique keys', () => {
			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.entity('User', 'account', 'fbAuthUid')
				.build();

			const entity = registry.getEntity('User');
			expect(entity.name).toBe('User');
			expect(entity.scope).toBe('account');
			expect(entity.uniqueKeys).toEqual(['fbAuthUid']);
		});

		it('should derive entity params from scope params + unique keys', () => {
			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.entity('Monitor', 'project', 'monitorUuid')
				.build();

			const monitor = registry.getEntity('Monitor');
			expect(monitor.params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		});

		it('should define entity with no unique keys (collection pattern)', () => {
			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.entity('MonitorCollection', 'project')
				.build();

			const collection = registry.getEntity('MonitorCollection');
			expect(collection.uniqueKeys).toEqual([]);
			expect(collection.params).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should define entity with multiple unique keys', () => {
			const registry = EntityRegistry.create()
				.scope('project', 'accountUuid', 'projectUuid')
				.entity('NotificationChannel', 'project', 'channelType', 'channelName')
				.build();

			const channel = registry.getEntity('NotificationChannel');
			expect(channel.uniqueKeys).toEqual(['channelType', 'channelName']);
			expect(channel.params).toEqual(['accountUuid', 'projectUuid', 'channelType', 'channelName']);
		});

		it('should throw error for duplicate entity name', () => {
			expect(() => {
				EntityRegistry.create()
					.scope('account', 'accountUuid')
					.entity('User', 'account', 'userId')
					.entity('User', 'account', 'fbAuthUid');
			}).toThrow("Entity 'User' already defined");
		});

		it('should throw error for unknown scope reference', () => {
			const builder = EntityRegistry.create().scope('account', 'accountUuid');

			expect(() => {
				// @ts-expect-error - testing runtime error for invalid scope
				builder.entity('Monitor', 'project', 'monitorUuid');
			}).toThrow("Scope 'project' not defined");
		});

		it('should return all entity names', () => {
			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.entity('User', 'account', 'fbAuthUid')
				.entity('Account', 'account')
				.build();

			const entityNames = registry.getEntityNames();
			expect(entityNames).toContain('User');
			expect(entityNames).toContain('Account');
			expect(entityNames.length).toBe(2);
		});
	});

	// --- COMPOSITION TESTS ---

	describe('use()', () => {
		it('should apply composition function to add entities', () => {
			function addUserEntities<T extends string, S extends string>(
				reg: EntityRegistryBuilder<T, S>
			): EntityRegistryBuilder<T | 'User' | 'UserProfile', S> {
				return reg
					.entity('User', 'account' as S, 'fbAuthUid')
					.entity('UserProfile', 'account' as S, 'fbAuthUid');
			}

			const registry = EntityRegistry.create().scope('account', 'accountUuid').use(addUserEntities).build();

			expect(registry.getEntity('User').params).toEqual(['accountUuid', 'fbAuthUid']);
			expect(registry.getEntity('UserProfile').params).toEqual(['accountUuid', 'fbAuthUid']);
		});

		it('should chain multiple .use() calls', () => {
			function addUserEntities<T extends string, S extends string>(
				reg: EntityRegistryBuilder<T, S>
			): EntityRegistryBuilder<T | 'User', S> {
				return reg.entity('User', 'account' as S, 'fbAuthUid');
			}

			function addMonitorEntities<T extends string, S extends string>(
				reg: EntityRegistryBuilder<T, S>
			): EntityRegistryBuilder<T | 'Monitor', S> {
				return reg.entity('Monitor', 'project' as S, 'monitorUuid');
			}

			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.use(addUserEntities)
				.use(addMonitorEntities)
				.build();

			expect(registry.getEntity('User').scope).toBe('account');
			expect(registry.getEntity('Monitor').scope).toBe('project');
		});

		it('should allow composition functions that add scopes', () => {
			function addProjectScope<T extends string, S extends string>(
				reg: EntityRegistryBuilder<T, S>
			): EntityRegistryBuilder<T, S | 'project'> {
				return reg.scope('project', 'projectUuid');
			}

			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.use(addProjectScope)
				.entity('Monitor', 'project', 'monitorUuid')
				.build();

			expect(registry.getScope('project').params).toEqual(['accountUuid', 'projectUuid']);
			expect(registry.getEntity('Monitor').params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		});
	});

	// --- BUILD TESTS ---

	describe('build()', () => {
		it('should return frozen registry', () => {
			const registry = EntityRegistry.create().scope('global').entity('Config', 'global', 'configId').build();

			expect(Object.isFrozen(registry)).toBe(true);
		});

		it('should return registry with frozen entity definitions', () => {
			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.entity('User', 'account', 'fbAuthUid')
				.build();

			const entity = registry.getEntity('User');
			expect(Object.isFrozen(entity)).toBe(true);
			expect(Object.isFrozen(entity.params)).toBe(true);
			expect(Object.isFrozen(entity.uniqueKeys)).toBe(true);
		});

		it('should return registry with frozen scope definitions', () => {
			const registry = EntityRegistry.create().scope('account', 'accountUuid').build();

			const scope = registry.getScope('account');
			expect(Object.isFrozen(scope)).toBe(true);
			expect(Object.isFrozen(scope.params)).toBe(true);
		});

		it('should build empty registry when no scopes or entities', () => {
			const registry = EntityRegistry.create().build();

			expect(registry.getEntityNames()).toEqual([]);
			expect(registry.getScopeNames()).toEqual([]);
		});

		it('should throw error for unknown entity lookup', () => {
			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.entity('User', 'account', 'fbAuthUid')
				.build();

			expect(() => {
				// @ts-expect-error - testing runtime error for invalid entity
				registry.getEntity('NonExistent');
			}).toThrow("Entity 'NonExistent' not found in registry");
		});

		it('should throw error for unknown scope lookup', () => {
			const registry = EntityRegistry.create().scope('account', 'accountUuid').build();

			expect(() => {
				// @ts-expect-error - testing runtime error for invalid scope
				registry.getScope('project');
			}).toThrow("Scope 'project' not found in registry");
		});

		it('should expose entities Map via getter', () => {
			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.entity('User', 'account', 'fbAuthUid')
				.entity('Profile', 'account', 'profileId')
				.build();

			expect(registry.entities.size).toBe(2);
			expect(registry.entities.get('User')?.name).toBe('User');
			expect(registry.entities.get('Profile')?.scope).toBe('account');
		});

		it('should expose scopes Map via getter', () => {
			const registry = EntityRegistry.create().scope('global').scope('account', 'accountUuid').build();

			expect(registry.scopes.size).toBe(2);
			expect(registry.scopes.get('global')?.params).toEqual([]);
			expect(registry.scopes.get('account')?.params).toEqual(['accountUuid']);
		});
	});

	// --- REAL-WORLD EXAMPLE TESTS ---

	describe('real-world usage', () => {
		it('should build a complete multi-tenant entity registry', () => {
			// Define entity composition functions
			function addUserEntities<T extends string, S extends string>(
				reg: EntityRegistryBuilder<T, S>
			): EntityRegistryBuilder<T | 'User' | 'UserProfile' | 'AccountUsersCollection', S> {
				return reg
					.entity('User', 'account' as S, 'fbAuthUid')
					.entity('UserProfile', 'account' as S, 'fbAuthUid')
					.entity('AccountUsersCollection', 'account' as S);
			}

			function addMonitorEntities<T extends string, S extends string>(
				reg: EntityRegistryBuilder<T, S>
			): EntityRegistryBuilder<T | 'Monitor' | 'MonitorSettings' | 'MonitorCollection', S> {
				return reg
					.entity('Monitor', 'project' as S, 'monitorUuid')
					.entity('MonitorSettings', 'project' as S, 'monitorUuid')
					.entity('MonitorCollection', 'project' as S);
			}

			function addIncidentEntities<T extends string, S extends string>(
				reg: EntityRegistryBuilder<T, S>
			): EntityRegistryBuilder<T | 'Incident' | 'IncidentCollection', S> {
				return reg
					.entity('Incident', 'project' as S, 'incidentUuid')
					.entity('IncidentCollection', 'project' as S);
			}

			// Build the complete registry
			const registry = EntityRegistry.create()
				.scope('global')
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.entity('Account', 'account')
				.entity('Project', 'project')
				.use(addUserEntities)
				.use(addMonitorEntities)
				.use(addIncidentEntities)
				.build();

			// Verify scope hierarchy
			expect(registry.getScope('global').params).toEqual([]);
			expect(registry.getScope('account').params).toEqual(['accountUuid']);
			expect(registry.getScope('project').params).toEqual(['accountUuid', 'projectUuid']);

			// Verify entity params derivation
			expect(registry.getEntity('Account').params).toEqual(['accountUuid']);
			expect(registry.getEntity('User').params).toEqual(['accountUuid', 'fbAuthUid']);
			expect(registry.getEntity('Monitor').params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
			expect(registry.getEntity('MonitorCollection').params).toEqual(['accountUuid', 'projectUuid']);
			expect(registry.getEntity('Incident').params).toEqual(['accountUuid', 'projectUuid', 'incidentUuid']);

			// Verify entity count
			expect(registry.getEntityNames().length).toBe(10);
			expect(registry.getScopeNames().length).toBe(3);
		});

		it('should correctly derive params for deeply nested scope hierarchy', () => {
			const registry = EntityRegistry.create()
				.scope('org', 'orgId')
				.scope('workspace', 'workspaceId')
				.scope('folder', 'folderId')
				.scope('document', 'documentId')
				.entity('Comment', 'document', 'commentId')
				.build();

			const comment = registry.getEntity('Comment');
			expect(comment.params).toEqual(['orgId', 'workspaceId', 'folderId', 'documentId', 'commentId']);
		});
	});

	// --- TYPE SAFETY TESTS ---

	describe('type safety', () => {
		it('should provide type-safe entity lookups', () => {
			const registry = EntityRegistry.create()
				.scope('account', 'accountUuid')
				.entity('User', 'account', 'fbAuthUid')
				.entity('Profile', 'account', 'fbAuthUid')
				.build();

			// These should compile without error
			const user = registry.getEntity('User');
			const profile = registry.getEntity('Profile');

			expect(user.name).toBe('User');
			expect(profile.name).toBe('Profile');
		});

		it('should provide type-safe scope lookups', () => {
			const registry = EntityRegistry.create().scope('global').scope('account', 'accountUuid').build();

			// These should compile without error
			const global = registry.getScope('global');
			const account = registry.getScope('account');

			expect(global.name).toBe('global');
			expect(account.name).toBe('account');
		});
	});

	// --- FACTORY FUNCTION TESTS ---

	describe('defineScopes()', () => {
		it('should return typed scope definitions', () => {
			const Scope = defineScopes({
				Global: { name: 'global' },
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			});

			expect(Scope.Global.name).toBe('global');
			expect(Scope.Global.param).toBeUndefined();
			expect(Scope.Account.name).toBe('account');
			expect(Scope.Account.param).toBe('accountUuid');
			expect(Scope.Project.name).toBe('project');
			expect(Scope.Project.param).toBe('projectUuid');
		});

		it('should preserve type information', () => {
			const Scope = defineScopes({
				Account: { name: 'account', param: 'accountUuid' }
			} as const);

			// Verify the output has the expected structure and values
			expect(Scope.Account.name).toBe('account');
			expect(Scope.Account.param).toBe('accountUuid');
		});
	});

	describe('defineEntities()', () => {
		it('should return typed entity definitions', () => {
			const Scope = defineScopes({
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			} as const);

			const Entities = defineEntities({
				User: { name: 'User', scope: Scope.Account, param: 'fbAuthUid' },
				Monitor: { name: 'Monitor', scope: Scope.Project, param: 'monitorUuid' },
				MonitorCollection: { name: 'MonitorCollection', scope: Scope.Project }
			} as const);

			expect(Entities.User.name).toBe('User');
			expect(Entities.User.scope).toBe(Scope.Account);
			expect(Entities.User.param).toBe('fbAuthUid');
			expect(Entities.Monitor.name).toBe('Monitor');
			expect(Entities.Monitor.scope).toBe(Scope.Project);
			expect(Entities.Monitor.param).toBe('monitorUuid');
			expect(Entities.MonitorCollection.name).toBe('MonitorCollection');
			expect(Entities.MonitorCollection.scope).toBe(Scope.Project);
			expect(Entities.MonitorCollection.param).toBeUndefined();
		});

		it('should preserve type information', () => {
			const Scope = defineScopes({
				Account: { name: 'account', param: 'accountUuid' }
			} as const);

			const Entities = defineEntities({
				User: { name: 'User', scope: Scope.Account, param: 'fbAuthUid' }
			} as const);

			// Verify the output has the expected structure and values
			expect(Entities.User.name).toBe('User');
			expect(Entities.User.scope.name).toBe('account');
		});
	});

	// --- BULK REGISTRATION TESTS ---

	describe('scopes()', () => {
		it('should register all scopes from object', () => {
			const Scope = defineScopes({
				Global: { name: 'global' },
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			});

			const registry = EntityRegistry.create().scopes(Scope).build();

			expect(registry.getScopeNames()).toEqual(['global', 'account', 'project']);
			expect(registry.getScope('global').params).toEqual([]);
			expect(registry.getScope('account').params).toEqual(['accountUuid']);
			expect(registry.getScope('project').params).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should chain with .entity() calls', () => {
			const Scope = defineScopes({
				Global: { name: 'global' },
				Account: { name: 'account', param: 'accountUuid' }
			});

			const registry = EntityRegistry.create().scopes(Scope).entity('User', 'account', 'fbAuthUid').build();

			expect(registry.getEntity('User').params).toEqual(['accountUuid', 'fbAuthUid']);
		});
	});

	describe('entities()', () => {
		it('should register all entities from object', () => {
			const Scope = defineScopes({
				Global: { name: 'global' },
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			});

			const Entities = defineEntities({
				User: { name: 'User', scope: Scope.Account, param: 'fbAuthUid' },
				Monitor: { name: 'Monitor', scope: Scope.Project, param: 'monitorUuid' },
				MonitorCollection: { name: 'MonitorCollection', scope: Scope.Project }
			});

			const registry = EntityRegistry.create().scopes(Scope).entities(Entities).build();

			expect(registry.getEntityNames()).toContain('User');
			expect(registry.getEntityNames()).toContain('Monitor');
			expect(registry.getEntityNames()).toContain('MonitorCollection');
			expect(registry.getEntity('User').params).toEqual(['accountUuid', 'fbAuthUid']);
			expect(registry.getEntity('Monitor').params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
			expect(registry.getEntity('MonitorCollection').params).toEqual(['accountUuid', 'projectUuid']);
		});

		it('should chain with .entity() calls', () => {
			const Scope = defineScopes({
				Account: { name: 'account', param: 'accountUuid' }
			});

			const Entities = defineEntities({
				User: { name: 'User', scope: Scope.Account, param: 'fbAuthUid' }
			});

			const registry = EntityRegistry.create()
				.scopes(Scope)
				.entities(Entities)
				.entity('Profile', 'account', 'profileId')
				.build();

			expect(registry.getEntityNames()).toContain('User');
			expect(registry.getEntityNames()).toContain('Profile');
		});
	});

	// --- COMPLETE FACTORY-BASED WORKFLOW TESTS ---

	describe('factory-based workflow', () => {
		it('should build complete registry using factory functions', () => {
			// Step 1: Define scopes
			const Scope = defineScopes({
				Global: { name: 'global' },
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			});

			// Step 2: Define entities using scope references
			const Entities = defineEntities({
				Account: { name: 'Account', scope: Scope.Account },
				Project: { name: 'Project', scope: Scope.Project },
				User: { name: 'User', scope: Scope.Account, param: 'fbAuthUid' },
				Monitor: { name: 'Monitor', scope: Scope.Project, param: 'monitorUuid' },
				MonitorSettings: { name: 'MonitorSettings', scope: Scope.Project, param: 'monitorUuid' },
				MonitorCollection: { name: 'MonitorCollection', scope: Scope.Project }
			});

			// Step 3: Build registry
			const registry = EntityRegistry.create().scopes(Scope).entities(Entities).build();

			// Verify scope hierarchy
			expect(registry.getScope('global').params).toEqual([]);
			expect(registry.getScope('account').params).toEqual(['accountUuid']);
			expect(registry.getScope('project').params).toEqual(['accountUuid', 'projectUuid']);

			// Verify entity params derivation
			expect(registry.getEntity('Account').params).toEqual(['accountUuid']);
			expect(registry.getEntity('User').params).toEqual(['accountUuid', 'fbAuthUid']);
			expect(registry.getEntity('Monitor').params).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
			expect(registry.getEntity('MonitorCollection').params).toEqual(['accountUuid', 'projectUuid']);

			// Verify counts
			expect(registry.getEntityNames().length).toBe(6);
			expect(registry.getScopeNames().length).toBe(3);
		});

		it('should combine factory functions with .use() composition', () => {
			const Scope = defineScopes({
				Global: { name: 'global' },
				Account: { name: 'account', param: 'accountUuid' },
				Project: { name: 'project', param: 'projectUuid' }
			});

			const CoreEntities = defineEntities({
				Account: { name: 'Account', scope: Scope.Account },
				Project: { name: 'Project', scope: Scope.Project }
			});

			// Use function still works for modular composition
			function addMonitorEntities<T extends string, S extends string>(
				reg: EntityRegistryBuilder<T, S>
			): EntityRegistryBuilder<T | 'Monitor' | 'MonitorSettings', S> {
				return reg
					.entity('Monitor', 'project' as S, 'monitorUuid')
					.entity('MonitorSettings', 'project' as S, 'monitorUuid');
			}

			const registry = EntityRegistry.create()
				.scopes(Scope)
				.entities(CoreEntities)
				.use(addMonitorEntities)
				.build();

			expect(registry.getEntityNames()).toContain('Account');
			expect(registry.getEntityNames()).toContain('Project');
			expect(registry.getEntityNames()).toContain('Monitor');
			expect(registry.getEntityNames()).toContain('MonitorSettings');
			expect(registry.getEntityNames().length).toBe(4);
		});
	});
});
