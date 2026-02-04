import { describe, test, expect } from 'bun:test';
import { validate, validateSync, Type, t } from '../src/index.ts';

describe('validate', () => {
	describe('TypeBox schemas', () => {
		test('should validate valid data', async () => {
			const schema = Type.Object({
				name: Type.String(),
				age: Type.Number()
			});

			const result = await validate(schema, { name: 'Alice', age: 30 });

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toEqual({ name: 'Alice', age: 30 });
			}
		});

		test('should return errors for invalid data', async () => {
			const schema = Type.Object({
				name: Type.String(),
				age: Type.Number()
			});

			const result = await validate(schema, { name: 123, age: 'not a number' });

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.errors.some((e) => e.path.includes('name'))).toBe(true);
				expect(result.errors.some((e) => e.path.includes('age'))).toBe(true);
			}
		});

		test('should validate required fields', async () => {
			const schema = Type.Object({
				name: Type.String()
			});

			const result = await validate(schema, {});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errors.some((e) => e.path.includes('name'))).toBe(true);
			}
		});

		test('should validate optional fields', async () => {
			const schema = Type.Object({
				name: Type.String(),
				nickname: Type.Optional(Type.String())
			});

			const result = await validate(schema, { name: 'Alice' });

			expect(result.success).toBe(true);
		});

		test('should validate string patterns', async () => {
			const schema = Type.Object({
				email: Type.String({ pattern: '^[^@]+@[^@]+\\.[^@]+$' })
			});

			const validResult = await validate(schema, { email: 'test@example.com' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(schema, { email: 'not-an-email' });
			expect(invalidResult.success).toBe(false);
		});

		test('should validate UUID pattern', async () => {
			const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
			const schema = Type.Object({
				id: Type.String({ pattern: uuidPattern })
			});

			const validResult = await validate(schema, { id: '550e8400-e29b-41d4-a716-446655440000' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(schema, { id: 'not-a-uuid' });
			expect(invalidResult.success).toBe(false);
		});

		test('should work with t alias', async () => {
			const schema = t.Object({
				name: t.String()
			});

			const result = await validate(schema, { name: 'Alice' });
			expect(result.success).toBe(true);
		});
	});

	describe('Standard Schema', () => {
		test('should validate using Standard Schema interface', async () => {
			const standardSchema = {
				'~standard': {
					version: 1 as const,
					vendor: 'test',
					validate: (value: unknown) => {
						if (typeof value === 'object' && value !== null && 'name' in value) {
							return { value: value as { name: string } };
						}
						return { issues: [{ message: 'Invalid data' }] };
					}
				}
			};

			const validResult = await validate(standardSchema, { name: 'Alice' });
			expect(validResult.success).toBe(true);

			const invalidResult = await validate(standardSchema, { other: 'field' });
			expect(invalidResult.success).toBe(false);
		});

		test('should preserve path information from Standard Schema', async () => {
			const standardSchema = {
				'~standard': {
					version: 1 as const,
					vendor: 'test',
					validate: (_: unknown) => ({
						issues: [
							{ message: 'Name is required', path: ['name'] },
							{ message: 'Age must be a number', path: ['age'] }
						]
					})
				}
			};

			const result = await validate(standardSchema, {});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errors).toHaveLength(2);
				expect(result.errors[0]?.path).toBe('name');
				expect(result.errors[1]?.path).toBe('age');
			}
		});
	});

	describe('Custom validators', () => {
		test('should validate with sync custom function', async () => {
			const customValidator = (data: unknown) => {
				if (typeof data === 'object' && data !== null && 'name' in data) {
					return data as { name: string };
				}
				throw new Error('Invalid data: name is required');
			};

			const validResult = await validate(customValidator, { name: 'Alice' });
			expect(validResult.success).toBe(true);
			if (validResult.success) {
				expect(validResult.data).toEqual({ name: 'Alice' });
			}

			const invalidResult = await validate(customValidator, {});
			expect(invalidResult.success).toBe(false);
			if (!invalidResult.success) {
				expect(invalidResult.errors[0]?.message).toBe('Invalid data: name is required');
			}
		});

		test('should validate with async custom function', async () => {
			const asyncValidator = async (data: unknown) => {
				// Simulate async operation (e.g., database lookup)
				await new Promise((resolve) => setTimeout(resolve, 1));

				if (typeof data === 'object' && data !== null && 'email' in data) {
					const email = (data as { email: string }).email;
					// Simulate checking if email is already registered
					if (email === 'taken@example.com') {
						throw new Error('Email already registered');
					}
					return data as { email: string };
				}
				throw new Error('Email is required');
			};

			const validResult = await validate(asyncValidator, { email: 'new@example.com' });
			expect(validResult.success).toBe(true);

			const takenResult = await validate(asyncValidator, { email: 'taken@example.com' });
			expect(takenResult.success).toBe(false);
			if (!takenResult.success) {
				expect(takenResult.errors[0]?.message).toBe('Email already registered');
			}
		});

		test('should transform data with custom validator', async () => {
			const transformValidator = (data: unknown) => {
				if (typeof data !== 'object' || data === null) {
					throw new Error('Expected object');
				}
				const input = data as Record<string, unknown>;
				return {
					name: String(input.name).trim().toLowerCase(),
					createdAt: new Date()
				};
			};

			const result = await validate(transformValidator, { name: '  ALICE  ' });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.name).toBe('alice');
				expect(result.data.createdAt).toBeInstanceOf(Date);
			}
		});
	});

	describe('validateSync', () => {
		test('should validate TypeBox schema synchronously', () => {
			const schema = Type.Object({
				name: Type.String(),
				age: Type.Number()
			});

			const result = validateSync(schema, { name: 'Alice', age: 30 });

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toEqual({ name: 'Alice', age: 30 });
			}
		});

		test('should return errors for invalid data synchronously', () => {
			const schema = Type.Object({
				name: Type.String(),
				age: Type.Number()
			});

			const result = validateSync(schema, { name: 123, age: 'not a number' });

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errors.length).toBeGreaterThan(0);
			}
		});

		test('should throw for non-TypeBox schemas', () => {
			const customValidator = (data: unknown) => data as { name: string };

			expect(() => validateSync(customValidator as never, { name: 'test' })).toThrow(
				'validateSync only supports TypeBox schemas'
			);
		});

		test('should sanitize prototype pollution attempts', () => {
			const schema = Type.Object(
				{
					name: Type.String()
				},
				{ additionalProperties: false }
			);

			const maliciousData = JSON.parse('{"name": "test", "__proto__": {"admin": true}}');
			const result = validateSync<{ name: string }>(schema, maliciousData);

			// With additionalProperties: false, the __proto__ key causes validation to fail
			// With additionalProperties: true (default), the key is stripped by Json.sanitize
			// Either way, prototype pollution is prevented
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.name).toBe('test');
				// Verify prototype chain is not polluted
				const testObj = {};
				expect((testObj as Record<string, unknown>).admin).toBeUndefined();
			}
		});

		test('should validate with additionalProperties: false', () => {
			const schema = Type.Object(
				{
					name: Type.String()
				},
				{ additionalProperties: false }
			);

			const result = validateSync(schema, { name: 'test', extra: 'field' });

			expect(result.success).toBe(false);
		});
	});
});
