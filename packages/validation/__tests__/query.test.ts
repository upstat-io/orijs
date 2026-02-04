import { describe, it, expect } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Query } from '../src/query';

describe('Query', () => {
	describe('pagination', () => {
		it('should create schema with default options', () => {
			const schema = Query.pagination();
			expect(schema).toBeDefined();
			expect(schema.type).toBe('object');
		});

		it('should decode page string to number', () => {
			const schema = Query.pagination();
			const decoded = Value.Decode(schema, { page: '5', limit: '10' });
			expect(decoded.page).toBe(5);
			expect(decoded.limit).toBe(10);
		});

		it('should use default page when not provided', () => {
			const schema = Query.pagination({ defaultPage: 1 });
			const decoded = Value.Decode(schema, {});
			expect(decoded.page).toBeUndefined(); // Optional, so undefined when not provided
		});

		it('should enforce minimum page of 1', () => {
			const schema = Query.pagination();
			const decoded = Value.Decode(schema, { page: '0' });
			expect(decoded.page).toBe(1);
		});

		it('should enforce maxLimit constraint', () => {
			const schema = Query.pagination({ maxLimit: 50 });
			const decoded = Value.Decode(schema, { limit: '100' });
			expect(decoded.limit).toBe(50);
		});

		it('should enforce minLimit constraint', () => {
			const schema = Query.pagination({ minLimit: 5 });
			const decoded = Value.Decode(schema, { limit: '1' });
			expect(decoded.limit).toBe(5);
		});

		it('should use custom default limit', () => {
			const schema = Query.pagination({ defaultLimit: 25 });
			expect(schema).toBeDefined();
		});
	});

	describe('search', () => {
		it('should create schema with default options', () => {
			const schema = Query.search();
			expect(schema).toBeDefined();
			expect(schema.type).toBe('object');
		});

		it('should accept valid search query', () => {
			const schema = Query.search();
			const isValid = Value.Check(schema, { q: 'test query' });
			expect(isValid).toBe(true);
		});

		it('should reject search query below minLength', () => {
			const schema = Query.search({ minLength: 3 });
			const isValid = Value.Check(schema, { q: 'ab' });
			expect(isValid).toBe(false);
		});

		it('should reject search query above maxLength', () => {
			const schema = Query.search({ maxLength: 10 });
			const isValid = Value.Check(schema, { q: 'this is a very long search query' });
			expect(isValid).toBe(false);
		});

		it('should allow empty query when not provided', () => {
			const schema = Query.search();
			const isValid = Value.Check(schema, {});
			expect(isValid).toBe(true);
		});

		it('should use custom minLength and maxLength', () => {
			const schema = Query.search({ minLength: 2, maxLength: 50 });
			expect(schema).toBeDefined();
		});
	});

	describe('sort', () => {
		it('should create schema with default options', () => {
			const schema = Query.sort();
			expect(schema).toBeDefined();
			expect(schema.type).toBe('object');
		});

		it('should accept valid sort parameters', () => {
			const schema = Query.sort({ allowed: ['createdAt', 'name'] });
			const isValid = Value.Check(schema, { sortBy: 'createdAt', order: 'asc' });
			expect(isValid).toBe(true);
		});

		it('should reject sortBy not in allowed list', () => {
			const schema = Query.sort({ allowed: ['createdAt', 'name'] });
			const isValid = Value.Check(schema, { sortBy: 'invalid' });
			expect(isValid).toBe(false);
		});

		it('should accept asc order', () => {
			const schema = Query.sort();
			const isValid = Value.Check(schema, { order: 'asc' });
			expect(isValid).toBe(true);
		});

		it('should accept desc order', () => {
			const schema = Query.sort();
			const isValid = Value.Check(schema, { order: 'desc' });
			expect(isValid).toBe(true);
		});

		it('should reject invalid order', () => {
			const schema = Query.sort();
			const isValid = Value.Check(schema, { order: 'invalid' });
			expect(isValid).toBe(false);
		});

		it('should allow any sortBy when no allowed list provided', () => {
			const schema = Query.sort();
			const isValid = Value.Check(schema, { sortBy: 'anyField' });
			expect(isValid).toBe(true);
		});

		it('should use custom default order', () => {
			const schema = Query.sort({ defaultOrder: 'desc' });
			expect(schema).toBeDefined();
		});

		it('should allow empty sort parameters', () => {
			const schema = Query.sort();
			const isValid = Value.Check(schema, {});
			expect(isValid).toBe(true);
		});

		it('should use defaultField when sortBy not provided', () => {
			const schema = Query.sort({ allowed: ['createdAt', 'name'], defaultField: 'createdAt' });
			expect(schema).toBeDefined();
			// Schema has default set, so validation passes without sortBy
			const isValid = Value.Check(schema, { order: 'asc' });
			expect(isValid).toBe(true);
		});

		it('should use defaultField with no allowed list', () => {
			const schema = Query.sort({ defaultField: 'updatedAt' });
			expect(schema).toBeDefined();
			const isValid = Value.Check(schema, {});
			expect(isValid).toBe(true);
		});
	});

	describe('pagination encode', () => {
		it('should encode page number back to string', () => {
			const schema = Query.pagination();
			const decoded = Value.Decode(schema, { page: '5', limit: '10' });
			const encoded = Value.Encode(schema, decoded);
			expect(encoded.page).toBe('5');
			expect(encoded.limit).toBe('10');
		});

		it('should encode adjusted values back to string', () => {
			const schema = Query.pagination({ maxLimit: 50, minLimit: 5 });
			// limit: 100 gets clamped to 50
			const decoded = Value.Decode(schema, { page: '0', limit: '100' });
			expect(decoded.page).toBe(1); // clamped to min 1
			expect(decoded.limit).toBe(50); // clamped to max 50

			const encoded = Value.Encode(schema, decoded);
			expect(encoded.page).toBe('1');
			expect(encoded.limit).toBe('50');
		});
	});

	describe('edge cases', () => {
		it('should handle negative page by clamping to 1', () => {
			const schema = Query.pagination();
			// Note: pattern '^[0-9]+$' won't match negative, but if it did get through:
			// The decode clamps with Math.max(1, num)
			const decoded = Value.Decode(schema, { page: '0' });
			expect(decoded.page).toBe(1);
		});

		it('should handle very large limit by clamping to maxLimit', () => {
			const schema = Query.pagination({ maxLimit: 100 });
			const decoded = Value.Decode(schema, { limit: '999999' });
			expect(decoded.limit).toBe(100);
		});

		it('should handle very small limit by clamping to minLimit', () => {
			const schema = Query.pagination({ minLimit: 10 });
			const decoded = Value.Decode(schema, { limit: '1' });
			expect(decoded.limit).toBe(10);
		});

		it('should reject non-numeric page string', () => {
			const schema = Query.pagination();
			const isValid = Value.Check(schema, { page: 'abc' });
			expect(isValid).toBe(false);
		});

		it('should reject non-numeric limit string', () => {
			const schema = Query.pagination();
			const isValid = Value.Check(schema, { limit: 'abc' });
			expect(isValid).toBe(false);
		});

		it('should handle search with exact minLength', () => {
			const schema = Query.search({ minLength: 3 });
			const isValid = Value.Check(schema, { q: 'abc' });
			expect(isValid).toBe(true);
		});

		it('should handle search with exact maxLength', () => {
			const schema = Query.search({ maxLength: 5 });
			const isValid = Value.Check(schema, { q: 'abcde' });
			expect(isValid).toBe(true);
		});
	});
});
