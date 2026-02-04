import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper.ts';
import { field } from '../src/field.ts';

/**
 * Tests for MapperBuilder fluent API methods.
 * Uses Mapper.for() which returns a MapperBuilder internally.
 */
describe('MapperBuilder', () => {
	describe('build()', () => {
		test('should create mapper from table definition', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string()
				}
			});

			const mapper = Mapper.for<{ id: number; email: string }>(Tables.User).build();

			expect(mapper).toBeDefined();
			expect(typeof mapper.map).toBe('function');
			expect(typeof mapper.mapMany).toBe('function');
		});

		test('should return frozen config from build()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			const mapper = Mapper.for<{ id: number }>(Tables.User).build();

			// Mapper should work after build
			const result = mapper.map({ id: 123 }).value();
			expect(result?.id).toBe(123);
		});
	});

	describe('omit()', () => {
		test('should omit single field from mapping', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string(),
					isActive: field('is_active').boolean()
				}
			});

			const mapper = Mapper.for<{ id: number; email: string }>(Tables.User).omit('isActive').build();

			const result = mapper
				.map({
					id: 1,
					email: 'test@example.com',
					is_active: true
				})
				.value();

			expect(result).toBeDefined();
			expect(result!.id).toBe(1);
			expect(result!.email).toBe('test@example.com');
			expect('isActive' in result!).toBe(false);
		});

		test('should omit multiple fields', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string(),
					isActive: field('is_active').boolean(),
					createdAt: field('created_at').date()
				}
			});

			const mapper = Mapper.for<{ id: number; email: string }>(Tables.User)
				.omit('isActive', 'createdAt')
				.build();

			const result = mapper
				.map({
					id: 1,
					email: 'test@example.com',
					is_active: true,
					created_at: new Date()
				})
				.value();

			expect('isActive' in result!).toBe(false);
			expect('createdAt' in result!).toBe(false);
		});

		test('should chain omit calls', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string(),
					isActive: field('is_active').boolean(),
					createdAt: field('created_at').date()
				}
			});

			const mapper = Mapper.for<{ id: number; email: string }>(Tables.User)
				.omit('isActive')
				.omit('createdAt')
				.build();

			const result = mapper
				.map({
					id: 1,
					email: 'test@example.com',
					is_active: true,
					created_at: new Date()
				})
				.value();

			expect('isActive' in result!).toBe(false);
			expect('createdAt' in result!).toBe(false);
		});
	});

	describe('pick()', () => {
		test('should pick fields from another table', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string()
				},
				Project: {
					tableName: 'project',
					name: field('name').string()
				}
			});

			interface UserWithProject {
				id: number;
				email: string;
				name: string;
			}

			const mapper = Mapper.for<UserWithProject>(Tables.User).pick(Tables.Project, 'name').build();

			const result = mapper
				.map({
					id: 1,
					email: 'test@example.com',
					name: 'Project A'
				})
				.value();

			expect(result).toBeDefined();
			expect(result!.name).toBe('Project A');
		});

		test('should pick fields with prefix', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				},
				Project: {
					tableName: 'project',
					name: field('name').string()
				}
			});

			interface UserWithProject {
				id: number;
				name: string;
			}

			const mapper = Mapper.for<UserWithProject>(Tables.User)
				.pick(Tables.Project, 'name')
				.prefix('project_')
				.build();

			const result = mapper
				.map({
					id: 1,
					project_name: 'Project B'
				})
				.value();

			expect(result!.name).toBe('Project B');
		});
	});

	describe('json()', () => {
		test('should map JSON column', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithSettings {
				id: number;
				settings: { theme: string };
			}

			const mapper = Mapper.for<UserWithSettings>(Tables.User).json<{ theme: string }>('settings').build();

			const result = mapper
				.map({
					id: 1,
					settings: { theme: 'dark' }
				})
				.value();

			expect(result!.settings).toEqual({ theme: 'dark' });
		});

		test('should map JSON column with factory function', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithTags {
				id: number;
				tags: string[];
			}

			const mapper = Mapper.for<UserWithTags>(Tables.User)
				.json<string[]>('tags', (raw) => (Array.isArray(raw) ? raw : []))
				.build();

			const result = mapper
				.map({
					id: 1,
					tags: ['a', 'b', 'c']
				})
				.value();

			expect(result!.tags).toEqual(['a', 'b', 'c']);
		});

		test('should map JSON column with default value', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithSettings {
				id: number;
				settings: { theme: string };
			}

			const mapper = Mapper.for<UserWithSettings>(Tables.User)
				.json<{ theme: string }>('settings')
				.default({ theme: 'light' })
				.build();

			const result = mapper
				.map({
					id: 1,
					settings: null
				})
				.value();

			expect(result!.settings).toEqual({ theme: 'light' });
		});

		test('should map JSON column as optional', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithSettings {
				id: number;
				settings?: { theme: string };
			}

			const mapper = Mapper.for<UserWithSettings>(Tables.User)
				.json<{ theme: string }>('settings')
				.optional()
				.build();

			const result = mapper
				.map({
					id: 1,
					settings: null
				})
				.value();

			expect(result!.settings).toBeUndefined();
		});

		test('should rename JSON column with as()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithData {
				id: number;
				userData: { theme: string };
			}

			const mapper = Mapper.for<UserWithData>(Tables.User)
				.json<{ theme: string }>('settings')
				.as('userData')
				.default({ theme: 'default' })
				.build();

			const result = mapper
				.map({
					id: 1,
					settings: { theme: 'custom' }
				})
				.value();

			expect(result!.userData).toEqual({ theme: 'custom' });
		});
	});

	describe('col()', () => {
		test('should map extra column', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithCount {
				id: number;
				postCount: number;
			}

			const mapper = Mapper.for<UserWithCount>(Tables.User).col<number>('postCount', 'post_count').build();

			const result = mapper
				.map({
					id: 1,
					post_count: 42
				})
				.value();

			expect(result!.postCount).toBe(42);
		});

		test('should use snake_case column name by default', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithCount {
				id: number;
				postCount: number;
			}

			const mapper = Mapper.for<UserWithCount>(Tables.User).col<number>('postCount').build();

			const result = mapper
				.map({
					id: 1,
					post_count: 99
				})
				.value();

			expect(result!.postCount).toBe(99);
		});

		test('should map computed column', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithFullName {
				id: number;
				fullName: string;
			}

			const mapper = Mapper.for<UserWithFullName>(Tables.User)
				.col<string>('fullName', (row) => `${row.first_name} ${row.last_name}`)
				.build();

			const result = mapper
				.map({
					id: 1,
					first_name: 'John',
					last_name: 'Doe'
				})
				.value();

			expect(result!.fullName).toBe('John Doe');
		});

		test('should map col with default value', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithCount {
				id: number;
				postCount: number;
			}

			const mapper = Mapper.for<UserWithCount>(Tables.User).col<number>('postCount').default(0).build();

			const result = mapper
				.map({
					id: 1,
					post_count: null
				})
				.value();

			expect(result!.postCount).toBe(0);
		});

		test('should map col as optional', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			interface UserWithCount {
				id: number;
				postCount?: number;
			}

			const mapper = Mapper.for<UserWithCount>(Tables.User).col<number>('postCount').optional().build();

			const result = mapper
				.map({
					id: 1,
					post_count: null
				})
				.value();

			expect(result!.postCount).toBeUndefined();
		});
	});

	describe('embed()', () => {
		test('should embed related object', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				},
				Project: {
					tableName: 'project',
					id: field('id').number(),
					name: field('name').string(),
					slug: field('slug').string()
				}
			});

			interface UserWithProject {
				id: number;
				project: { id: number; name: string; slug: string };
			}

			const mapper = Mapper.for<UserWithProject>(Tables.User)
				.embed('project', Tables.Project)
				.prefix('p_')
				.build();

			const result = mapper
				.map({
					id: 1,
					p_id: 10,
					p_name: 'My Project',
					p_slug: 'my-project'
				})
				.value();

			expect(result!.project).toEqual({ id: 10, name: 'My Project', slug: 'my-project' });
		});

		test('should return undefined for embedded object when all prefixed columns are null', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				},
				Project: {
					tableName: 'project',
					id: field('id').number(),
					name: field('name').string()
				}
			});

			interface UserWithProject {
				id: number;
				project?: { id: number; name: string };
			}

			const mapper = Mapper.for<UserWithProject>(Tables.User)
				.embed('project', Tables.Project)
				.prefix('p_')
				.build();

			const result = mapper
				.map({
					id: 1,
					p_id: null,
					p_name: null
				})
				.value();

			expect(result!.project).toBeUndefined();
		});
	});

	describe('field()', () => {
		test('should rename field with as()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string()
				}
			});

			interface UserRenamed {
				id: number;
				userEmail: string;
			}

			const mapper = Mapper.for<UserRenamed>(Tables.User).field('email').as('userEmail').build();

			const result = mapper
				.map({
					id: 1,
					email: 'test@example.com'
				})
				.value();

			expect(result!.userEmail).toBe('test@example.com');
			expect('email' in result!).toBe(false);
		});
	});

	describe('transform()', () => {
		test('should transform field value', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string()
				}
			});

			interface User {
				id: number;
				email: string;
			}

			const mapper = Mapper.for<User>(Tables.User)
				.transform('email', (email) => email.toLowerCase())
				.build();

			const result = mapper
				.map({
					id: 1,
					email: 'TEST@EXAMPLE.COM'
				})
				.value();

			expect(result!.email).toBe('test@example.com');
		});
	});

	describe('fluent chaining', () => {
		test('should support complex chained configuration', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					uuid: field('uuid').string(),
					email: field('email').string()
				},
				Project: {
					tableName: 'project',
					name: field('name').string()
				}
			});

			interface ComplexUser {
				id: number;
				email: string;
				name: string;
				settings: { theme: string };
				postCount: number;
			}

			const mapper = Mapper.for<ComplexUser>(Tables.User)
				.omit('uuid')
				.pick(Tables.Project, 'name')
				.prefix('project_')
				.json<{ theme: string }>('settings')
				.default({ theme: 'light' })
				.col<number>('postCount')
				.default(0)
				.transform('email', (email) => email.toLowerCase())
				.build();

			const result = mapper
				.map({
					id: 1,
					uuid: 'abc',
					email: 'TEST@EXAMPLE.COM',
					project_name: 'Project X',
					settings: null,
					post_count: null
				})
				.value();

			expect(result!.id).toBe(1);
			expect('uuid' in result!).toBe(false);
			expect(result!.email).toBe('test@example.com');
			expect(result!.name).toBe('Project X');
			expect(result!.settings).toEqual({ theme: 'light' });
			expect(result!.postCount).toBe(0);
		});
	});

	describe('mapMany()', () => {
		test('should map array of rows', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string()
				}
			});

			const mapper = Mapper.for<{ id: number; email: string }>(Tables.User).build();

			const rows = [
				{ id: 1, email: 'a@test.com' },
				{ id: 2, email: 'b@test.com' }
			];

			const results = mapper.mapMany(rows);

			expect(results.length).toBe(2);
			expect(results[0]!.id).toBe(1);
			expect(results[1]!.id).toBe(2);
		});

		test('should filter out undefined results', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string()
				}
			});

			const mapper = Mapper.for<{ id: number; email: string }>(Tables.User).build();

			const rows = [{ id: 1, email: 'a@test.com' }, null, undefined, { id: 2, email: 'b@test.com' }];

			const results = mapper.mapMany(rows as unknown[]);

			expect(results.length).toBe(2);
		});
	});

	describe('duplicate property validation', () => {
		test('should throw error when col() maps same property twice', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			expect(() => {
				Mapper.for<{ id: number; bio: string }>(Tables.User)
					.col<string>('bio', 'user_bio')
					.col<string>('bio', 'profile_bio') // Duplicate!
					.build();
			}).toThrow("Property 'bio' is already mapped");
		});

		test('should throw error when json() maps same property twice', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			expect(() => {
				Mapper.for<{ id: number; settings: object }>(Tables.User)
					.json('settings_a')
					.as('settings')
					.default({})
					.json('settings_b')
					.as('settings') // Duplicate!
					.default({})
					.build();
			}).toThrow("Property 'settings' is already mapped");
		});

		test('should throw error when pick() and col() map same property', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				},
				Profile: {
					tableName: 'profile',
					bio: field('bio').string()
				}
			});

			expect(() => {
				Mapper.for<{ id: number; bio: string }>(Tables.User)
					.pick(Tables.Profile, 'bio')
					.col<string>('bio', 'user_bio') // Duplicate!
					.build();
			}).toThrow("Property 'bio' is already mapped");
		});

		test('should throw error when embed() maps same property twice', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				},
				Project: {
					tableName: 'project',
					id: field('id').number(),
					name: field('name').string()
				}
			});

			expect(() => {
				Mapper.for<{ id: number; project: object }>(Tables.User)
					.embed('project', Tables.Project)
					.prefix('p1_')
					.embed('project', Tables.Project) // Duplicate!
					.prefix('p2_')
					.build();
			}).toThrow("Property 'project' is already mapped");
		});

		test('should throw error when field().as() maps same property twice', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number(),
					email: field('email').string(),
					phone: field('phone').string()
				}
			});

			expect(() => {
				Mapper.for<{ id: number; contact: string }>(Tables.User)
					.field('email')
					.as('contact')
					.field('phone')
					.as('contact') // Duplicate!
					.build();
			}).toThrow("Property 'contact' is already mapped");
		});

		test('should include helpful source in error message for col()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			expect(() => {
				Mapper.for<{ id: number; bio: string }>(Tables.User)
					.col<string>('bio', 'bio_a')
					.col<string>('bio', 'bio_b')
					.build();
			}).toThrow("col('bio')");
		});

		test('should include helpful source in error message for json()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				}
			});

			expect(() => {
				Mapper.for<{ id: number; data: object }>(Tables.User)
					.json('data_a')
					.as('data')
					.default({})
					.json('data_b')
					.as('data')
					.default({})
					.build();
			}).toThrow("json('data_b')");
		});

		test('should include helpful source in error message for pick()', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				},
				Profile: {
					tableName: 'profile',
					bio: field('bio').string()
				}
			});

			expect(() => {
				Mapper.for<{ id: number; bio: string }>(Tables.User)
					.col<string>('bio', 'user_bio')
					.pick(Tables.Profile, 'bio')
					.build();
			}).toThrow("pick(profile, 'bio')");
		});

		test('should allow different properties to be mapped', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					id: field('id').number()
				},
				Profile: {
					tableName: 'profile',
					bio: field('bio').string()
				}
			});

			// Should not throw - different properties
			const mapper = Mapper.for<{ id: number; bio: string; about: string; settings: object }>(Tables.User)
				.pick(Tables.Profile, 'bio')
				.col<string>('about', 'about_text')
				.json('settings')
				.default({})
				.build();

			expect(mapper).toBeDefined();
		});
	});
});
