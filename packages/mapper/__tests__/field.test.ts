import { describe, test, expect } from 'bun:test';
import { field } from '../src/field';

describe('field builders', () => {
	describe('field().string()', () => {
		test('should create string field with column name', () => {
			const f = field('display_name').string();
			expect(f._def).toEqual({
				column: 'display_name',
				type: 'string',
				optional: false
			});
		});

		test('should support optional() chaining', () => {
			const f = field('email').string().optional();
			expect(f._def.optional).toBe(true);
			expect(f._def.column).toBe('email');
			expect(f._def.type).toBe('string');
		});

		test('should support default() chaining', () => {
			const f = field('avatar_url').string().default('');
			expect(f._def.defaultValue).toBe('');
			expect(f._def.optional).toBe(false);
		});

		test('should support optional().default() chain', () => {
			const f = field('nickname').string().optional().default('Anonymous');
			expect(f._def.optional).toBe(true);
			expect(f._def.defaultValue).toBe('Anonymous');
		});
	});

	describe('field().number()', () => {
		test('should create number field with column name', () => {
			const f = field('retry_count').number();
			expect(f._def).toEqual({
				column: 'retry_count',
				type: 'number',
				optional: false
			});
		});

		test('should support optional() chaining', () => {
			const f = field('age').number().optional();
			expect(f._def.optional).toBe(true);
		});

		test('should support default() with numeric value', () => {
			const f = field('attempts').number().default(0);
			expect(f._def.defaultValue).toBe(0);
		});
	});

	describe('field().boolean()', () => {
		test('should create boolean field with column name', () => {
			const f = field('is_active').boolean();
			expect(f._def).toEqual({
				column: 'is_active',
				type: 'boolean',
				optional: false
			});
		});

		test('should support default(false)', () => {
			const f = field('enabled').boolean().default(false);
			expect(f._def.defaultValue).toBe(false);
		});

		test('should support default(true)', () => {
			const f = field('visible').boolean().default(true);
			expect(f._def.defaultValue).toBe(true);
		});
	});

	describe('field().date()', () => {
		test('should create date field with column name', () => {
			const f = field('created_at').date();
			expect(f._def).toEqual({
				column: 'created_at',
				type: 'date',
				optional: false
			});
		});

		test('should support optional() for nullable dates', () => {
			const f = field('deleted_at').date().optional();
			expect(f._def.optional).toBe(true);
		});

		test('should support default() with Date value', () => {
			const defaultDate = new Date('2024-01-01T00:00:00Z');
			const f = field('start_date').date().default(defaultDate);
			expect(f._def.defaultValue).toBe(defaultDate);
		});
	});

	describe('field().any()', () => {
		test('should create any field with column name', () => {
			const f = field('metadata').any();
			expect(f._def).toEqual({
				column: 'metadata',
				type: 'any',
				optional: false
			});
		});

		test('should support typed any field for JSONB', () => {
			interface Settings {
				theme: string;
				notifications: boolean;
			}
			const f = field('settings').any<Settings>();
			expect(f._def.type).toBe('any');
		});

		test('should support default() with object value', () => {
			const defaultValue = { enabled: true };
			const f = field('config').any<{ enabled: boolean }>().default(defaultValue);
			expect(f._def.defaultValue).toEqual({ enabled: true });
		});

		test('should support optional() for nullable JSONB', () => {
			const f = field('extra_data').any().optional();
			expect(f._def.optional).toBe(true);
		});
	});

	describe('field().string().nullable()', () => {
		test('should create nullable string field', () => {
			const f = field('parent_uuid').string().nullable();
			expect(f._def.column).toBe('parent_uuid');
			expect(f._def.type).toBe('string');
		});

		test('should allow default(null) on nullable field', () => {
			const f = field('parent_uuid').string().nullable().default(null);
			expect(f._def.defaultValue).toBeNull();
		});

		test('should allow default with non-null value on nullable field', () => {
			const f = field('status').string().nullable().default('active');
			expect(f._def.defaultValue).toBe('active');
		});
	});

	describe('field().number().nullable()', () => {
		test('should allow default(null) on nullable number', () => {
			const f = field('parent_id').number().nullable().default(null);
			expect(f._def.defaultValue).toBeNull();
			expect(f._def.type).toBe('number');
		});
	});

	describe('field().date().nullable()', () => {
		test('should allow default(null) on nullable date', () => {
			const f = field('deleted_at').date().nullable().default(null);
			expect(f._def.defaultValue).toBeNull();
			expect(f._def.type).toBe('date');
		});
	});

	describe('immutability', () => {
		test('should return new builder instance on optional()', () => {
			const f1 = field('email').string();
			const f2 = f1.optional();

			expect(f1._def.optional).toBe(false);
			expect(f2._def.optional).toBe(true);
			expect(f1).not.toBe(f2);
		});

		test('should return new builder instance on default()', () => {
			const f1 = field('count').number();
			const f2 = f1.default(0);

			expect(f1._def.defaultValue).toBeUndefined();
			expect(f2._def.defaultValue).toBe(0);
			expect(f1).not.toBe(f2);
		});

		test('should preserve original builder after chaining', () => {
			const original = field('name').string();
			const withOptional = original.optional();
			const withDefault = original.default('default');

			expect(original._def.optional).toBe(false);
			expect(original._def.defaultValue).toBeUndefined();
			expect(withOptional._def.optional).toBe(true);
			expect(withDefault._def.defaultValue).toBe('default');
		});
	});
});
