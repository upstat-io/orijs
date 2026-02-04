import { describe, test, expect } from 'bun:test';
import { Params, Query, validate } from '../src/index.ts';

describe('Params helpers', () => {
	describe('Params.uuid', () => {
		test('should validate valid UUID', async () => {
			const schema = Params.uuid('id');
			const result = await validate(schema, { id: '550e8400-e29b-41d4-a716-446655440000' });
			expect(result.success).toBe(true);
		});

		test('should reject invalid UUID', async () => {
			const schema = Params.uuid('id');
			const result = await validate(schema, { id: 'not-a-uuid' });
			expect(result.success).toBe(false);
		});

		test('should validate multiple UUID params', async () => {
			const schema = Params.uuid('orgId', 'userId');
			const result = await validate(schema, {
				orgId: '550e8400-e29b-41d4-a716-446655440000',
				userId: '660e8400-e29b-41d4-a716-446655440001'
			});
			expect(result.success).toBe(true);
		});

		test('should reject if any UUID is invalid', async () => {
			const schema = Params.uuid('orgId', 'userId');
			const result = await validate(schema, {
				orgId: '550e8400-e29b-41d4-a716-446655440000',
				userId: 'invalid'
			});
			expect(result.success).toBe(false);
		});
	});

	describe('Params.string', () => {
		test('should validate string param', async () => {
			const schema = Params.string('slug');
			const result = await validate(schema, { slug: 'my-post' });
			expect(result.success).toBe(true);
		});

		test('should validate string with minLength', async () => {
			const schema = Params.string('slug', { minLength: 3 });

			const validResult = await validate(schema, { slug: 'abc' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(schema, { slug: 'ab' });
			expect(invalidResult.success).toBe(false);
		});

		test('should validate string with maxLength', async () => {
			const schema = Params.string('slug', { maxLength: 10 });

			const validResult = await validate(schema, { slug: 'short' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(schema, { slug: 'this-is-way-too-long' });
			expect(invalidResult.success).toBe(false);
		});

		test('should validate string with pattern', async () => {
			const schema = Params.string('slug', { pattern: '^[a-z-]+$' });

			const validResult = await validate(schema, { slug: 'my-post' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(schema, { slug: 'MY_POST' });
			expect(invalidResult.success).toBe(false);
		});
	});

	describe('Params.number', () => {
		test('should validate numeric string', async () => {
			const schema = Params.number('id');
			const result = await validate(schema, { id: '123' });
			expect(result.success).toBe(true);
		});

		test('should reject non-numeric string', async () => {
			const schema = Params.number('id');
			const result = await validate(schema, { id: 'abc' });
			expect(result.success).toBe(false);
		});

		test('should reject negative numbers', async () => {
			const schema = Params.number('id');
			const result = await validate(schema, { id: '-5' });
			expect(result.success).toBe(false);
		});

		test('should validate with min option preventing zero', async () => {
			const schema = Params.number('id', { min: 1 });

			const validResult = await validate(schema, { id: '123' });
			expect(validResult.success).toBe(true);

			// Zero would fail pattern ^[1-9][0-9]*$
			const zeroResult = await validate(schema, { id: '0' });
			expect(zeroResult.success).toBe(false);
		});
	});
});

describe('Query helpers', () => {
	describe('Query.pagination', () => {
		test('should validate page and limit', async () => {
			const schema = Query.pagination();
			const result = await validate(schema, { page: '1', limit: '20' });
			expect(result.success).toBe(true);
		});

		test('should allow empty query (optional params)', async () => {
			const schema = Query.pagination();
			const result = await validate(schema, {});
			expect(result.success).toBe(true);
		});

		test('should reject non-numeric page', async () => {
			const schema = Query.pagination();
			const result = await validate(schema, { page: 'one' });
			expect(result.success).toBe(false);
		});

		test('should reject non-numeric limit', async () => {
			const schema = Query.pagination();
			const result = await validate(schema, { limit: 'twenty' });
			expect(result.success).toBe(false);
		});
	});

	describe('Query.search', () => {
		test('should validate search query', async () => {
			const schema = Query.search();
			const result = await validate(schema, { q: 'hello' });
			expect(result.success).toBe(true);
		});

		test('should allow empty search (optional)', async () => {
			const schema = Query.search();
			const result = await validate(schema, {});
			expect(result.success).toBe(true);
		});

		test('should validate search with minLength', async () => {
			const schema = Query.search({ minLength: 3 });

			const validResult = await validate(schema, { q: 'hello' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(schema, { q: 'hi' });
			expect(invalidResult.success).toBe(false);
		});

		test('should validate search with maxLength', async () => {
			const schema = Query.search({ maxLength: 10 });

			const validResult = await validate(schema, { q: 'hello' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(schema, { q: 'this is a very long search query' });
			expect(invalidResult.success).toBe(false);
		});
	});

	describe('Query.sort', () => {
		test('should validate sort parameters', async () => {
			const schema = Query.sort();
			const result = await validate(schema, { sortBy: 'name', order: 'asc' });
			expect(result.success).toBe(true);
		});

		test('should allow empty sort (optional)', async () => {
			const schema = Query.sort();
			const result = await validate(schema, {});
			expect(result.success).toBe(true);
		});

		test('should validate order values', async () => {
			const schema = Query.sort();

			const ascResult = await validate(schema, { order: 'asc' });
			expect(ascResult.success).toBe(true);

			const descResult = await validate(schema, { order: 'desc' });
			expect(descResult.success).toBe(true);

			const invalidResult = await validate(schema, { order: 'random' });
			expect(invalidResult.success).toBe(false);
		});

		test('should validate allowed sort fields', async () => {
			const schema = Query.sort({ allowed: ['createdAt', 'name'] });

			const validResult = await validate(schema, { sortBy: 'createdAt' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(schema, { sortBy: 'email' });
			expect(invalidResult.success).toBe(false);
		});
	});
});
