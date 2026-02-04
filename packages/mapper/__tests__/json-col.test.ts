import { describe, it, expect } from 'bun:test';
import { Mapper, field } from '../src';

describe('Mapper.json', () => {
	const UserTable = Mapper.defineTable({
		tableName: 'user',
		uuid: field('uuid').string(),
		displayName: field('display_name').string().optional()
	});

	interface ProjectRole {
		name: string;
		projectUuid: string;
		role: number;
	}

	interface UserAccount {
		accountUuid: string;
		displayName: string;
	}

	describe('basic json parsing', () => {
		it('should parse JSON array from column', () => {
			interface UserWithProjects {
				uuid: string;
				project_roles: ProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable).json<ProjectRole[]>('project_roles').build();

			const row = {
				uuid: 'user-123',
				project_roles: [
					{ name: 'Project A', projectUuid: 'proj-1', role: 1 },
					{ name: 'Project B', projectUuid: 'proj-2', role: 2 }
				]
			};

			const result = mapper.map(row).value();

			expect(result?.project_roles).toEqual([
				{ name: 'Project A', projectUuid: 'proj-1', role: 1 },
				{ name: 'Project B', projectUuid: 'proj-2', role: 2 }
			]);
		});

		it('should parse JSON string into array', () => {
			interface UserWithProjects {
				uuid: string;
				project_roles: ProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable).json<ProjectRole[]>('project_roles').build();

			const row = {
				uuid: 'user-123',
				project_roles: '[{"name":"Project A","projectUuid":"proj-1","role":1}]'
			};

			const result = mapper.map(row).value();

			expect(result?.project_roles).toEqual([{ name: 'Project A', projectUuid: 'proj-1', role: 1 }]);
		});

		it('should return null for null JSON column', () => {
			interface UserWithProjects {
				uuid: string;
				project_roles: ProjectRole[] | null;
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[] | null>('project_roles')
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: null
			};

			const result = mapper.map(row).value();

			expect(result?.project_roles).toBeNull();
		});
	});

	describe('json with as()', () => {
		it('should rename property using as()', () => {
			interface UserWithProjects {
				uuid: string;
				projects: ProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[]>('project_roles')
				.as('projects')
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: [{ name: 'Project A', projectUuid: 'proj-1', role: 1 }]
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toEqual([{ name: 'Project A', projectUuid: 'proj-1', role: 1 }]);
			expect((result as any).project_roles).toBeUndefined();
		});
	});

	describe('multiple json columns', () => {
		it('should handle multiple json columns', () => {
			interface UserWithProjectsAndAccounts {
				uuid: string;
				projects: ProjectRole[];
				accounts: UserAccount[];
			}

			const mapper = Mapper.for<UserWithProjectsAndAccounts>(UserTable)
				.json<ProjectRole[]>('project_roles')
				.as('projects')
				.json<UserAccount[]>('accounts')
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: [{ name: 'Project A', projectUuid: 'proj-1', role: 1 }],
				accounts: [{ accountUuid: 'acc-1', displayName: 'Acme' }]
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toHaveLength(1);
			expect(result?.accounts).toHaveLength(1);
			expect(result?.accounts[0]!.accountUuid).toBe('acc-1');
		});
	});
});

describe('Mapper.col', () => {
	const UserTable = Mapper.defineTable({
		tableName: 'user',
		uuid: field('uuid').string(),
		displayName: field('display_name').string().optional()
	});

	describe('basic column mapping', () => {
		it('should map raw column with property rename', () => {
			interface UserWithIncidentCount {
				uuid: string;
				activeIncidentCount: number;
			}

			const mapper = Mapper.for<UserWithIncidentCount>(UserTable)
				.col<number>('activeIncidentCount') // Infers 'active_incident_count'
				.build();

			const row = {
				uuid: 'user-123',
				active_incident_count: 5
			};

			const result = mapper.map(row).value();

			expect(result?.activeIncidentCount).toBe(5);
		});

		it('should use column name as property when not specified', () => {
			interface UserWithCount {
				uuid: string;
				count: number;
			}

			const mapper = Mapper.for<UserWithCount>(UserTable).col<number>('count').build();

			const row = {
				uuid: 'user-123',
				count: 42
			};

			const result = mapper.map(row).value();

			expect(result?.count).toBe(42);
		});
	});

	describe('col with default', () => {
		it('should apply default when column is null', () => {
			interface UserWithIncidentCount {
				uuid: string;
				activeIncidentCount: number;
			}

			const mapper = Mapper.for<UserWithIncidentCount>(UserTable)
				.col<number>('activeIncidentCount')
				.default(0)
				.build();

			const row = {
				uuid: 'user-123',
				active_incident_count: null
			};

			const result = mapper.map(row).value();

			expect(result?.activeIncidentCount).toBe(0);
		});

		it('should apply default when column is undefined', () => {
			interface UserWithOnCall {
				uuid: string;
				isOnCall: boolean;
			}

			const mapper = Mapper.for<UserWithOnCall>(UserTable).col<boolean>('isOnCall').default(false).build();

			const row = {
				uuid: 'user-123'
				// is_on_call not present
			};

			const result = mapper.map(row).value();

			expect(result?.isOnCall).toBe(false);
		});

		it('should not apply default when column has value', () => {
			interface UserWithOnCall {
				uuid: string;
				isOnCall: boolean;
			}

			const mapper = Mapper.for<UserWithOnCall>(UserTable).col<boolean>('isOnCall').default(false).build();

			const row = {
				uuid: 'user-123',
				is_on_call: true
			};

			const result = mapper.map(row).value();

			expect(result?.isOnCall).toBe(true);
		});
	});

	describe('multiple cols', () => {
		it('should handle multiple calculated columns', () => {
			interface UserProfile {
				uuid: string;
				activeIncidentCount: number;
				isOnCall: boolean;
				currentRosterName: string | null;
			}

			const mapper = Mapper.for<UserProfile>(UserTable)
				.col<number>('activeIncidentCount')
				.default(0)
				.col<boolean>('isOnCall')
				.default(false)
				.col<string | null>('currentRosterName')
				.build();

			const row = {
				uuid: 'user-123',
				active_incident_count: 3,
				is_on_call: true,
				current_roster_name: 'On-Call Team'
			};

			const result = mapper.map(row).value();

			expect(result?.activeIncidentCount).toBe(3);
			expect(result?.isOnCall).toBe(true);
			expect(result?.currentRosterName).toBe('On-Call Team');
		});
	});

	describe('col chaining with other methods', () => {
		it('should chain col with json', () => {
			interface ProjectRole {
				name: string;
			}

			interface UserProfile {
				uuid: string;
				activeIncidentCount: number;
				projects: ProjectRole[];
			}

			const mapper = Mapper.for<UserProfile>(UserTable)
				.col<number>('activeIncidentCount')
				.default(0)
				.json<ProjectRole[]>('project_roles')
				.as('projects')
				.build();

			const row = {
				uuid: 'user-123',
				active_incident_count: 2,
				project_roles: [{ name: 'Project A' }]
			};

			const result = mapper.map(row).value();

			expect(result?.activeIncidentCount).toBe(2);
			expect(result?.projects).toEqual([{ name: 'Project A' }]);
		});

		it('should chain col with pick', () => {
			const AccountTable = Mapper.defineTable({
				tableName: 'account',
				accountId: field('id').number(),
				accountUuid: field('uuid').string()
			});

			interface UserWithAccount {
				uuid: string;
				accountId: number;
				isOnCall: boolean;
			}

			const mapper = Mapper.for<UserWithAccount>(UserTable)
				.pick(AccountTable, 'accountId')
				.prefix('account_')
				.col<boolean>('isOnCall')
				.default(false)
				.build();

			const row = {
				uuid: 'user-123',
				account_id: 42,
				is_on_call: true
			};

			const result = mapper.map(row).value();

			expect(result?.accountId).toBe(42);
			expect(result?.isOnCall).toBe(true);
		});
	});
});

describe('Mapper.json with factory', () => {
	const UserTable = Mapper.defineTable({
		tableName: 'user',
		uuid: field('uuid').string(),
		displayName: field('display_name').string().optional()
	});

	// Types matching DB format (snake_case JSON)
	interface DbProjectRole {
		name: string;
		project_uuid: string;
		role_id: number;
		default_project: boolean;
	}

	interface DbUserAccount {
		account_uuid: string;
		display_name: string;
		role_id: number;
		is_pending_deletion: boolean;
	}

	// Types for application use (camelCase)
	interface ProjectRole {
		name: string;
		projectUuid: string;
		roleId: number;
		isDefault: boolean;
	}

	interface UserAccount {
		accountUuid: string;
		displayName: string;
		roleId: number;
		isPendingDeletion: boolean;
	}

	// Factory functions to transform snake_case to camelCase
	function mapProjectRoles(raw: unknown): ProjectRole[] {
		if (!raw || !Array.isArray(raw)) return [];
		return raw.map((pr: DbProjectRole) => ({
			name: pr.name,
			projectUuid: pr.project_uuid,
			roleId: pr.role_id,
			isDefault: pr.default_project ?? false
		}));
	}

	function mapUserAccounts(raw: unknown): UserAccount[] {
		if (!raw || !Array.isArray(raw)) return [];
		return raw.map((a: DbUserAccount) => ({
			accountUuid: a.account_uuid,
			displayName: a.display_name,
			roleId: a.role_id,
			isPendingDeletion: a.is_pending_deletion ?? false
		}));
	}

	describe('json with factory transformation', () => {
		it('should transform snake_case JSON to camelCase using factory', () => {
			interface UserWithProjects {
				uuid: string;
				projects: ProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[]>('project_roles', mapProjectRoles)
				.as('projects')
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: [
					{ name: 'Project A', project_uuid: 'proj-1', role_id: 1, default_project: true },
					{ name: 'Project B', project_uuid: 'proj-2', role_id: 2, default_project: false }
				]
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toEqual([
				{ name: 'Project A', projectUuid: 'proj-1', roleId: 1, isDefault: true },
				{ name: 'Project B', projectUuid: 'proj-2', roleId: 2, isDefault: false }
			]);
		});

		it('should handle null JSON with factory', () => {
			interface UserWithProjects {
				uuid: string;
				projects: ProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[]>('project_roles', mapProjectRoles)
				.as('projects')
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: null
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toEqual([]);
		});

		it('should handle empty array JSON with factory', () => {
			interface UserWithProjects {
				uuid: string;
				projects: ProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[]>('project_roles', mapProjectRoles)
				.as('projects')
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: []
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toEqual([]);
		});

		it('should handle JSON string with factory', () => {
			interface UserWithProjects {
				uuid: string;
				projects: ProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[]>('project_roles', mapProjectRoles)
				.as('projects')
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: '[{"name":"Project A","project_uuid":"proj-1","role_id":1,"default_project":true}]'
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toEqual([
				{ name: 'Project A', projectUuid: 'proj-1', roleId: 1, isDefault: true }
			]);
		});
	});

	describe('multiple json columns with different factories', () => {
		it('should handle multiple json columns with different factories', () => {
			interface UserWithProjectsAndAccounts {
				uuid: string;
				projects: ProjectRole[];
				accounts: UserAccount[];
			}

			const mapper = Mapper.for<UserWithProjectsAndAccounts>(UserTable)
				.json<ProjectRole[]>('project_roles', mapProjectRoles)
				.as('projects')
				.json<UserAccount[]>('accounts', mapUserAccounts)
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: [{ name: 'Project A', project_uuid: 'proj-1', role_id: 1, default_project: true }],
				accounts: [
					{ account_uuid: 'acc-1', display_name: 'Acme Corp', role_id: 1, is_pending_deletion: false }
				]
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toEqual([
				{ name: 'Project A', projectUuid: 'proj-1', roleId: 1, isDefault: true }
			]);
			expect(result?.accounts).toEqual([
				{ accountUuid: 'acc-1', displayName: 'Acme Corp', roleId: 1, isPendingDeletion: false }
			]);
		});
	});

	describe('json without factory still works', () => {
		it('should pass through JSON unchanged when no factory provided', () => {
			interface UserWithProjects {
				uuid: string;
				project_roles: DbProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable).json<DbProjectRole[]>('project_roles').build();

			const row = {
				uuid: 'user-123',
				project_roles: [{ name: 'Project A', project_uuid: 'proj-1', role_id: 1, default_project: true }]
			};

			const result = mapper.map(row).value();

			// Without factory, JSON passes through unchanged (snake_case)
			expect(result?.project_roles).toEqual([
				{ name: 'Project A', project_uuid: 'proj-1', role_id: 1, default_project: true }
			]);
		});
	});

	describe('json with default', () => {
		it('should apply default when JSON column is null', () => {
			interface UserWithTeams {
				uuid: string;
				teams: string[];
			}

			const mapper = Mapper.for<UserWithTeams>(UserTable).json<string[]>('teams').default([]).build();

			const row = {
				uuid: 'user-123',
				teams: null
			};

			const result = mapper.map(row).value();

			expect(result?.teams).toEqual([]);
		});

		it('should apply default when JSON column is missing', () => {
			interface UserWithTeams {
				uuid: string;
				teams: string[];
			}

			const mapper = Mapper.for<UserWithTeams>(UserTable).json<string[]>('teams').default([]).build();

			const row = {
				uuid: 'user-123'
				// teams is missing
			};

			const result = mapper.map(row).value();

			expect(result?.teams).toEqual([]);
		});

		it('should not apply default when JSON column has value', () => {
			interface UserWithTeams {
				uuid: string;
				teams: string[];
			}

			const mapper = Mapper.for<UserWithTeams>(UserTable).json<string[]>('teams').default([]).build();

			const row = {
				uuid: 'user-123',
				teams: ['team-1', 'team-2']
			};

			const result = mapper.map(row).value();

			expect(result?.teams).toEqual(['team-1', 'team-2']);
		});

		it('should apply default after factory returns null/undefined', () => {
			interface UserWithProjects {
				uuid: string;
				projects: ProjectRole[] | undefined;
			}

			// Factory that returns undefined for null input
			function mapJsonProjects(raw: unknown): ProjectRole[] | undefined {
				if (!raw || !Array.isArray(raw)) return undefined;
				return raw.map((pr: DbProjectRole) => ({
					name: pr.name,
					projectUuid: pr.project_uuid,
					roleId: pr.role_id,
					isDefault: pr.default_project ?? false
				}));
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[] | undefined>('project_roles', mapJsonProjects)
				.as('projects')
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: null
			};

			const result = mapper.map(row).value();

			// Factory returns undefined for null, no default set
			expect(result?.projects).toBeUndefined();
		});
	});

	describe('json with .as().default() chaining', () => {
		it('should allow chaining .as() and .default() on JSON', () => {
			interface UserWithItems {
				uuid: string;
				lineItems: string[];
			}

			const mapper = Mapper.for<UserWithItems>(UserTable)
				.json<string[]>('items')
				.as('lineItems')
				.default([])
				.build();

			const row = {
				uuid: 'user-123',
				items: null
			};

			const result = mapper.map(row).value();

			expect(result?.lineItems).toEqual([]);
		});

		it('should apply .as().default() with factory', () => {
			interface UserWithProjects {
				uuid: string;
				projectList: ProjectRole[];
			}

			// Factory handles null by returning null, then .default() kicks in
			function mapJsonProjects(raw: unknown): ProjectRole[] | null {
				if (!raw) return null;
				return (raw as DbProjectRole[]).map((pr) => ({
					name: pr.name,
					projectUuid: pr.project_uuid,
					roleId: pr.role_id,
					isDefault: pr.default_project ?? false
				}));
			}

			// Cast needed because factory intentionally returns null to test default behavior
			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[]>('project_roles', mapJsonProjects as (raw: unknown) => ProjectRole[])
				.as('projectList')
				.default([])
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: null
			};

			const result = mapper.map(row).value();

			// Factory returns null for null input, then .default([]) is applied
			expect(result?.projectList).toEqual([]);
		});

		it('should use actual value when .as().default() is set', () => {
			interface UserWithTags {
				uuid: string;
				tagList: string[];
			}

			const mapper = Mapper.for<UserWithTags>(UserTable)
				.json<string[]>('tags')
				.as('tagList')
				.default([])
				.build();

			const row = {
				uuid: 'user-123',
				tags: ['urgent', 'important']
			};

			const result = mapper.map(row).value();

			expect(result?.tagList).toEqual(['urgent', 'important']);
		});

		it('should chain .as().default() with other builder methods', () => {
			interface UserProfile {
				uuid: string;
				displayName?: string;
				roles: string[];
				activeCount: number;
			}

			const mapper = Mapper.for<UserProfile>(UserTable)
				.json<string[]>('user_roles')
				.as('roles')
				.default([])
				.col<number>('activeCount')
				.default(0)
				.build();

			const row = {
				uuid: 'user-123',
				display_name: 'John',
				user_roles: ['admin', 'editor'],
				active_count: 5
			};

			const result = mapper.map(row).value();

			expect(result?.roles).toEqual(['admin', 'editor']);
			expect(result?.activeCount).toBe(5);
		});

		it('should work with multiple .as().default() chains', () => {
			interface UserWithMultiple {
				uuid: string;
				projects: string[];
				teams: string[];
			}

			const mapper = Mapper.for<UserWithMultiple>(UserTable)
				.json<string[]>('project_list')
				.as('projects')
				.default([])
				.json<string[]>('team_list')
				.as('teams')
				.default([])
				.build();

			const row = {
				uuid: 'user-123',
				project_list: ['proj-1'],
				team_list: null
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toEqual(['proj-1']);
			expect(result?.teams).toEqual([]);
		});

		it('should still work with just .as() (no .default())', () => {
			interface UserWithItems {
				uuid: string;
				lineItems: string[] | null;
			}

			const mapper = Mapper.for<UserWithItems>(UserTable)
				.json<string[] | null>('items')
				.as('lineItems')
				.build();

			const row = {
				uuid: 'user-123',
				items: null
			};

			const result = mapper.map(row).value();

			expect(result?.lineItems).toBeNull();
		});

		it('should still work with just .default() (no .as())', () => {
			interface UserWithItems {
				uuid: string;
				items: string[];
			}

			const mapper = Mapper.for<UserWithItems>(UserTable).json<string[]>('items').default([]).build();

			const row = {
				uuid: 'user-123',
				items: null
			};

			const result = mapper.map(row).value();

			expect(result?.items).toEqual([]);
		});
	});

	describe('json with .optional()', () => {
		it('should return undefined when JSON column is null', () => {
			interface UserWithProjects {
				uuid: string;
				projects?: ProjectRole[];
			}

			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[]>('project_roles')
				.as('projects')
				.optional()
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: null
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toBeUndefined();
		});

		it('should return undefined when JSON column is missing', () => {
			interface UserWithTeams {
				uuid: string;
				teams?: string[];
			}

			const mapper = Mapper.for<UserWithTeams>(UserTable).json<string[]>('teams').optional().build();

			const row = {
				uuid: 'user-123'
				// teams not present
			};

			const result = mapper.map(row).value();

			expect(result?.teams).toBeUndefined();
		});

		it('should return value when JSON column has data', () => {
			interface UserWithTeams {
				uuid: string;
				teams?: string[];
			}

			const mapper = Mapper.for<UserWithTeams>(UserTable).json<string[]>('teams').optional().build();

			const row = {
				uuid: 'user-123',
				teams: ['team-1', 'team-2']
			};

			const result = mapper.map(row).value();

			expect(result?.teams).toEqual(['team-1', 'team-2']);
		});

		it('should work with factory and .optional()', () => {
			// Factory that returns null for null input
			function mapJsonProjects(raw: unknown): ProjectRole[] | null {
				if (!raw || !Array.isArray(raw)) return null;
				return raw.map((pr: DbProjectRole) => ({
					name: pr.name,
					projectUuid: pr.project_uuid,
					roleId: pr.role_id,
					isDefault: pr.default_project ?? false
				}));
			}

			interface UserWithProjects {
				uuid: string;
				projects?: ProjectRole[];
			}

			// Cast needed because factory intentionally returns null to test .optional() behavior
			const mapper = Mapper.for<UserWithProjects>(UserTable)
				.json<ProjectRole[]>('project_roles', mapJsonProjects as (raw: unknown) => ProjectRole[])
				.as('projects')
				.optional()
				.build();

			const row = {
				uuid: 'user-123',
				project_roles: null
			};

			const result = mapper.map(row).value();

			// Factory returns null, .optional() converts to undefined
			expect(result?.projects).toBeUndefined();
		});

		it('should chain .as() and .optional()', () => {
			interface UserWithItems {
				uuid: string;
				lineItems?: string[];
			}

			const mapper = Mapper.for<UserWithItems>(UserTable)
				.json<string[]>('items')
				.as('lineItems')
				.optional()
				.build();

			const row = {
				uuid: 'user-123',
				items: null
			};

			const result = mapper.map(row).value();

			expect(result?.lineItems).toBeUndefined();
		});

		it('should handle multiple .optional() columns', () => {
			interface UserWithOptionals {
				uuid: string;
				projects?: string[];
				teams?: string[];
			}

			const mapper = Mapper.for<UserWithOptionals>(UserTable)
				.json<string[]>('project_list')
				.as('projects')
				.optional()
				.json<string[]>('team_list')
				.as('teams')
				.optional()
				.build();

			const row = {
				uuid: 'user-123',
				project_list: ['proj-1'],
				team_list: null
			};

			const result = mapper.map(row).value();

			expect(result?.projects).toEqual(['proj-1']);
			expect(result?.teams).toBeUndefined();
		});

		it('should work with just .optional() (no .as())', () => {
			interface UserWithTags {
				uuid: string;
				tags?: string[];
			}

			const mapper = Mapper.for<UserWithTags>(UserTable).json<string[]>('tags').optional().build();

			const row = {
				uuid: 'user-123',
				tags: null
			};

			const result = mapper.map(row).value();

			expect(result?.tags).toBeUndefined();
		});
	});
});
