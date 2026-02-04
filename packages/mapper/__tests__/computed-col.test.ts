import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper';
import { field } from '../src/field';

describe('Mapper.col() with compute function', () => {
	describe('basic computed columns', () => {
		test('should extract nested value from row using compute function', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					uuid: field('uuid').string()
				}
			});

			interface Page {
				uuid: string;
				name: string;
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || '')
				.build();

			const result = PageMapper.map({
				uuid: 'abc-123',
				payload: { title: 'My Page Title' }
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'My Page Title'
			});
		});

		test('should compute value from multiple columns', () => {
			const Tables = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string()
				}
			});

			interface User {
				uuid: string;
				fullName: string;
			}

			const UserMapper = Mapper.for<User>(Tables.User)
				.col<string>('fullName', (row) => `${row.first_name} ${row.last_name}`)
				.build();

			const result = UserMapper.map({
				uuid: 'abc-123',
				first_name: 'John',
				last_name: 'Doe'
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				fullName: 'John Doe'
			});
		});

		test('should extract deeply nested values', () => {
			const Tables = Mapper.defineTables({
				StatusPage: {
					tableName: 'status_page',
					uuid: field('uuid').string()
				}
			});

			interface StatusPage {
				uuid: string;
				description: string;
			}

			const StatusPageMapper = Mapper.for<StatusPage>(Tables.StatusPage)
				.col<string>('description', (row) => {
					const payload = row.payload as { settings?: { description?: string } };
					return payload?.settings?.description || '';
				})
				.build();

			const result = StatusPageMapper.map({
				uuid: 'abc-123',
				payload: { settings: { description: 'System Status' } }
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				description: 'System Status'
			});
		});
	});

	describe('computed columns with defaults', () => {
		test('should use default when compute function returns null', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					uuid: field('uuid').string()
				}
			});

			interface Page {
				uuid: string;
				name: string;
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || null)
				.default('Untitled')
				.build();

			const result = PageMapper.map({
				uuid: 'abc-123',
				payload: {}
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'Untitled'
			});
		});

		test('should use default when compute function returns undefined', () => {
			const Tables = Mapper.defineTables({
				Item: {
					tableName: 'item',
					uuid: field('uuid').string()
				}
			});

			interface Item {
				uuid: string;
				count: number;
			}

			const ItemMapper = Mapper.for<Item>(Tables.Item)
				.col<number>('count', (row) => (row.stats as { total?: number })?.total)
				.default(0)
				.build();

			const result = ItemMapper.map({
				uuid: 'abc-123',
				stats: null
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				count: 0
			});
		});
	});

	describe('computed columns with optional', () => {
		test('should return undefined when compute function returns null and marked optional', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					uuid: field('uuid').string()
				}
			});

			interface Page {
				uuid: string;
				name?: string;
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || null)
				.optional()
				.build();

			const result = PageMapper.map({
				uuid: 'abc-123',
				payload: {}
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: undefined
			});
		});
	});

	describe('multiple computed columns', () => {
		test('should support multiple computed columns on same mapper', () => {
			const Tables = Mapper.defineTables({
				StatusPage: {
					tableName: 'status_page',
					uuid: field('uuid').string()
				}
			});

			interface StatusPage {
				uuid: string;
				name: string;
				description: string;
				logoUrl?: string;
			}

			const StatusPageMapper = Mapper.for<StatusPage>(Tables.StatusPage)
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || '')
				.col<string>('description', (row) => (row.payload as { description?: string })?.description || '')
				.default('')
				.col<string>('logoUrl', (row) => (row.payload as { logo_url?: string })?.logo_url || null)
				.optional()
				.build();

			const result = StatusPageMapper.map({
				uuid: 'abc-123',
				payload: {
					title: 'System Status',
					description: 'Check system health',
					logo_url: 'https://example.com/logo.png'
				}
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'System Status',
				description: 'Check system health',
				logoUrl: 'https://example.com/logo.png'
			});
		});
	});

	describe('computed columns with other builder methods', () => {
		test('should work with .omit()', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					id: field('id').number(),
					uuid: field('uuid').string()
				}
			});

			interface Page {
				uuid: string;
				name: string;
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				.omit('id')
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || '')
				.build();

			const result = PageMapper.map({
				id: 1,
				uuid: 'abc-123',
				payload: { title: 'My Page' }
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'My Page'
			});
			expect((result as unknown as Record<string, unknown>).id).toBeUndefined();
		});

		test('should work with .json()', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					uuid: field('uuid').string()
				}
			});

			interface Component {
				type: string;
				label: string;
			}

			interface Page {
				uuid: string;
				name: string;
				components: Component[];
			}

			function mapJsonComponents(raw: unknown): Component[] {
				if (!raw || !Array.isArray(raw)) return [];
				return raw.map((c: any) => ({
					type: c.component_type,
					label: c.component_label
				}));
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || '')
				.json<Component[]>('components', mapJsonComponents)
				.default([])
				.build();

			const result = PageMapper.map({
				uuid: 'abc-123',
				payload: { title: 'Status Page' },
				components: [
					{ component_type: 'monitor', component_label: 'API' },
					{ component_type: 'group', component_label: 'Services' }
				]
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'Status Page',
				components: [
					{ type: 'monitor', label: 'API' },
					{ type: 'group', label: 'Services' }
				]
			});
		});

		test('should work with .transform()', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					uuid: field('uuid').string()
				}
			});

			interface Page {
				uuid: string;
				name: string;
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || '')
				.transform('name', (v) => v.trim().toUpperCase())
				.build();

			const result = PageMapper.map({
				uuid: 'abc-123',
				payload: { title: '  my page  ' }
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'MY PAGE'
			});
		});
	});

	describe('mapMany with computed columns', () => {
		test('should apply compute function to all rows', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					uuid: field('uuid').string()
				}
			});

			interface Page {
				uuid: string;
				name: string;
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || '')
				.build();

			const result = PageMapper.mapMany([
				{ uuid: 'abc-1', payload: { title: 'Page One' } },
				{ uuid: 'abc-2', payload: { title: 'Page Two' } },
				{ uuid: 'abc-3', payload: { title: 'Page Three' } }
			]);

			expect(result).toEqual([
				{ uuid: 'abc-1', name: 'Page One' },
				{ uuid: 'abc-2', name: 'Page Two' },
				{ uuid: 'abc-3', name: 'Page Three' }
			]);
		});
	});

	describe('mixing computed and regular .col()', () => {
		test('should allow mixing computed and column-based .col() calls', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					uuid: field('uuid').string()
				}
			});

			interface Page {
				uuid: string;
				name: string;
				viewCount: number;
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				// Computed from nested JSON
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || '')
				// Regular column read (uses snake_case inference)
				.col<number>('viewCount')
				.default(0)
				.build();

			const result = PageMapper.map({
				uuid: 'abc-123',
				payload: { title: 'My Page' },
				view_count: 42
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'My Page',
				viewCount: 42
			});
		});

		test('should allow explicit column name alongside computed', () => {
			const Tables = Mapper.defineTables({
				Page: {
					tableName: 'page',
					uuid: field('uuid').string()
				}
			});

			interface Page {
				uuid: string;
				name: string;
				authorId: string;
			}

			const PageMapper = Mapper.for<Page>(Tables.Page)
				// Computed from nested JSON
				.col<string>('name', (row) => (row.payload as { title?: string })?.title || '')
				// Explicit column name (not compute function)
				.col<string>('authorId', 'created_by_user_uuid')
				.build();

			const result = PageMapper.map({
				uuid: 'abc-123',
				payload: { title: 'My Page' },
				created_by_user_uuid: 'user-456'
			}).value();

			expect(result).toEqual({
				uuid: 'abc-123',
				name: 'My Page',
				authorId: 'user-456'
			});
		});
	});
});
