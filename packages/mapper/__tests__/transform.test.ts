import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper';
import { field } from '../src/field';

describe('Mapper.transform()', () => {
	describe('basic transformation', () => {
		test('should transform a field value after coercion', () => {
			const Tables = Mapper.defineTables({
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					logoUrl: field('logo_url').string().optional()
				}
			});

			interface Account {
				uuid: string;
				logoUrl?: string;
			}

			const AccountMapper = Mapper.for<Account>(Tables.Account)
				.transform('logoUrl', (v) => v || undefined)
				.build();

			const result = AccountMapper.map({
				uuid: 'abc-123',
				logo_url: null
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				logoUrl: undefined
			});
		});

		test('should apply transform to actual value when present', () => {
			const Tables = Mapper.defineTables({
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					name: field('name').string()
				}
			});

			interface Account {
				uuid: string;
				name: string;
			}

			const AccountMapper = Mapper.for<Account>(Tables.Account)
				.transform('name', (v) => v.toUpperCase())
				.build();

			const result = AccountMapper.map({
				uuid: 'abc-123',
				name: 'Acme Corp'
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'ACME CORP'
			});
		});

		test('should run transform after type coercion', () => {
			const Tables = Mapper.defineTables({
				Event: {
					tableName: 'event',
					uuid: field('uuid').string(),
					scheduledAt: field('scheduled_at').date()
				}
			});

			interface Event {
				uuid: string;
				scheduledAt: Date;
			}

			// Transform receives Date (coerced), not string (raw)
			const EventMapper = Mapper.for<Event>(Tables.Event)
				.transform('scheduledAt', (v) => {
					// v is already a Date after coercion
					expect(v).toBeInstanceOf(Date);
					return v;
				})
				.build();

			const result = EventMapper.map({
				uuid: 'abc-123',
				scheduled_at: '2024-01-15T10:30:00Z'
			}).value();

			expect(result?.scheduledAt).toBeInstanceOf(Date);
		});
	});

	describe('multiple transforms', () => {
		test('should apply multiple transforms to different fields', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					email: field('email').string(),
					displayName: field('display_name').string().optional()
				}
			});

			interface User {
				uuid: string;
				email: string;
				displayName?: string;
			}

			const UserMapper = Mapper.for<User>(Tables.User)
				.transform('email', (v) => v.toLowerCase())
				.transform('displayName', (v) => v?.trim() || undefined)
				.build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				email: 'USER@EXAMPLE.COM',
				display_name: '  John Doe  '
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				email: 'user@example.com',
				displayName: 'John Doe'
			});
		});

		test('should apply multiple transforms to the same field in order', () => {
			const Tables = Mapper.defineTables({
				Item: {
					tableName: 'item',
					name: field('name').string()
				}
			});

			interface Item {
				name: string;
			}

			const ItemMapper = Mapper.for<Item>(Tables.Item)
				.transform('name', (v) => v.trim())
				.transform('name', (v) => v.toUpperCase())
				.build();

			const result = ItemMapper.map({
				name: '  hello world  '
			}).value();

			expect(result).toEqual({
				name: 'HELLO WORLD'
			});
		});
	});

	describe('transform with other builder methods', () => {
		test('should work with .omit()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					uuid: field('uuid').string(),
					email: field('email').string()
				}
			});

			interface UserWithoutId {
				uuid: string;
				email: string;
			}

			const UserMapper = Mapper.for<UserWithoutId>(Tables.User)
				.omit('id')
				.transform('email', (v) => v.toLowerCase())
				.build();

			const result = UserMapper.map({
				id: 1,
				uuid: 'abc-123',
				email: 'USER@EXAMPLE.COM'
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				email: 'user@example.com'
			});
			expect((result as unknown as Record<string, unknown>).id).toBeUndefined();
		});

		test('should work with .field().as()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string()
				}
			});

			interface UserWithUserId {
				userId: number;
				email: string;
			}

			const UserMapper = Mapper.for<UserWithUserId>(Tables.User)
				.field('id')
				.as('userId')
				.transform('email', (v) => v.toLowerCase())
				.build();

			const result = UserMapper.map({
				id: 42,
				email: 'USER@EXAMPLE.COM'
			}).value();

			expect(result).toEqual({
				userId: 42,
				email: 'user@example.com'
			});
		});

		test('should work with .col()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			interface UserWithCount {
				uuid: string;
				activeIncidentCount: number;
			}

			const UserMapper = Mapper.for<UserWithCount>(Tables.User)
				.col<number>('activeIncidentCount') // Infers 'active_incident_count'
				.default(0)
				.transform('activeIncidentCount', (v) => Math.max(0, v))
				.build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				active_incident_count: -5
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				activeIncidentCount: 0
			});
		});

		test('should work with .json()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			interface UserWithRoles {
				uuid: string;
				roles: string[];
			}

			const UserMapper = Mapper.for<UserWithRoles>(Tables.User)
				.json<string[]>('roles')
				.default([])
				.transform('roles', (v) => v.map((r) => r.toUpperCase()))
				.build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				roles: ['admin', 'editor']
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				roles: ['ADMIN', 'EDITOR']
			});
		});
	});

	describe('transform chaining from other builders', () => {
		test('should allow .transform() after .json().default()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			interface UserWithTags {
				uuid: string;
				tags: string[];
			}

			const UserMapper = Mapper.for<UserWithTags>(Tables.User)
				.json<string[]>('tags')
				.default([])
				.transform('tags', (v) => v.filter((t) => t.length > 0))
				.build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				tags: ['', 'valid', '', 'tag']
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				tags: ['valid', 'tag']
			});
		});

		test('should allow .transform() after .col().default()', () => {
			const Tables = Mapper.defineTables({
				Item: {
					tableName: 'item',
					uuid: field('uuid').string()
				}
			});

			interface ItemWithScore {
				uuid: string;
				score: number;
			}

			const ItemMapper = Mapper.for<ItemWithScore>(Tables.Item)
				.col<number>('score') // Column name = property name when no camelCase
				.default(0)
				.transform('score', (v) => Math.round(v * 100) / 100)
				.build();

			const result = ItemMapper.map({
				uuid: 'abc-123',
				score: 3.14159
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				score: 3.14
			});
		});
	});

	describe('mapMany with transform', () => {
		test('should apply transform to all rows in mapMany', () => {
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

			const UserMapper = Mapper.for<User>(Tables.User)
				.transform('email', (v) => v.toLowerCase())
				.build();

			const result = UserMapper.mapMany([
				{ uuid: 'abc-1', email: 'USER1@EXAMPLE.COM' },
				{ uuid: 'abc-2', email: 'USER2@EXAMPLE.COM' }
			]);

			expect(result).toEqual([
				{ uuid: 'abc-1', email: 'user1@example.com' },
				{ uuid: 'abc-2', email: 'user2@example.com' }
			]);
		});
	});

	describe('transform with prefix', () => {
		test('should apply transform when using dynamic prefix', () => {
			const Tables = Mapper.defineTables({
				Step: {
					tableName: 'step',
					id: field('id').number(),
					title: field('title').string()
				}
			});

			interface Step {
				id: number;
				title: string;
			}

			const StepMapper = Mapper.for<Step>(Tables.Step)
				.transform('title', (v) => v.trim())
				.build();

			const result = StepMapper.map(
				{
					step_id: 1,
					step_title: '  Step One  '
				},
				{ prefix: 'step_' }
			).value();

			expect(result).toEqual({
				id: 1,
				title: 'Step One'
			});
		});
	});

	describe('transform edge cases', () => {
		test('should skip transform for property not in result', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			interface User {
				uuid: string;
				missingProp?: string;
			}

			// Transform for a property that doesn't exist should be a no-op
			const UserMapper = Mapper.for<User>(Tables.User)
				.transform('missingProp', (_v) => {
					throw new Error('Should not be called');
				})
				.build();

			const result = UserMapper.map({
				uuid: 'abc-123'
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123'
			});
		});

		test('should handle null return from transform', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					name: field('name').string().optional()
				}
			});

			interface User {
				uuid: string;
				name: string | null;
			}

			const UserMapper = Mapper.for<User>(Tables.User)
				.transform('name', () => null as unknown as string)
				.build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				name: 'John'
			}).value();

			expect(result?.name).toBeNull();
		});
	});
});
