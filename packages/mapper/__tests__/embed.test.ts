import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper';
import { field } from '../src/field';

describe('.embed().prefix()', () => {
	describe('basic embedding', () => {
		test('should embed a related object from prefixed columns', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					displayName: field('display_name').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					displayName: field('display_name').string()
				}
			});

			interface User {
				uuid: string;
				displayName: string;
				account: { uuid: string; displayName: string };
			}

			const UserWithAccountMapper = Mapper.for<User>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			const result = UserWithAccountMapper.map({
				uuid: 'user-123',
				display_name: 'John Doe',
				account_uuid: 'acc-456',
				account_display_name: 'Acme Corp'
			}).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'John Doe',
				account: {
					uuid: 'acc-456',
					displayName: 'Acme Corp'
				}
			});
		});

		test('should handle multiple embeds', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					displayName: field('display_name').string()
				},
				Project: {
					tableName: 'project',
					uuid: field('uuid').string(),
					projectName: field('name').string()
				}
			});

			interface User {
				uuid: string;
				account: { uuid: string; displayName: string };
				project: { uuid: string; projectName: string };
			}

			const UserMapper = Mapper.for<User>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.embed('project', Tables.Project)
				.prefix('project_')
				.build();

			const result = UserMapper.map({
				uuid: 'user-123',
				account_uuid: 'acc-456',
				account_display_name: 'Acme Corp',
				project_uuid: 'proj-789',
				project_name: 'Main Project'
			}).value();

			expect(result).toEqual({
				uuid: 'user-123',
				account: {
					uuid: 'acc-456',
					displayName: 'Acme Corp'
				},
				project: {
					uuid: 'proj-789',
					projectName: 'Main Project'
				}
			});
		});
	});

	describe('missing embedded object', () => {
		test('should return undefined embed when no prefixed columns have values', () => {
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

			interface User {
				uuid: string;
				account?: { uuid: string; displayName: string };
			}

			const UserWithAccountMapper = Mapper.for<User>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			const result = UserWithAccountMapper.map({
				uuid: 'user-123'
				// No account_ prefixed columns
			}).value();

			expect(result?.uuid).toBe('user-123');
			expect(result?.account).toBeUndefined();
		});

		test('should return undefined embed when prefixed columns are all null', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					displayName: field('display_name').string().optional()
				}
			});

			interface User {
				uuid: string;
				account?: { uuid: string; displayName?: string };
			}

			const UserWithAccountMapper = Mapper.for<User>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			const result = UserWithAccountMapper.map({
				uuid: 'user-123',
				account_uuid: null,
				account_display_name: null
			}).value();

			expect(result?.uuid).toBe('user-123');
			expect(result?.account).toBeUndefined();
		});
	});

	describe('type coercion in embeds', () => {
		test('should coerce types in embedded objects', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					memberCount: field('member_count').number(),
					isActive: field('is_active').boolean(),
					createdAt: field('created_at').date()
				}
			});

			interface Account {
				uuid: string;
				memberCount: number;
				isActive: boolean;
				createdAt: Date;
			}

			interface User {
				uuid: string;
				account: Account;
			}

			const UserMapper = Mapper.for<User>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			const result = UserMapper.map({
				uuid: 'user-123',
				account_uuid: 'acc-456',
				account_member_count: '10',
				account_is_active: 1,
				account_created_at: '2024-01-01T00:00:00Z'
			}).value();

			expect(result?.account.memberCount).toBe(10);
			expect(result?.account.isActive).toBe(true);
			expect(result?.account.createdAt).toBeInstanceOf(Date);
			expect(result?.account.createdAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
		});
	});

	describe('optional fields in embeds', () => {
		test('should handle optional fields in embedded objects', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					description: field('description').string().optional()
				}
			});

			interface User {
				uuid: string;
				account: { uuid: string; description?: string };
			}

			const UserMapper = Mapper.for<User>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			const result = UserMapper.map({
				uuid: 'user-123',
				account_uuid: 'acc-456'
				// account_description is missing
			}).value();

			expect(result?.account.uuid).toBe('acc-456');
			expect(result?.account.description).toBeUndefined();
		});

		test('should apply defaults in embedded objects', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string(),
					isVerified: field('is_verified').boolean().default(false)
				}
			});

			interface User {
				uuid: string;
				account: { uuid: string; isVerified: boolean };
			}

			const UserMapper = Mapper.for<User>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			const result = UserMapper.map({
				uuid: 'user-123',
				account_uuid: 'acc-456',
				account_is_verified: null
			}).value();

			expect(result?.account.isVerified).toBe(false);
		});
	});

	describe('chaining after embed', () => {
		test('should continue fluent chain after prefix()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				},
				Account: {
					tableName: 'account',
					uuid: field('uuid').string()
				}
			});

			const mapper = Mapper.for<{ uuid: string; account: { uuid: string } }>(Tables.User)
				.embed('account', Tables.Account)
				.prefix('account_')
				.build();

			// Verify mapper actually works after chaining
			const result = mapper
				.map({
					uuid: 'user-123',
					account_uuid: 'acc-456'
				})
				.value();

			expect(result?.uuid).toBe('user-123');
			expect(result?.account?.uuid).toBe('acc-456');
		});
	});
});

