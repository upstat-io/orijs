import { describe, test, expect } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { validate } from '../src/types';

describe('validate defaults', () => {
	test('should pass validation when missing field has a schema default', async () => {
		const schema = Type.Object({
			name: Type.String(),
			role: Type.String({ default: 'user' })
		});

		const result = await validate(schema, { name: 'Alice' });

		expect(result.success).toBe(true);
	});

	test('should return defaulted value in result.data when field is missing', async () => {
		const schema = Type.Object({
			name: Type.String(),
			role: Type.String({ default: 'user' })
		});

		const result = await validate(schema, { name: 'Alice' });

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ name: 'Alice', role: 'user' });
		}
	});

	test('should not override explicit value with schema default', async () => {
		const schema = Type.Object({
			name: Type.String(),
			role: Type.String({ default: 'user' })
		});

		const result = await validate(schema, { name: 'Alice', role: 'admin' });

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ name: 'Alice', role: 'admin' });
		}
	});

	test('should fail validation when required field without default is missing', async () => {
		const schema = Type.Object({
			name: Type.String(),
			age: Type.Number()
		});

		const result = await validate(schema, { name: 'Alice' });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errors.some((e) => e.path.includes('age'))).toBe(true);
		}
	});

	test('should apply numeric default for pagination-like schema', async () => {
		const schema = Type.Object({
			page: Type.Number({ default: 1 }),
			limit: Type.Number({ default: 20 })
		});

		const result = await validate(schema, {});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ page: 1, limit: 20 });
		}
	});

	test('should not mutate the original input data', async () => {
		const schema = Type.Object({
			name: Type.String(),
			role: Type.String({ default: 'user' })
		});

		const input = { name: 'Alice' };
		await validate(schema, input);

		expect(input).toEqual({ name: 'Alice' });
		expect((input as Record<string, unknown>).role).toBeUndefined();
	});
});
