import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper';
import { field } from '../src/field';

/**
 * Functional Test: Tables + Mapper Integration
 *
 * Verifies end-to-end workflow from table definition to mapping.
 * This test ensures all components work together correctly.
 */
describe('Tables + Mapper Integration', () => {
	describe('complete user mapping workflow', () => {
		// Define tables similar to production use case
		const Tables = Mapper.defineTables({
			User: {
				tableName: 'user',
				uuid: field('uuid').string(),
				fbUid: field('fb_uid').string(),
				displayName: field('display_name').string().optional(),
				email: field('email').string(),
				isOnboarded: field('is_onboarded').boolean().default(false),
				createdTimestamp: field('created_timestamp').date()
			},
			Account: {
				tableName: 'account',
				uuid: field('uuid').string(),
				displayName: field('display_name').string(),
				planType: field('plan_type').string().default('free')
			}
		});

		interface User {
			uuid: string;
			fbUid: string;
			displayName?: string;
			email: string;
			isOnboarded: boolean;
			createdTimestamp: Date;
		}

		interface UserWithAccount extends User {
			account: {
				uuid: string;
				displayName: string;
				planType: string;
			};
		}

		test('should access column names from table definition', () => {
			// Column name access for SQL query building
			expect(Tables.User.$name).toBe('user');
			expect(Tables.User.uuid).toBe('uuid');
			expect(Tables.User.fbUid).toBe('fb_uid');
			expect(Tables.User.displayName).toBe('display_name');
			expect(Tables.User.isOnboarded).toBe('is_onboarded');
			expect(Tables.User.createdTimestamp).toBe('created_timestamp');

			expect(Tables.Account.$name).toBe('account');
			expect(Tables.Account.displayName).toBe('display_name');
			expect(Tables.Account.planType).toBe('plan_type');
		});

		test('should map simple user row', () => {
			const UserMapper = Mapper.for<User>(Tables.User).build();

			const row = {
				uuid: 'user-123',
				fb_uid: 'firebase-abc',
				display_name: 'John Doe',
				email: 'john@example.com',
				is_onboarded: true,
				created_timestamp: '2024-01-15T10:30:00Z'
			};

			const user = UserMapper.map(row).value();

			expect(user).toEqual({
				uuid: 'user-123',
				fbUid: 'firebase-abc',
				displayName: 'John Doe',
				email: 'john@example.com',
				isOnboarded: true,
				createdTimestamp: new Date('2024-01-15T10:30:00Z')
			});
		});

		test('should apply defaults when values are null', () => {
			const UserMapper = Mapper.for<User>(Tables.User).build();

			const row = {
				uuid: 'user-123',
				fb_uid: 'firebase-abc',
				display_name: null, // optional
				email: 'john@example.com',
				is_onboarded: null, // has default
				created_timestamp: '2024-01-15T10:30:00Z'
			};

			const user = UserMapper.map(row).value();

			expect(user?.displayName).toBeUndefined();
			expect(user?.isOnboarded).toBe(false); // default applied
		});

		test('should map user with embedded account', () => {
			const UserWithAccountMapper = Mapper.for<UserWithAccount>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			const row = {
				uuid: 'user-123',
				fb_uid: 'firebase-abc',
				display_name: 'John Doe',
				email: 'john@example.com',
				is_onboarded: true,
				created_timestamp: '2024-01-15T10:30:00Z',
				account_uuid: 'acc-456',
				account_display_name: 'Acme Corp',
				account_plan_type: 'pro'
			};

			const user = UserWithAccountMapper.map(row).value();

			expect(user?.uuid).toBe('user-123');
			expect(user?.account.uuid).toBe('acc-456');
			expect(user?.account.displayName).toBe('Acme Corp');
			expect(user?.account.planType).toBe('pro');
		});

		test('should map multiple rows with mapMany', () => {
			const UserMapper = Mapper.for<User>(Tables.User).build();

			const rows = [
				{
					uuid: 'user-1',
					fb_uid: 'fb-1',
					email: 'user1@example.com',
					created_timestamp: '2024-01-01T00:00:00Z'
				},
				null, // should be filtered
				{
					uuid: 'user-2',
					fb_uid: 'fb-2',
					email: 'user2@example.com',
					created_timestamp: '2024-01-02T00:00:00Z'
				}
			];

			const users = UserMapper.mapMany(rows);

			expect(users).toHaveLength(2);
			expect(users[0]?.uuid).toBe('user-1');
			expect(users[1]?.uuid).toBe('user-2');
		});
	});

	describe('field type coverage', () => {
		test('should handle all field types in a single table', () => {
			const Tables = Mapper.defineTables({
				AllTypes: {
					tableName: 'all_types',
					stringField: field('string_field').string(),
					numberField: field('number_field').number(),
					booleanField: field('boolean_field').boolean(),
					dateField: field('date_field').date(),
					anyField: field('any_field').any<{ custom: boolean }>()
				}
			});

			interface AllTypes {
				stringField: string;
				numberField: number;
				booleanField: boolean;
				dateField: Date;
				anyField: { custom: boolean };
			}

			const mapper = Mapper.for<AllTypes>(Tables.AllTypes).build();

			const row = {
				string_field: 'hello',
				number_field: '42',
				boolean_field: 1,
				date_field: '2024-06-15T12:00:00Z',
				any_field: { custom: true }
			};

			const result = mapper.map(row).value();

			expect(result?.stringField).toBe('hello');
			expect(result?.numberField).toBe(42);
			expect(result?.booleanField).toBe(true);
			expect(result?.dateField).toBeInstanceOf(Date);
			expect(result?.anyField).toEqual({ custom: true });
		});
	});

	describe('error handling integration', () => {
		test('should throw descriptive error for missing required field', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					email: field('email').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string; email: string }>(Tables.User).build();

			expect(() => {
				UserMapper.map({
					uuid: 'user-123',
					email: null // required field is null
				});
			}).toThrow(/user.*email/i);
		});
	});

	describe('real-world patterns', () => {
		test('should support reusing table definitions across mappers', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					email: field('email').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					displayName: field('display_name').string()
				}
			});

			// Simple user mapper
			const UserMapper = Mapper.for<{ uuid: string; email: string }>(Tables.User).build();

			// User with account mapper
			const UserWithAccountMapper = Mapper.for<{
				uuid: string;
				email: string;
				account: { uuid: string; displayName: string };
			}>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			const simpleRow = { uuid: 'user-1', email: 'test@example.com' };
			const joinRow = {
				uuid: 'user-1',
				email: 'test@example.com',
				account_uuid: 'acc-1',
				account_display_name: 'Test Account'
			};

			const simpleUser = UserMapper.map(simpleRow).value();
			const userWithAccount = UserWithAccountMapper.map(joinRow).value();

			expect(simpleUser?.uuid).toBe('user-1');
			expect(userWithAccount?.account.uuid).toBe('acc-1');
		});
	});
});
