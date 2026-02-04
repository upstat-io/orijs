import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper';
import { field } from '../src/field';

describe('Mapper.defineTables()', () => {
	describe('single table', () => {
		test('should create flattened table with $name property', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			expect(Tables.User.$name).toBe('user');
		});

		test('should create $fields map with field definitions', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					age: field('age').number()
				}
			});

			expect(Tables.User.$fields).toBeDefined();
			expect(Tables.User.$fields.uuid).toBeDefined();
			expect(Tables.User.$fields.uuid!.type).toBe('string');
			expect(Tables.User.$fields.age!.type).toBe('number');
		});

		test('should use column name from field builder', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					displayName: field('display_name').string(),
					isOnboarded: field('is_onboarded').boolean(),
					createdTimestamp: field('created_timestamp').date()
				}
			});

			expect(Tables.User.displayName).toBe('display_name');
			expect(Tables.User.isOnboarded).toBe('is_onboarded');
			expect(Tables.User.createdTimestamp).toBe('created_timestamp');
		});

		test('should allow property name to differ from column name', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					fbUid: field('fb_uid').string(),
					avatarUrl: field('avatar_url').string()
				}
			});

			expect(Tables.User.fbUid).toBe('fb_uid');
			expect(Tables.User.avatarUrl).toBe('avatar_url');
		});

		test('should use same name for property and column when matching', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					email: field('email').string()
				}
			});

			expect(Tables.User.uuid).toBe('uuid');
			expect(Tables.User.email).toBe('email');
		});
	});

	describe('multiple tables', () => {
		test('should define multiple tables', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					displayName: field('display_name').string()
				}
			});

			expect(Tables.User.$name).toBe('user');
			expect(Tables.Account.$name).toBe('account');
			expect(Tables.Account.displayName).toBe('display_name');
		});

		test('should keep tables independent', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					email: field('email').string()
				},
				Account: {
					tableName: 'account',
					email: field('account_email').string()
				}
			});

			expect(Tables.User.email).toBe('email');
			expect(Tables.Account.email).toBe('account_email');
		});
	});

	describe('field properties in $fields', () => {
		test('should include optional flag in $fields', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					email: field('email').string().optional()
				}
			});

			expect(Tables.User.$fields.email!.optional).toBe(true);
		});

		test('should include default value in $fields', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					isActive: field('is_active').boolean().default(false)
				}
			});

			expect(Tables.User.$fields.isActive!.defaultValue).toBe(false);
		});

		test('should store column name in $fields', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					displayName: field('display_name').string()
				}
			});

			expect(Tables.User.$fields.displayName!.column).toBe('display_name');
		});
	});

	describe('edge cases', () => {
		test('should handle single-word field names', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					uuid: field('uuid').string()
				}
			});

			expect(Tables.User.id).toBe('id');
			expect(Tables.User.uuid).toBe('uuid');
		});

		test('should handle field.any with generic type', () => {
			interface Metadata {
				tags: string[];
			}

			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					metadata: field('metadata_json').any<Metadata>()
				}
			});

			expect(Tables.User.metadata).toBe('metadata_json');
			expect(Tables.User.$fields.metadata!.type).toBe('any');
		});
	});
});

describe('Mapper.defineTable()', () => {
	test('should create single flattened table with $name property', () => {
		const UserTable = Mapper.defineTable({
			tableName: 'user',
			uuid: field('uuid').string(),
			email: field('email').string()
		});

		expect(UserTable.$name).toBe('user');
	});

	test('should create $fields map with field definitions', () => {
		const UserTable = Mapper.defineTable({
			tableName: 'user',
			uuid: field('uuid').string(),
			age: field('age').number()
		});

		expect(UserTable.$fields).toBeDefined();
		expect(UserTable.$fields.uuid).toBeDefined();
		expect(UserTable.$fields.uuid!.type).toBe('string');
		expect(UserTable.$fields.age!.type).toBe('number');
	});

	test('should expose column names as properties', () => {
		const UserTable = Mapper.defineTable({
			tableName: 'user',
			displayName: field('display_name').string(),
			createdAt: field('created_at').date()
		});

		expect(UserTable.displayName).toBe('display_name');
		expect(UserTable.createdAt).toBe('created_at');
	});

	test('should be equivalent to defineTables with single table', () => {
		const singleTable = Mapper.defineTable({
			tableName: 'user',
			uuid: field('uuid').string(),
			displayName: field('display_name').string().optional()
		});

		const Tables = Mapper.defineTables({
			User: {
				tableName: 'user',
				uuid: field('uuid').string(),
				displayName: field('display_name').string().optional()
			}
		});

		expect(singleTable.$name).toBe(Tables.User.$name);
		expect(singleTable.uuid).toBe(Tables.User.uuid);
		expect(singleTable.displayName).toBe(Tables.User.displayName);
		expect(singleTable.$fields.displayName!.optional).toBe(Tables.User.$fields.displayName!.optional);
	});

	test('should work with Mapper.for() to create mapper', () => {
		const UserTable = Mapper.defineTable({
			tableName: 'user',
			uuid: field('uuid').string(),
			email: field('email').string()
		});

		interface User {
			uuid: string;
			email: string;
		}

		const UserMapper = Mapper.for<User>(UserTable).build();
		const result = UserMapper.map({ uuid: 'abc-123', email: 'test@example.com' }).value();

		expect(result).toEqual({ uuid: 'abc-123', email: 'test@example.com' });
	});
});
