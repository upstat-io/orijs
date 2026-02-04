/**
 * Unit tests for the mock-sql test helper.
 *
 * Verifies the mock correctly implements both Bun SQL calling patterns:
 * 1. Tagged template mode: mock`SELECT * FROM users`
 * 2. Identifier function mode: mock('tablename')
 */

import { describe, it, expect } from 'bun:test';
import { createMockSql, type IdentifierMarker } from './mock-sql';

describe('createMockSql', () => {
	describe('factory function', () => {
		it('should return a function', () => {
			const mock = createMockSql();
			expect(typeof mock).toBe('function');
		});

		it('should initialize lastCall as null', () => {
			const mock = createMockSql();
			expect(mock.lastCall).toBeNull();
		});

		it('should have isIdentifierMarker method', () => {
			const mock = createMockSql();
			expect(typeof mock.isIdentifierMarker).toBe('function');
		});
	});

	describe('template mode', () => {
		it('should capture strings from tagged template', () => {
			const mock = createMockSql();
			mock`SELECT * FROM users`;

			expect(mock.lastCall).not.toBeNull();
			expect(mock.lastCall!.strings).toEqual(['SELECT * FROM users']);
		});

		it('should capture strings and values with interpolations', () => {
			const mock = createMockSql();
			const id = 42;
			const name = 'test';
			mock`SELECT * FROM users WHERE id = ${id} AND name = ${name}`;

			expect(mock.lastCall!.strings).toEqual(['SELECT * FROM users WHERE id = ', ' AND name = ', '']);
			expect(mock.lastCall!.values).toEqual([42, 'test']);
		});

		it('should return a Promise', async () => {
			const mock = createMockSql();
			const result = mock`SELECT 1`;

			expect(result).toBeInstanceOf(Promise);
			expect(await result).toEqual([]);
		});

		it('should handle empty template', () => {
			const mock = createMockSql();
			mock``;

			expect(mock.lastCall!.strings).toEqual(['']);
			expect(mock.lastCall!.values).toEqual([]);
		});

		it('should overwrite lastCall on subsequent calls', () => {
			const mock = createMockSql();
			mock`first query`;
			mock`second query`;

			expect(mock.lastCall!.strings).toEqual(['second query']);
		});

		it('should handle various value types', () => {
			const mock = createMockSql();
			const date = new Date('2024-01-01');
			const obj = { key: 'value' };

			mock`SELECT ${42} ${true} ${null} ${date} ${obj}`;

			expect(mock.lastCall!.values).toEqual([42, true, null, date, obj]);
		});
	});

	describe('identifier mode', () => {
		it('should return identifier marker for string argument', () => {
			const mock = createMockSql();
			const result = mock('tablename');

			expect(result).toEqual({ __isIdentifier: true, name: 'tablename' });
		});

		it('should preserve exact identifier name', () => {
			const mock = createMockSql();

			expect(mock('user')).toEqual({ __isIdentifier: true, name: 'user' });
			expect(mock('column_name')).toEqual({ __isIdentifier: true, name: 'column_name' });
			expect(mock('')).toEqual({ __isIdentifier: true, name: '' });
		});

		it('should not affect lastCall', () => {
			const mock = createMockSql();
			mock`initial query`;
			mock('identifier');

			// lastCall should still be from template call
			expect(mock.lastCall!.strings).toEqual(['initial query']);
		});
	});

	describe('isIdentifierMarker', () => {
		it('should return true for valid identifier markers', () => {
			const mock = createMockSql();
			const marker = mock('test');

			expect(mock.isIdentifierMarker(marker)).toBe(true);
		});

		it('should return true for manually created markers', () => {
			const mock = createMockSql();
			const marker: IdentifierMarker = { __isIdentifier: true, name: 'test' };

			expect(mock.isIdentifierMarker(marker)).toBe(true);
		});

		it('should return false for non-objects', () => {
			const mock = createMockSql();

			expect(mock.isIdentifierMarker(null)).toBe(false);
			expect(mock.isIdentifierMarker(undefined)).toBe(false);
			expect(mock.isIdentifierMarker('string')).toBe(false);
			expect(mock.isIdentifierMarker(42)).toBe(false);
			expect(mock.isIdentifierMarker(true)).toBe(false);
		});

		it('should return false for objects without __isIdentifier', () => {
			const mock = createMockSql();

			expect(mock.isIdentifierMarker({})).toBe(false);
			expect(mock.isIdentifierMarker({ name: 'test' })).toBe(false);
			expect(mock.isIdentifierMarker({ __isIdentifier: false, name: 'test' })).toBe(false);
		});

		it('should return false for arrays', () => {
			const mock = createMockSql();

			expect(mock.isIdentifierMarker([])).toBe(false);
			expect(mock.isIdentifierMarker(['test'])).toBe(false);
		});
	});

	describe('integration with createOriSql pattern', () => {
		it('should work with identifier markers passed as template values', () => {
			const mock = createMockSql();
			const columnMarker = mock('column');
			const tableMarker = mock('table');

			// Simulate how createOriSql would call the mock
			mock`SELECT ${columnMarker} FROM ${tableMarker} WHERE id = ${42}`;

			expect(mock.lastCall!.strings).toEqual(['SELECT ', ' FROM ', ' WHERE id = ', '']);
			expect(mock.isIdentifierMarker(mock.lastCall!.values[0])).toBe(true);
			expect(mock.isIdentifierMarker(mock.lastCall!.values[1])).toBe(true);
			expect(mock.isIdentifierMarker(mock.lastCall!.values[2])).toBe(false);
			expect((mock.lastCall!.values[0] as IdentifierMarker).name).toBe('column');
			expect((mock.lastCall!.values[1] as IdentifierMarker).name).toBe('table');
			expect(mock.lastCall!.values[2]).toBe(42);
		});
	});
});
