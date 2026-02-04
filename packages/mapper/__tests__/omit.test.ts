/**
 * Omit Tests
 *
 * Tests for the .omit() method that excludes fields from the primary table.
 */
import { describe, it, expect } from 'bun:test';
import { Mapper, field } from '../src';

const TestTable = Mapper.defineTable({
	tableName: 'test',
	id: field('id').number(),
	uuid: field('uuid').string(),
	name: field('name').string(),
	accountId: field('account_id').number(),
	createdAt: field('created_at').date(),
	isActive: field('is_active').boolean()
});

describe('omit', () => {
	it('should exclude a single field from mapping', () => {
		type TestWithoutId = {
			uuid: string;
			name: string;
			accountId: number;
			createdAt: Date;
			isActive: boolean;
		};
		const mapper = Mapper.for<TestWithoutId>(TestTable).omit('id').build();

		const row = {
			id: 123,
			uuid: 'test-uuid',
			name: 'Test',
			account_id: 456,
			created_at: '2024-01-15T10:00:00Z',
			is_active: true
		};

		const result = mapper.map(row).value()!;

		expect(result.uuid).toBe('test-uuid');
		expect(result.name).toBe('Test');
		expect(result.accountId).toBe(456);
		expect(result.isActive).toBe(true);
		expect((result as any).id).toBeUndefined();
	});

	it('should exclude multiple fields from mapping', () => {
		type TestMinimal = { uuid: string; name: string };
		const mapper = Mapper.for<TestMinimal>(TestTable)
			.omit('id', 'accountId', 'createdAt', 'isActive')
			.build();

		const row = {
			id: 123,
			uuid: 'test-uuid',
			name: 'Test',
			account_id: 456,
			created_at: '2024-01-15T10:00:00Z',
			is_active: true
		};

		const result = mapper.map(row).value()!;

		expect(result.uuid).toBe('test-uuid');
		expect(result.name).toBe('Test');
		expect((result as any).id).toBeUndefined();
		expect((result as any).accountId).toBeUndefined();
		expect((result as any).createdAt).toBeUndefined();
		expect((result as any).isActive).toBeUndefined();
	});

	it('should allow chaining omit with other methods', () => {
		type TestWithExtra = { uuid: string; name: string; extra: string };
		const mapper = Mapper.for<TestWithExtra>(TestTable)
			.omit('id', 'accountId', 'createdAt', 'isActive')
			.col<string>('extra', 'extra_column')
			.build();

		const row = {
			uuid: 'test-uuid',
			name: 'Test',
			extra_column: 'extra-value'
		};

		const result = mapper.map(row).value()!;

		expect(result.uuid).toBe('test-uuid');
		expect(result.name).toBe('Test');
		expect(result.extra).toBe('extra-value');
	});

	it('should not throw when omitted required fields are missing from row', () => {
		type TestWithoutId = { uuid: string; name: string };
		const mapper = Mapper.for<TestWithoutId>(TestTable)
			.omit('id', 'accountId', 'createdAt', 'isActive')
			.build();

		// Row missing id, account_id, created_at, is_active - but they're omitted so should not throw
		const row = {
			uuid: 'test-uuid',
			name: 'Test'
		};

		const result = mapper.map(row).value();

		expect(result).not.toBeUndefined();
		expect(result!.uuid).toBe('test-uuid');
		expect(result!.name).toBe('Test');
	});

	it('should work with mapMany', () => {
		type TestWithoutId = { uuid: string; name: string };
		const mapper = Mapper.for<TestWithoutId>(TestTable)
			.omit('id', 'accountId', 'createdAt', 'isActive')
			.build();

		const rows = [
			{ uuid: 'uuid-1', name: 'One' },
			{ uuid: 'uuid-2', name: 'Two' }
		];

		const results = mapper.mapMany(rows);

		expect(results).toHaveLength(2);
		expect(results[0]!.uuid).toBe('uuid-1');
		expect(results[1]!.uuid).toBe('uuid-2');
	});

	it('should allow calling omit multiple times', () => {
		type TestMinimal = { uuid: string; name: string };
		const mapper = Mapper.for<TestMinimal>(TestTable)
			.omit('id')
			.omit('accountId')
			.omit('createdAt', 'isActive')
			.build();

		const row = {
			uuid: 'test-uuid',
			name: 'Test'
		};

		const result = mapper.map(row).value()!;

		expect(result.uuid).toBe('test-uuid');
		expect(result.name).toBe('Test');
	});
});
