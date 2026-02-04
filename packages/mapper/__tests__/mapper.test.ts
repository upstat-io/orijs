import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper';
import { field } from '../src/field';
import { MapperError } from '../src/mapper-error';

describe('Mapper.for().build()', () => {
	describe('map() basic functionality', () => {
		test('should map a simple row to an object', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					email: field('email').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string; email: string }>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				email: 'test@example.com'
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				email: 'test@example.com'
			});
		});

		test('should map snake_case columns to camelCase properties', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					displayName: field('display_name').string(),
					createdTimestamp: field('created_timestamp').date()
				}
			});

			interface User {
				displayName: string;
				createdTimestamp: Date;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				display_name: 'John Doe',
				created_timestamp: '2024-01-01T00:00:00Z'
			}).value();

			expect(result).toEqual({
				displayName: 'John Doe',
				createdTimestamp: new Date('2024-01-01T00:00:00Z')
			});
		});

		test('should use column names from field builder', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					fbUid: field('fb_uid').string(),
					avatarUrl: field('avatar_url').string()
				}
			});

			interface User {
				fbUid: string;
				avatarUrl: string;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				fb_uid: 'firebase-123',
				avatar_url: 'https://example.com/avatar.png'
			}).value();

			expect(result).toEqual({
				fbUid: 'firebase-123',
				avatarUrl: 'https://example.com/avatar.png'
			});
		});
	});

	describe('null/undefined row handling', () => {
		test('should return undefined for null row', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string }>(Tables.User).build();

			expect(UserMapper.map(null).value()).toBeUndefined();
		});

		test('should return undefined for undefined row', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string }>(Tables.User).build();

			expect(UserMapper.map(undefined).value()).toBeUndefined();
		});
	});

	describe('optional fields', () => {
		test('should return undefined for missing optional field', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					displayName: field('display_name').string().optional()
				}
			});

			interface User {
				uuid: string;
				displayName?: string;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123'
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				displayName: undefined
			});
		});

		test('should return undefined for null optional field', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					displayName: field('display_name').string().optional()
				}
			});

			interface User {
				uuid: string;
				displayName?: string;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				display_name: null
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				displayName: undefined
			});
		});
	});

	describe('default values', () => {
		test('should apply default value for null field', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					isOnboarded: field('is_onboarded').boolean().default(false)
				}
			});

			interface User {
				uuid: string;
				isOnboarded: boolean;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				is_onboarded: null
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				isOnboarded: false
			});
		});

		test('should apply default value for undefined field', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					count: field('count').number().default(0)
				}
			});

			interface User {
				uuid: string;
				count: number;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123'
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				count: 0
			});
		});

		test('should use actual value when default exists but value is provided', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					isOnboarded: field('is_onboarded').boolean().default(false)
				}
			});

			interface User {
				uuid: string;
				isOnboarded: boolean;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				is_onboarded: true
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				isOnboarded: true
			});
		});
	});

	describe('default(null) behavior - SQL null safety', () => {
		test('should return null (not undefined) when field uses .default(null) and column is missing', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					quietHours: field('quiet_hours').any<{ start: string; end: string } | null>().default(null)
				}
			});

			interface User {
				uuid: string;
				quietHours: { start: string; end: string } | null;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123'
				// quiet_hours column is missing
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				quietHours: null // Must be null, NOT undefined - undefined throws in SQL
			});

			// Explicit check that it's null, not undefined
			expect(result!.quietHours).toBeNull();
			expect(result!.quietHours).not.toBeUndefined();
		});

		test('should return null when field uses .default(null) and column value is null', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					quietHours: field('quiet_hours').any<{ start: string; end: string } | null>().default(null)
				}
			});

			interface User {
				uuid: string;
				quietHours: { start: string; end: string } | null;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				quiet_hours: null
			}).value();

			expect(result!.quietHours).toBeNull();
		});

		test('should preserve actual value when .default(null) is set but value is provided', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					quietHours: field('quiet_hours').any<{ start: string; end: string } | null>().default(null)
				}
			});

			interface User {
				uuid: string;
				quietHours: { start: string; end: string } | null;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const quietHoursValue = { start: '22:00', end: '08:00' };
			const result = UserMapper.map({
				uuid: 'abc-123',
				quiet_hours: quietHoursValue
			}).value();

			expect(result!.quietHours).toEqual(quietHoursValue);
		});

		test('should return undefined (not null) when field uses .optional() without default', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					metadata: field('metadata').any().optional()
				}
			});

			interface User {
				uuid: string;
				metadata?: unknown;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123'
				// metadata column is missing
			}).value();

			expect(result!.metadata).toBeUndefined();
			expect(result!.metadata).not.toBeNull();
		});

		test('should distinguish between .optional() (returns undefined) and .default(null) (returns null)', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					optionalField: field('optional_field').any().optional(),
					nullDefaultField: field('null_default_field').any().default(null)
				}
			});

			interface User {
				uuid: string;
				optionalField?: unknown;
				nullDefaultField: unknown | null;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123'
				// Both columns missing
			}).value();

			// .optional() returns undefined
			expect(result!.optionalField).toBeUndefined();

			// .default(null) returns null
			expect(result!.nullDefaultField).toBeNull();
		});

		test('should work with .default(null) on boolean field', () => {
			const Tables = Mapper.defineTables({
				Settings: {
					tableName: 'settings',
					id: field('id').number(),
					isEnabled: field('is_enabled')
						.boolean()
						.default(null as unknown as boolean)
				}
			});

			interface Settings {
				id: number;
				isEnabled: boolean | null;
			}

			const SettingsMapper = Mapper.for<Settings>(Tables.Settings).build();

			const result = SettingsMapper.map({
				id: 1
				// is_enabled missing
			}).value();

			expect(result!.isEnabled).toBeNull();
		});

		test('should work with .default(null) on string field', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					nickname: field('nickname')
						.string()
						.default(null as unknown as string)
				}
			});

			interface User {
				uuid: string;
				nickname: string | null;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.map({
				uuid: 'abc-123'
			}).value();

			expect(result!.nickname).toBeNull();
		});
	});

	describe('type coercion', () => {
		test('should coerce string types', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string }>(Tables.User).build();

			const result = UserMapper.map({ uuid: 'abc-123' }).value();
			expect(result?.uuid).toBe('abc-123');
		});

		test('should coerce number types from string', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					age: field('age').number()
				}
			});

			const UserMapper = Mapper.for<{ age: number }>(Tables.User).build();

			const result = UserMapper.map({ age: '25' }).value();
			expect(result?.age).toBe(25);
		});

		test('should coerce number types from number', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					age: field('age').number()
				}
			});

			const UserMapper = Mapper.for<{ age: number }>(Tables.User).build();

			const result = UserMapper.map({ age: 30 }).value();
			expect(result?.age).toBe(30);
		});

		test('should coerce boolean types', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					isActive: field('is_active').boolean()
				}
			});

			const UserMapper = Mapper.for<{ isActive: boolean }>(Tables.User).build();

			expect(UserMapper.map({ is_active: true }).value()?.isActive).toBe(true);
			expect(UserMapper.map({ is_active: 1 }).value()?.isActive).toBe(true);
			expect(UserMapper.map({ is_active: 'yes' }).value()?.isActive).toBe(true);
			expect(UserMapper.map({ is_active: false }).value()?.isActive).toBe(false);
			expect(UserMapper.map({ is_active: 0 }).value()?.isActive).toBe(false);
			expect(UserMapper.map({ is_active: '' }).value()?.isActive).toBe(false);
		});

		test('should coerce date types from ISO string', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					createdAt: field('created_at').date()
				}
			});

			const UserMapper = Mapper.for<{ createdAt: Date }>(Tables.User).build();

			const result = UserMapper.map({ created_at: '2024-06-15T10:30:00Z' }).value();
			expect(result?.createdAt).toBeInstanceOf(Date);
			expect(result?.createdAt.toISOString()).toBe('2024-06-15T10:30:00.000Z');
		});

		test('should coerce date types from Date object', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					createdAt: field('created_at').date()
				}
			});

			const UserMapper = Mapper.for<{ createdAt: Date }>(Tables.User).build();

			const date = new Date('2024-06-15T10:30:00Z');
			const result = UserMapper.map({ created_at: date }).value();
			expect(result?.createdAt).toBeInstanceOf(Date);
			expect(result?.createdAt.getTime()).toBe(date.getTime());
		});

		test('should pass through field.any() values unchanged', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					metadata: field('metadata').any<{ tags: string[] }>()
				}
			});

			interface User {
				metadata: { tags: string[] };
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const metadata = { tags: ['admin', 'verified'] };
			const result = UserMapper.map({ metadata }).value();
			expect(result?.metadata).toEqual({ tags: ['admin', 'verified'] });
		});
	});

	describe('error handling', () => {
		test('should throw MapperError for missing required string field', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string }>(Tables.User).build();

			expect(() => UserMapper.map({ uuid: null }).value()).toThrow(MapperError);
		});

		test('should throw MapperError for missing required number field', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					age: field('age').number()
				}
			});

			const UserMapper = Mapper.for<{ age: number }>(Tables.User).build();

			expect(() => UserMapper.map({ age: null }).value()).toThrow(MapperError);
		});

		test('should throw MapperError for invalid number coercion', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					age: field('age').number()
				}
			});

			const UserMapper = Mapper.for<{ age: number }>(Tables.User).build();

			expect(() => UserMapper.map({ age: 'not-a-number' }).value()).toThrow(MapperError);
		});

		test('should throw MapperError for invalid date coercion', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					createdAt: field('created_at').date()
				}
			});

			const UserMapper = Mapper.for<{ createdAt: Date }>(Tables.User).build();

			expect(() => UserMapper.map({ created_at: 'invalid-date' }).value()).toThrow(MapperError);
		});
	});

	describe('mapMany()', () => {
		test('should map multiple rows to an array of objects', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					email: field('email').string()
				}
			});

			interface User {
				uuid: string;
				email: string;
			}

			const UserMapper = Mapper.for<User>(Tables.User).build();

			const result = UserMapper.mapMany([
				{ uuid: 'abc-1', email: 'user1@example.com' },
				{ uuid: 'abc-2', email: 'user2@example.com' },
				{ uuid: 'abc-3', email: 'user3@example.com' }
			]);

			expect(result).toEqual([
				{ uuid: 'abc-1', email: 'user1@example.com' },
				{ uuid: 'abc-2', email: 'user2@example.com' },
				{ uuid: 'abc-3', email: 'user3@example.com' }
			]);
		});

		test('should filter out null rows from mapMany results', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string }>(Tables.User).build();

			const result = UserMapper.mapMany([
				{ uuid: 'abc-1' },
				null,
				{ uuid: 'abc-2' },
				undefined,
				{ uuid: 'abc-3' }
			]);

			expect(result).toHaveLength(3);
			expect(result).toEqual([{ uuid: 'abc-1' }, { uuid: 'abc-2' }, { uuid: 'abc-3' }]);
		});

		test('should return empty array for empty input', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string }>(Tables.User).build();

			expect(UserMapper.mapMany([])).toEqual([]);
		});

		test('should return empty array for all null/undefined rows', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			const UserMapper = Mapper.for<{ uuid: string }>(Tables.User).build();

			const result = UserMapper.mapMany([null, undefined, null]);
			expect(result).toEqual([]);
		});
	});
});