describe('.embed() without prefix (nesting flat columns)', () => {
	describe('basic nesting', () => {
		test('should nest flat columns into structured object', () => {
			// Define a sub-table for the nested structure
			const UsageTable = Mapper.defineTable({
				tableName: 'usage',
				seats: field('seats_usage').number().default(0),
				monitors: field('monitors_usage').number().default(0)
			});

			const EntitlementTable = Mapper.defineTable({
				tableName: 'entitlement',
				accountId: field('account_id').number(),
				planName: field('plan_name').string()
			});

			interface Entitlement {
				accountId: number;
				planName: string;
				usage: { seats: number; monitors: number };
			}

			const mapper = Mapper.for<Entitlement>(EntitlementTable).embed('usage', UsageTable).build();

			const result = mapper
				.map({
					account_id: 123,
					plan_name: 'Pro',
					seats_usage: '5',
					monitors_usage: '10'
				})
				.value();

			expect(result).toEqual({
				accountId: 123,
				planName: 'Pro',
				usage: {
					seats: 5,
					monitors: 10
				}
			});
		});

		test('should handle multiple nested structures', () => {
			const UsageTable = Mapper.defineTable({
				tableName: 'usage',
				seats: field('seats_usage').number().default(0),
				monitors: field('monitors_usage').number().default(0)
			});

			const LimitsTable = Mapper.defineTable({
				tableName: 'limits',
				seats: field('seats_limit').number().default(0),
				monitors: field('monitors_limit').number().default(100)
			});

			const FeaturesTable = Mapper.defineTable({
				tableName: 'features',
				smsAlerts: field('sms_alerts_enabled').boolean().default(false),
				apiAccess: field('api_access_enabled').boolean().default(false)
			});

			const EntitlementTable = Mapper.defineTable({
				tableName: 'entitlement',
				accountId: field('account_id').number()
			});

			interface Entitlement {
				accountId: number;
				usage: { seats: number; monitors: number };
				limits: { seats: number; monitors: number };
				features: { smsAlerts: boolean; apiAccess: boolean };
			}

			const mapper = Mapper.for<Entitlement>(EntitlementTable)
				.embed('usage', UsageTable)
				.embed('limits', LimitsTable)
				.embed('features', FeaturesTable)
				.build();

			const result = mapper
				.map({
					account_id: 123,
					seats_usage: 5,
					monitors_usage: 10,
					seats_limit: 20,
					monitors_limit: 50,
					sms_alerts_enabled: true,
					api_access_enabled: false
				})
				.value();

			expect(result).toEqual({
				accountId: 123,
				usage: { seats: 5, monitors: 10 },
				limits: { seats: 20, monitors: 50 },
				features: { smsAlerts: true, apiAccess: false }
			});
		});
	});

	describe('defaults and coercion', () => {
		test('should apply defaults in nested structure', () => {
			const UsageTable = Mapper.defineTable({
				tableName: 'usage',
				seats: field('seats_usage').number().default(0),
				monitors: field('monitors_usage').number().default(0)
			});

			const EntitlementTable = Mapper.defineTable({
				tableName: 'entitlement',
				accountId: field('account_id').number()
			});

			interface Entitlement {
				accountId: number;
				usage: { seats: number; monitors: number };
			}

			const mapper = Mapper.for<Entitlement>(EntitlementTable).embed('usage', UsageTable).build();

			const result = mapper
				.map({
					account_id: 123
					// seats_usage and monitors_usage are missing
				})
				.value();

			expect(result).toEqual({
				accountId: 123,
				usage: { seats: 0, monitors: 0 }
			});
		});

		test('should coerce types in nested structure', () => {
			const StatsTable = Mapper.defineTable({
				tableName: 'stats',
				count: field('stat_count').number(),
				isActive: field('stat_is_active').boolean(),
				createdAt: field('stat_created_at').date()
			});

			const BaseTable = Mapper.defineTable({
				tableName: 'base',
				id: field('id').number()
			});

			interface Data {
				id: number;
				stats: { count: number; isActive: boolean; createdAt: Date };
			}

			const mapper = Mapper.for<Data>(BaseTable).embed('stats', StatsTable).build();

			const result = mapper
				.map({
					id: 1,
					stat_count: '42',
					stat_is_active: 1,
					stat_created_at: '2024-01-01T00:00:00Z'
				})
				.value();

			expect(result?.stats.count).toBe(42);
			expect(result?.stats.isActive).toBe(true);
			expect(result?.stats.createdAt).toBeInstanceOf(Date);
		});
	});

	describe('chaining', () => {
		test('should chain embed() calls without prefix()', () => {
			const Table1 = Mapper.defineTable({
				tableName: 't1',
				a: field('col_a').number()
			});

			const Table2 = Mapper.defineTable({
				tableName: 't2',
				b: field('col_b').number()
			});

			const BaseTable = Mapper.defineTable({
				tableName: 'base',
				id: field('id').number()
			});

			interface Result {
				id: number;
				nested1: { a: number };
				nested2: { b: number };
			}

			const mapper = Mapper.for<Result>(BaseTable).embed('nested1', Table1).embed('nested2', Table2).build();

			const result = mapper
				.map({
					id: 1,
					col_a: 10,
					col_b: 20
				})
				.value();

			expect(result).toEqual({
				id: 1,
				nested1: { a: 10 },
				nested2: { b: 20 }
			});
		});

		test('should mix embed with prefix and embed without prefix', () => {
			const JoinedUserTable = Mapper.defineTable({
				tableName: 'user',
				uuid: field('uuid').string(),
				displayName: field('display_name').string()
			});

			const UsageTable = Mapper.defineTable({
				tableName: 'usage',
				seats: field('seats_usage').number()
			});

			const BaseTable = Mapper.defineTable({
				tableName: 'base',
				id: field('id').number()
			});

			interface Result {
				id: number;
				createdBy: { uuid: string; displayName: string };
				usage: { seats: number };
			}

			const mapper = Mapper.for<Result>(BaseTable)
				.embed('createdBy', JoinedUserTable)
				.prefix('created_by_')
				.embed('usage', UsageTable)
				.build();

			const result = mapper
				.map({
					id: 1,
					created_by_uuid: 'user-123',
					created_by_display_name: 'John',
					seats_usage: 5
				})
				.value();

			expect(result).toEqual({
				id: 1,
				createdBy: { uuid: 'user-123', displayName: 'John' },
				usage: { seats: 5 }
			});
		});
	});
});
