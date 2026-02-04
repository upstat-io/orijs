import { describe, test, expect } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Params } from '../src/params.ts';

describe('Params', () => {
	describe('uuid', () => {
		test('should validate a single valid UUID', () => {
			const schema = Params.uuid('id');

			const valid = Value.Check(schema, { id: '550e8400-e29b-41d4-a716-446655440000' });
			expect(valid).toBe(true);
		});

		test('should reject invalid UUID', () => {
			const schema = Params.uuid('id');

			const valid = Value.Check(schema, { id: 'not-a-uuid' });
			expect(valid).toBe(false);
		});

		test('should reject UUID without dashes', () => {
			const schema = Params.uuid('id');

			const valid = Value.Check(schema, { id: '550e8400e29b41d4a716446655440000' });
			expect(valid).toBe(false);
		});

		test('should handle uppercase UUID', () => {
			const schema = Params.uuid('id');

			const valid = Value.Check(schema, { id: '550E8400-E29B-41D4-A716-446655440000' });
			expect(valid).toBe(true);
		});

		test('should validate multiple UUID parameters', () => {
			const schema = Params.uuid('orgId', 'userId');

			const valid = Value.Check(schema, {
				orgId: '550e8400-e29b-41d4-a716-446655440000',
				userId: '660e8400-e29b-41d4-a716-446655440001'
			});
			expect(valid).toBe(true);
		});

		test('should reject when one of multiple UUIDs is invalid', () => {
			const schema = Params.uuid('orgId', 'userId');

			const valid = Value.Check(schema, {
				orgId: '550e8400-e29b-41d4-a716-446655440000',
				userId: 'invalid'
			});
			expect(valid).toBe(false);
		});

		test('should reject empty string', () => {
			const schema = Params.uuid('id');

			const valid = Value.Check(schema, { id: '' });
			expect(valid).toBe(false);
		});

		test('should reject missing parameter', () => {
			const schema = Params.uuid('id');

			const valid = Value.Check(schema, {});
			expect(valid).toBe(false);
		});
	});

	describe('string', () => {
		test('should validate any string by default', () => {
			const schema = Params.string('slug');

			const valid = Value.Check(schema, { slug: 'my-slug' });
			expect(valid).toBe(true);
		});

		test('should allow empty string by default', () => {
			const schema = Params.string('slug');

			const valid = Value.Check(schema, { slug: '' });
			expect(valid).toBe(true);
		});

		test('should enforce minLength', () => {
			const schema = Params.string('slug', { minLength: 3 });

			expect(Value.Check(schema, { slug: 'abc' })).toBe(true);
			expect(Value.Check(schema, { slug: 'ab' })).toBe(false);
		});

		test('should enforce maxLength', () => {
			const schema = Params.string('slug', { maxLength: 5 });

			expect(Value.Check(schema, { slug: 'abcde' })).toBe(true);
			expect(Value.Check(schema, { slug: 'abcdef' })).toBe(false);
		});

		test('should enforce minLength and maxLength together', () => {
			const schema = Params.string('slug', { minLength: 2, maxLength: 4 });

			expect(Value.Check(schema, { slug: 'a' })).toBe(false);
			expect(Value.Check(schema, { slug: 'ab' })).toBe(true);
			expect(Value.Check(schema, { slug: 'abcd' })).toBe(true);
			expect(Value.Check(schema, { slug: 'abcde' })).toBe(false);
		});

		test('should enforce pattern', () => {
			const schema = Params.string('slug', { pattern: '^[a-z-]+$' });

			expect(Value.Check(schema, { slug: 'my-slug' })).toBe(true);
			expect(Value.Check(schema, { slug: 'My-Slug' })).toBe(false);
			expect(Value.Check(schema, { slug: 'my_slug' })).toBe(false);
		});

		test('should reject missing parameter', () => {
			const schema = Params.string('slug');

			const valid = Value.Check(schema, {});
			expect(valid).toBe(false);
		});
	});

	describe('number', () => {
		test('should validate numeric string', () => {
			const schema = Params.number('id');

			const valid = Value.Check(schema, { id: '123' });
			expect(valid).toBe(true);
		});

		test('should validate zero', () => {
			const schema = Params.number('id');

			const valid = Value.Check(schema, { id: '0' });
			expect(valid).toBe(true);
		});

		test('should reject non-numeric string', () => {
			const schema = Params.number('id');

			const valid = Value.Check(schema, { id: 'abc' });
			expect(valid).toBe(false);
		});

		test('should reject decimal numbers', () => {
			const schema = Params.number('id');

			const valid = Value.Check(schema, { id: '12.5' });
			expect(valid).toBe(false);
		});

		test('should reject negative numbers', () => {
			const schema = Params.number('id');

			const valid = Value.Check(schema, { id: '-5' });
			expect(valid).toBe(false);
		});

		test('should reject empty string', () => {
			const schema = Params.number('id');

			const valid = Value.Check(schema, { id: '' });
			expect(valid).toBe(false);
		});

		test('should use positive pattern when min > 0', () => {
			const schema = Params.number('id', { min: 1 });

			// Should reject leading zeros
			expect(Value.Check(schema, { id: '0' })).toBe(false);
			expect(Value.Check(schema, { id: '01' })).toBe(false);
			expect(Value.Check(schema, { id: '1' })).toBe(true);
			expect(Value.Check(schema, { id: '10' })).toBe(true);
		});

		test('should reject missing parameter', () => {
			const schema = Params.number('id');

			const valid = Value.Check(schema, {});
			expect(valid).toBe(false);
		});

		test('should handle large numbers', () => {
			const schema = Params.number('id');

			const valid = Value.Check(schema, { id: '999999999999' });
			expect(valid).toBe(true);
		});
	});
});
