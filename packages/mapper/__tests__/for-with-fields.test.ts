/**
 * Tests for Mapper.for() with optional field selection
 *
 * When you want to map only a subset of fields from the primary table,
 * pass the field names as additional arguments to Mapper.for().
 */
import { describe, it, expect } from 'bun:test';
import { Mapper, field } from '../src';

describe('Mapper.for() with field selection', () => {
	const UserTable = Mapper.defineTable({
		tableName: 'user',
		id: field('id').number(),
		uuid: field('uuid').string(),
		fbAuthUid: field('fb_uid').string(),
		email: field('email').string().optional(),
		displayName: field('display_name').string().optional(),
		firstName: field('first_name').string().optional(),
		lastName: field('last_name').string().optional(),
		avatarUrl: field('avatar_url').string().optional(),
		jobTitle: field('job_title').string().optional(),
		timezone: field('timezone').string().optional(),
		isOnboarded: field('is_onboarded').boolean().default(false),
		createdAt: field('created_at').date()
	});

	describe('basic field selection', () => {
		it('should only map specified fields when fields are provided', () => {
			interface BasicUser {
				uuid: string;
				fbAuthUid: string;
				displayName?: string;
				email?: string;
			}

			const mapper = Mapper.for<BasicUser>(UserTable, 'uuid', 'fbAuthUid', 'displayName', 'email').build();

			const row = {
				id: 123,
				uuid: 'user-123',
				fb_uid: 'fb-456',
				email: 'test@example.com',
				display_name: 'John Doe',
				first_name: 'John',
				last_name: 'Doe',
				avatar_url: 'https://example.com/avatar.png',
				job_title: 'Engineer',
				timezone: 'America/New_York',
				is_onboarded: true,
				created_at: '2024-01-01T00:00:00Z'
			};

			const result = mapper.map(row).value();

			// Should have the selected fields
			expect(result?.uuid).toBe('user-123');
			expect(result?.fbAuthUid).toBe('fb-456');
			expect(result?.displayName).toBe('John Doe');
			expect(result?.email).toBe('test@example.com');

			// Should NOT have fields that weren't selected
			expect((result as any).id).toBeUndefined();
			expect((result as any).firstName).toBeUndefined();
			expect((result as any).lastName).toBeUndefined();
			expect((result as any).avatarUrl).toBeUndefined();
			expect((result as any).jobTitle).toBeUndefined();
			expect((result as any).timezone).toBeUndefined();
			expect((result as any).isOnboarded).toBeUndefined();
			expect((result as any).createdAt).toBeUndefined();
		});

		it('should map all fields when no fields are specified', () => {
			interface FullUser {
				id: number;
				uuid: string;
				fbAuthUid: string;
				email?: string;
				displayName?: string;
				isOnboarded: boolean;
			}

			// No field selection - maps all fields
			const mapper = Mapper.for<FullUser>(UserTable).build();

			const row = {
				id: 123,
				uuid: 'user-123',
				fb_uid: 'fb-456',
				email: 'test@example.com',
				display_name: 'John Doe',
				is_onboarded: true,
				created_at: '2024-01-01T00:00:00Z'
			};

			const result = mapper.map(row).value();

			expect(result?.id).toBe(123);
			expect(result?.uuid).toBe('user-123');
			expect(result?.fbAuthUid).toBe('fb-456');
			expect(result?.email).toBe('test@example.com');
			expect(result?.displayName).toBe('John Doe');
			expect(result?.isOnboarded).toBe(true);
			// Note: createdAt is also mapped since no field selection, but FullUser interface doesn't include it
		});
	});

	describe('field selection with optional fields', () => {
		it('should handle optional fields correctly in selection', () => {
			interface BasicUser {
				uuid: string;
				displayName?: string;
				email?: string;
			}

			const mapper = Mapper.for<BasicUser>(UserTable, 'uuid', 'displayName', 'email').build();

			const row = {
				uuid: 'user-123'
				// display_name and email are missing
			};

			const result = mapper.map(row).value();

			expect(result?.uuid).toBe('user-123');
			expect(result?.displayName).toBeUndefined();
			expect(result?.email).toBeUndefined();
		});

		it('should apply defaults for selected fields with defaults', () => {
			interface UserWithOnboarded {
				uuid: string;
				isOnboarded: boolean;
			}

			const mapper = Mapper.for<UserWithOnboarded>(UserTable, 'uuid', 'isOnboarded').build();

			const row = {
				uuid: 'user-123'
				// is_onboarded is missing, should use default
			};

			const result = mapper.map(row).value();

			expect(result?.uuid).toBe('user-123');
			expect(result?.isOnboarded).toBe(false); // default value
		});
	});

	describe('field selection with chaining', () => {
		it('should work with .col() for additional columns', () => {
			interface UserWithCount {
				uuid: string;
				displayName?: string;
				activeIncidentCount: number;
			}

			const mapper = Mapper.for<UserWithCount>(UserTable, 'uuid', 'displayName')
				.col<number>('activeIncidentCount')
				.default(0) // Infers 'active_incident_count'
				.build();

			const row = {
				uuid: 'user-123',
				display_name: 'John Doe',
				active_incident_count: 5
			};

			const result = mapper.map(row).value();

			expect(result?.uuid).toBe('user-123');
			expect(result?.displayName).toBe('John Doe');
			expect(result?.activeIncidentCount).toBe(5);
			expect((result as any).id).toBeUndefined();
		});

		it('should work with .json() for JSON columns', () => {
			interface UserWithTeams {
				uuid: string;
				teams: string[];
			}

			const mapper = Mapper.for<UserWithTeams>(UserTable, 'uuid').json<string[]>('teams').default([]).build();

			const row = {
				uuid: 'user-123',
				teams: ['team-1', 'team-2']
			};

			const result = mapper.map(row).value();

			expect(result?.uuid).toBe('user-123');
			expect(result?.teams).toEqual(['team-1', 'team-2']);
		});

		it('should work with .pick() from other tables', () => {
			const AccountTable = Mapper.defineTable({
				tableName: 'account',
				accountId: field('id').number(),
				accountUuid: field('uuid').string(),
				accountName: field('display_name').string().optional()
			});

			interface UserWithAccount {
				uuid: string;
				displayName?: string;
				accountId: number;
				accountUuid: string;
			}

			const mapper = Mapper.for<UserWithAccount>(UserTable, 'uuid', 'displayName')
				.pick(AccountTable, 'accountId', 'accountUuid')
				.prefix('account_')
				.build();

			const row = {
				uuid: 'user-123',
				display_name: 'John Doe',
				account_id: 456,
				account_uuid: 'acc-789'
			};

			const result = mapper.map(row).value();

			expect(result?.uuid).toBe('user-123');
			expect(result?.displayName).toBe('John Doe');
			expect(result?.accountId).toBe(456);
			expect(result?.accountUuid).toBe('acc-789');
			expect((result as any).id).toBeUndefined();
		});
	});

	describe('mapMany with field selection', () => {
		it('should work with mapMany', () => {
			interface BasicUser {
				uuid: string;
				displayName?: string;
			}

			const mapper = Mapper.for<BasicUser>(UserTable, 'uuid', 'displayName').build();

			const rows = [
				{ uuid: 'user-1', display_name: 'User One', id: 1 },
				{ uuid: 'user-2', display_name: 'User Two', id: 2 }
			];

			const results = mapper.mapMany(rows);

			expect(results).toHaveLength(2);
			expect(results[0]!.uuid).toBe('user-1');
			expect(results[0]!.displayName).toBe('User One');
			expect((results[0] as any).id).toBeUndefined();
			expect(results[1]!.uuid).toBe('user-2');
			expect(results[1]!.displayName).toBe('User Two');
		});
	});

	describe('edge cases', () => {
		it('should handle selecting a single field', () => {
			interface UuidOnly {
				uuid: string;
			}

			const mapper = Mapper.for<UuidOnly>(UserTable, 'uuid').build();

			const row = {
				id: 123,
				uuid: 'user-123',
				fb_uid: 'fb-456'
			};

			const result = mapper.map(row).value();

			expect(result?.uuid).toBe('user-123');
			expect((result as any).id).toBeUndefined();
			expect((result as any).fbAuthUid).toBeUndefined();
		});

		it('should ignore unknown field names in selection', () => {
			interface BasicUser {
				uuid: string;
			}

			// 'nonExistent' is not in the table - should be silently ignored
			const mapper = Mapper.for<BasicUser>(UserTable, 'uuid', 'nonExistent' as any).build();

			const row = {
				uuid: 'user-123'
			};

			const result = mapper.map(row).value();

			expect(result?.uuid).toBe('user-123');
		});
	});
});
