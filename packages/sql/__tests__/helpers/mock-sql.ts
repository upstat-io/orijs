/**
 * Shared mock SQL function for tests.
 *
 * Creates a mock that captures template strings and values for inspection.
 * Supports both Bun SQL calling patterns:
 * 1. Tagged template: mock`SELECT * FROM users`
 * 2. Identifier function: mock('tablename')
 */

import type { BunSqlFunction } from '../../src/ori-sql';

/**
 * Marker object returned by mock('identifier') calls.
 * Allows tests to verify which identifiers were used.
 */
export interface IdentifierMarker {
	__isIdentifier: true;
	name: string;
}

export interface MockSqlLastCall {
	strings: readonly string[];
	values: unknown[];
}

export interface MockSql extends BunSqlFunction {
	lastCall: MockSqlLastCall | null;
	/** Returns true if value is an identifier marker from mock('identifier') */
	isIdentifierMarker(value: unknown): value is IdentifierMarker;
}

/**
 * Create a mock SQL function that supports both template and identifier modes.
 *
 * @example
 * ```typescript
 * const mockSql = createMockSql();
 * const oriSql = createOriSql(mockSql);
 *
 * oriSql`SELECT ${['column']} FROM ${['table']} WHERE id = ${42}`;
 *
 * expect(mockSql.lastCall!.strings).toEqual(['SELECT ', ' FROM ', ' WHERE id = ', '']);
 * expect(mockSql.lastCall!.values[0]).toMatchObject({ __isIdentifier: true, name: 'column' });
 * expect(mockSql.lastCall!.values[1]).toMatchObject({ __isIdentifier: true, name: 'table' });
 * expect(mockSql.lastCall!.values[2]).toBe(42);
 * ```
 */
export function createMockSql(): MockSql {
	const mock = function (stringsOrIdentifier: TemplateStringsArray | string, ...values: unknown[]) {
		// Identifier mode: mock('identifier') returns a marker object
		if (typeof stringsOrIdentifier === 'string') {
			return { __isIdentifier: true, name: stringsOrIdentifier } as IdentifierMarker;
		}

		// Template mode: mock`...` captures the call and returns Promise like Bun SQL
		mock.lastCall = {
			strings: [...stringsOrIdentifier],
			values: [...values]
		};
		// Return a Promise that resolves to empty array, matching Bun SQL's return type
		return Promise.resolve([]) as unknown;
	} as MockSql;

	mock.lastCall = null;
	mock.isIdentifierMarker = (value: unknown): value is IdentifierMarker => {
		return (
			typeof value === 'object' &&
			value !== null &&
			'__isIdentifier' in value &&
			(value as IdentifierMarker).__isIdentifier === true
		);
	};

	return mock;
}
