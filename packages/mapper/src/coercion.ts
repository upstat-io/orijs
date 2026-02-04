/**
 * Type Coercion Functions
 *
 * Functions that require table/column context throw MapperError on invalid values.
 * coerceBoolean is a simple truthiness check with no error context needed.
 *
 * @example
 * ```typescript
 * coerceNumber('25', 'user', 'age');     // -> 25
 * coerceNumber('abc', 'user', 'age');    // throws MapperError
 * coerceDate('2024-01-01', 'u', 'c');    // -> Date
 * coerceString('hello', 'u', 'c');       // -> 'hello'
 * coerceBoolean(null);                   // -> false (simple truthiness)
 * ```
 */

import { MapperError } from './mapper-error';

/**
 * Coerce a value to a number.
 * Throws MapperError if the value cannot be converted or results in NaN.
 *
 * @param value - Value to coerce
 * @param table - Table name for error context
 * @param column - Column name for error context
 * @returns The coerced number
 * @throws MapperError if value is null, undefined, or results in NaN
 */
export function coerceNumber(value: unknown, table: string, column: string): number {
	if (value === null || value === undefined) {
		throw new MapperError(table, column, 'cannot coerce null/undefined', 'number', value);
	}

	if (typeof value === 'number') {
		if (Number.isNaN(value)) {
			throw new MapperError(table, column, 'value is NaN', 'number', value);
		}
		return value;
	}

	if (typeof value === 'string') {
		if (value === '') {
			throw new MapperError(table, column, 'cannot coerce empty string', 'number', value);
		}
		const num = Number(value);
		if (Number.isNaN(num)) {
			throw new MapperError(table, column, 'coercion failed', 'number', value);
		}
		return num;
	}

	// Try converting other types
	const num = Number(value);
	if (Number.isNaN(num)) {
		throw new MapperError(table, column, 'coercion failed', 'number', value);
	}
	return num;
}

/**
 * Coerce a value to a Date.
 * Throws MapperError if the value cannot be converted or results in Invalid Date.
 *
 * @param value - Value to coerce (string, number timestamp, or Date)
 * @param table - Table name for error context
 * @param column - Column name for error context
 * @returns The coerced Date
 * @throws MapperError if value is null, undefined, or results in Invalid Date
 */
export function coerceDate(value: unknown, table: string, column: string): Date {
	if (value === null || value === undefined) {
		throw new MapperError(table, column, 'cannot coerce null/undefined', 'date', value);
	}

	// Already a Date - return as-is
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new MapperError(table, column, 'invalid Date object', 'date', value);
		}
		return value;
	}

	// Empty string is invalid
	if (value === '') {
		throw new MapperError(table, column, 'cannot coerce empty string', 'date', value);
	}

	// Number (timestamp)
	if (typeof value === 'number') {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			throw new MapperError(table, column, 'invalid timestamp', 'date', value);
		}
		return date;
	}

	// String (ISO date or other format)
	if (typeof value === 'string') {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			throw new MapperError(table, column, 'invalid date string', 'date', value);
		}
		return date;
	}

	throw new MapperError(table, column, 'unsupported type for date coercion', 'date', value);
}

/**
 * Coerce a value to a boolean using JavaScript truthiness.
 * - Falsy values (null, undefined, 0, '', false, NaN) -> false
 * - Truthy values (1, 'yes', true, {}, []) -> true
 *
 * @param value - Value to coerce
 * @returns The coerced boolean
 */
export function coerceBoolean(value: unknown): boolean {
	return Boolean(value);
}

/**
 * Coerce a value to a string.
 * Throws MapperError if the value is null or undefined.
 *
 * @param value - Value to coerce
 * @param table - Table name for error context
 * @param column - Column name for error context
 * @returns The coerced string
 * @throws MapperError if value is null or undefined
 */
export function coerceString(value: unknown, table: string, column: string): string {
	if (value === null || value === undefined) {
		throw new MapperError(table, column, 'cannot coerce null/undefined', 'string', value);
	}

	if (typeof value === 'string') {
		return value;
	}

	return String(value);
}
