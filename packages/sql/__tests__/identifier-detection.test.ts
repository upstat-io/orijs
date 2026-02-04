/**
 * Unit tests for identifier detection
 */

import { describe, expect, it } from 'bun:test';
import { isIdentifier } from '../src/ori-sql';

describe('isIdentifier', () => {
	describe('valid identifiers', () => {
		it('should return true when value is a single-element string array', () => {
			expect(isIdentifier(['tableName'])).toBe(true);
		});

		it('should return true when value is a column name array', () => {
			expect(isIdentifier(['uuid'])).toBe(true);
		});

		it('should return true when value is a snake_case identifier', () => {
			expect(isIdentifier(['display_name'])).toBe(true);
		});

		it('should return true when value contains already-quoted identifier', () => {
			expect(isIdentifier(['"user"'])).toBe(true);
		});

		it('should return true when value is an empty string identifier', () => {
			// Edge case - empty string is technically valid syntax
			expect(isIdentifier([''])).toBe(true);
		});
	});

	describe('invalid identifiers', () => {
		it('should return false when value is a plain string', () => {
			expect(isIdentifier('string')).toBe(false);
		});

		it('should return false when value is a number', () => {
			expect(isIdentifier(123)).toBe(false);
		});

		it('should return false when value is null', () => {
			expect(isIdentifier(null)).toBe(false);
		});

		it('should return false when value is undefined', () => {
			expect(isIdentifier(undefined)).toBe(false);
		});

		it('should return false when value is an empty array', () => {
			expect(isIdentifier([])).toBe(false);
		});

		it('should return false when array has two elements', () => {
			expect(isIdentifier(['a', 'b'])).toBe(false);
		});

		it('should return false when array contains a number element', () => {
			expect(isIdentifier([123])).toBe(false);
		});

		it('should return false when array contains an object element', () => {
			expect(isIdentifier([{ column: 'name' }])).toBe(false);
		});

		it('should return false when array contains a null element', () => {
			expect(isIdentifier([null])).toBe(false);
		});

		it('should return false when value is an object', () => {
			expect(isIdentifier({ column: 'name' })).toBe(false);
		});

		it('should return false when value is a boolean', () => {
			expect(isIdentifier(true)).toBe(false);
		});

		it('should return false when array is nested', () => {
			expect(isIdentifier([['nested']])).toBe(false);
		});
	});

	describe('edge cases', () => {
		it('should return false when value is an array-like object with length 1', () => {
			const arrayLike = { 0: 'value', length: 1 };
			expect(isIdentifier(arrayLike)).toBe(false);
		});

		it('should return true when value is an Array subclass with single string', () => {
			class MyArray<T> extends Array<T> {}
			const arr = new MyArray<string>();
			arr.push('value');
			expect(isIdentifier(arr)).toBe(true);
		});
	});
});
