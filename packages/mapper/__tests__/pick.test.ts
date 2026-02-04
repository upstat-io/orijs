import { describe, it, expect } from 'bun:test';
import { Mapper, field } from '../src';

describe('Mapper.pick', () => {
	const UserTable = Mapper.defineTable({
		tableName: 'user',
		uuid: field('uuid').string(),
		displayName: field('display_name').string().optional(),
		email: field('email').string().optional()
	});

	const AccountTable = Mapper.defineTable({
		tableName: 'account',
		accountId: field('id').number(),
		accountUuid: field('uuid').string(),
		accountName: field('display_name').string().optional()
	});

	const ProjectTable = Mapper.defineTable({
		tableName: 'project',
		projectId: field('id').number(),
		projectUuid: field('uuid').string(),
		projectName: field('name').string().optional()
	});

	describe('pick without prefix', () => {
		it('should pick fields using column names directly', () => {
			interface UserWithAccount {
				uuid: string;
				displayName?: string;
				email?: string;
				accountId: number;
			}

			const mapper = Mapper.for<UserWithAccount>(UserTable).pick(AccountTable, 'accountId').build();

			const row = {
				uuid: 'user-123',
				display_name: 'John Doe',
				email: 'john@example.com',
				id: 42 // AccountTable.accountId maps to 'id' column
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'John Doe',
				email: 'john@example.com',
				accountId: 42
			});
		});

		it('should share columns when tables have same column name', () => {
			interface UserWithAccount {
				uuid: string;
				displayName?: string;
				email?: string;
				accountName?: string;
			}

			const mapper = Mapper.for<UserWithAccount>(UserTable).pick(AccountTable, 'accountName').build();

			// Both UserTable.displayName and AccountTable.accountName map to 'display_name'
			const row = {
				uuid: 'user-123',
				display_name: 'Shared Name'
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'Shared Name',
				email: undefined,
				accountName: 'Shared Name'
			});
		});
	});

	describe('pick with prefix', () => {
		it('should use prefix for picked fields when prefix is called', () => {
			interface UserWithAccount {
				uuid: string;
				displayName?: string;
				email?: string;
				accountId: number;
				accountUuid: string;
			}

			const mapper = Mapper.for<UserWithAccount>(UserTable)
				.pick(AccountTable, 'accountId', 'accountUuid')
				.prefix('account_')
				.build();

			const row = {
				uuid: 'user-123',
				display_name: 'John Doe',
				account_id: 42, // prefix + column
				account_uuid: 'acc-456' // prefix + column
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'John Doe',
				email: undefined,
				accountId: 42,
				accountUuid: 'acc-456'
			});
		});

		it('should handle multiple picks with different prefixes', () => {
			interface UserWithAccountAndProject {
				uuid: string;
				displayName?: string;
				email?: string;
				accountId: number;
				accountUuid: string;
				projectId: number;
				projectUuid: string;
			}

			const mapper = Mapper.for<UserWithAccountAndProject>(UserTable)
				.pick(AccountTable, 'accountId', 'accountUuid')
				.prefix('account_')
				.pick(ProjectTable, 'projectId', 'projectUuid')
				.prefix('project_')
				.build();

			const row = {
				uuid: 'user-123',
				account_id: 42,
				account_uuid: 'acc-456',
				project_id: 99,
				project_uuid: 'proj-789'
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: undefined,
				email: undefined,
				accountId: 42,
				accountUuid: 'acc-456',
				projectId: 99,
				projectUuid: 'proj-789'
			});
		});
	});

	describe('pick with primary table prefix', () => {
		it('should combine primary table prefix with pick prefix', () => {
			interface UserWithAccount {
				uuid: string;
				displayName?: string;
				email?: string;
				accountId: number;
			}

			const mapper = Mapper.for<UserWithAccount>(UserTable)
				.pick(AccountTable, 'accountId')
				.prefix('account_')
				.build();

			const row = {
				user_uuid: 'user-123',
				user_display_name: 'John',
				account_id: 99
			};

			const result = mapper.map(row, { prefix: 'user_' }).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'John',
				email: undefined,
				accountId: 99
			});
		});
	});

	describe('pick with defaults', () => {
		it('should apply default values to picked fields', () => {
			const TableWithDefaults = Mapper.defineTable({
				tableName: 'with_defaults',
				isActive: field('is_active').boolean().optional().default(false),
				count: field('count').number().optional().default(0)
			});

			interface UserWithDefaults {
				uuid: string;
				displayName?: string;
				email?: string;
				isActive: boolean;
				count: number;
			}

			const mapper = Mapper.for<UserWithDefaults>(UserTable)
				.pick(TableWithDefaults, 'isActive', 'count')
				.build();

			const row = {
				uuid: 'user-123'
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: undefined,
				email: undefined,
				isActive: false,
				count: 0
			});
		});
	});

	describe('pick with default(null) - SQL null safety', () => {
		it('should return null (not undefined) when picked field uses .default(null)', () => {
			const TableWithNullDefault = Mapper.defineTable({
				tableName: 'with_null_default',
				metadata: field('metadata').any().default(null),
				config: field('config').any().default(null)
			});

			interface UserWithNullDefaults {
				uuid: string;
				metadata: unknown | null;
				config: unknown | null;
			}

			const mapper = Mapper.for<UserWithNullDefaults>(UserTable)
				.pick(TableWithNullDefault, 'metadata', 'config')
				.build();

			const row = {
				uuid: 'user-123'
				// metadata and config columns missing
			};

			const result = mapper.map(row).value();

			// Must be null, NOT undefined - undefined throws in SQL
			expect(result!.metadata).toBeNull();
			expect(result!.config).toBeNull();
			expect(result!.metadata).not.toBeUndefined();
			expect(result!.config).not.toBeUndefined();
		});

		it('should distinguish between .optional() (returns undefined) and .default(null) (returns null) in pick', () => {
			const TableWithBothPatterns = Mapper.defineTable({
				tableName: 'mixed_patterns',
				optionalField: field('optional_field').any().optional(),
				nullDefaultField: field('null_default_field').any().default(null)
			});

			interface UserWithMixedPatterns {
				uuid: string;
				optionalField?: unknown;
				nullDefaultField: unknown | null;
			}

			const mapper = Mapper.for<UserWithMixedPatterns>(UserTable)
				.pick(TableWithBothPatterns, 'optionalField', 'nullDefaultField')
				.build();

			const row = {
				uuid: 'user-123'
				// Both columns missing
			};

			const result = mapper.map(row).value();

			// .optional() returns undefined
			expect(result!.optionalField).toBeUndefined();

			// .default(null) returns null
			expect(result!.nullDefaultField).toBeNull();
		});

		it('should preserve actual value when .default(null) is set but value is provided in pick', () => {
			const TableWithNullDefault = Mapper.defineTable({
				tableName: 'with_null_default',
				metadata: field('metadata').any<{ key: string } | null>().default(null)
			});

			interface UserWithMetadata {
				uuid: string;
				metadata: { key: string } | null;
			}

			const mapper = Mapper.for<UserWithMetadata>(UserTable).pick(TableWithNullDefault, 'metadata').build();

			const metadataValue = { key: 'value' };
			const row = {
				uuid: 'user-123',
				metadata: metadataValue
			};

			const result = mapper.map(row).value();

			expect(result!.metadata).toEqual(metadataValue);
		});
	});

	describe('pick ignores unknown fields', () => {
		it('should silently ignore fields not in the table definition', () => {
			interface UserWithAccount {
				uuid: string;
				displayName?: string;
				email?: string;
				accountId: number;
			}

			const mapper = Mapper.for<UserWithAccount>(UserTable)
				.pick(AccountTable, 'accountId', 'nonExistentField' as any)
				.build();

			const row = {
				uuid: 'user-123',
				id: 42
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: undefined,
				email: undefined,
				accountId: 42
			});
		});
	});

	describe('fluent chaining', () => {
		it('should allow chaining pick with other builder methods', () => {
			const TeamTable = Mapper.defineTable({
				tableName: 'team',
				teamId: field('id').number(),
				teamName: field('name').string()
			});

			interface UserWithTeam {
				uuid: string;
				displayName?: string;
				email?: string;
				accountId: number;
				team?: { teamId: number; teamName: string };
			}

			const mapper = Mapper.for<UserWithTeam>(UserTable)
				.pick(AccountTable, 'accountId')
				.embed('team', TeamTable)
				.prefix('team_')
				.build();

			const row = {
				uuid: 'user-123',
				id: 42,
				team_id: 1,
				team_name: 'Engineering'
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: undefined,
				email: undefined,
				accountId: 42,
				team: {
					teamId: 1,
					teamName: 'Engineering'
				}
			});
		});
	});
});
