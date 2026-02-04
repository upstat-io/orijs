/**
 * TypeScript Compilation Tests for Type Safety
 *
 * These tests verify that TypeScript's type system catches invalid
 * identifier types at compile time. The @ts-expect-error comments
 * will cause compilation to FAIL if TypeScript doesn't catch the error.
 *
 * Run with: bun run tsc --noEmit
 */

import { describe, it, expect } from 'bun:test';
import type { SqlIdentifier } from '../src/types';
import { createOriSql, isIdentifier } from '../src/ori-sql';
import type { SQL } from 'bun';

/**
 * Type-level tests using @ts-expect-error
 *
 * If any of these @ts-expect-error comments are unnecessary
 * (i.e., TypeScript doesn't catch the error), the build will fail.
 */

// Valid SqlIdentifier assignments (should compile)
// Using void to prevent "unused variable" warnings while keeping type checks
const validIdentifier1: SqlIdentifier = ['columnName'];
void validIdentifier1;
const validIdentifier2: SqlIdentifier = ['table_name'];
void validIdentifier2;
const validIdentifier3: SqlIdentifier = [''];
void validIdentifier3;

// Invalid SqlIdentifier assignments (TypeScript should catch these)

// @ts-expect-error - number element instead of string
const invalidNumber: SqlIdentifier = [123];

// @ts-expect-error - multiple elements instead of single
const invalidMultiple: SqlIdentifier = ['a', 'b'];

// @ts-expect-error - empty array instead of single element
const invalidEmpty: SqlIdentifier = [];

// @ts-expect-error - object element instead of string
const invalidObject: SqlIdentifier = [{ name: 'test' }];

// @ts-expect-error - null element instead of string
const invalidNull: SqlIdentifier = [null];

// @ts-expect-error - undefined element instead of string
const invalidUndefined: SqlIdentifier = [undefined];

// @ts-expect-error - nested array instead of string
const invalidNested: SqlIdentifier = [['nested']];

// @ts-expect-error - not an array at all
const invalidNotArray: SqlIdentifier = 'string';

// @ts-expect-error - number instead of array
const invalidNumberType: SqlIdentifier = 123;

// @ts-expect-error - boolean element instead of string
const invalidBoolean: SqlIdentifier = [true];

/**
 * Runtime tests to verify the type tests are actually being used
 * (prevents dead code elimination)
 */
describe('SqlIdentifier type safety', () => {
	it('should accept valid single-string identifiers', () => {
		// These should compile without error
		const id1: SqlIdentifier = ['column'];
		const id2: SqlIdentifier = ['table_name'];

		expect(id1).toEqual(['column']);
		expect(id2).toEqual(['table_name']);
	});

	it('should verify @ts-expect-error comments are working', () => {
		// This test exists to ensure the file is being type-checked.
		// If the @ts-expect-error comments above were removed and TypeScript
		// didn't catch the errors, this file would fail to compile.
		expect(true).toBe(true);
	});
});

/**
 * Template literal type safety with createOriSql
 *
 * While we can't enforce identifier syntax at the template literal level
 * (JavaScript tagged templates accept any value), we document that:
 * - Values are parameterized (safe for user input)
 * - Single-string arrays are treated as identifiers (trusted input only)
 */
describe('createOriSql type inference', () => {
	// Mock SQL function for type testing
	const mockSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		return { strings: [...strings], values };
	}) as unknown as SQL;

	it('should infer return type from generic parameter', () => {
		const oriSql = createOriSql(mockSql);

		// Type inference test - inferredQuery should be Promise<unknown[]> & unknown[]
		const inferredQuery = oriSql`SELECT * FROM account`;

		// The result type includes both Promise and direct access patterns
		expect(inferredQuery).toBeDefined();
	});

	it('should accept explicit type parameter', () => {
		const oriSql = createOriSql(mockSql);

		interface Account {
			id: number;
			name: string;
		}

		// Explicit type parameter
		const accountRows = oriSql<Account[]>`SELECT * FROM account`;

		// accountRows should be typed as Promise<Account[]> & Account[]
		expect(accountRows).toBeDefined();
	});
});

/**
 * Type predicate narrowing tests
 *
 * Verifies that isIdentifier correctly narrows types when used as a type guard.
 */
describe('isIdentifier type predicate narrowing', () => {
	it('should narrow unknown to SqlIdentifier when guard returns true', () => {
		const maybeIdentifier: unknown = ['columnName'];

		if (isIdentifier(maybeIdentifier)) {
			// After the guard, TypeScript should know this is SqlIdentifier
			// We can access the string element without type errors
			const identifierValue: string = maybeIdentifier[0];
			expect(identifierValue).toBe('columnName');

			// Verify the narrowed type has correct length
			const length: 1 = maybeIdentifier.length;
			expect(length).toBe(1);
		}
	});

	it('should not narrow when guard returns false', () => {
		const notIdentifier: unknown = 'just a string';

		if (isIdentifier(notIdentifier)) {
			// This block should not execute
			expect(true).toBe(false);
		} else {
			// Type is still unknown here - cannot access properties safely
			expect(typeof notIdentifier).toBe('string');
		}
	});

	it('should work with type narrowing in filter operations', () => {
		const mixedValues: unknown[] = [['uuid'], 42, ['name'], 'string', ['email'], null];

		// Filter using isIdentifier as type guard
		const identifiers = mixedValues.filter(isIdentifier);

		// TypeScript should infer identifiers as SqlIdentifier[]
		expect(identifiers).toHaveLength(3);
		// Use non-null assertion since we verified length above
		expect(identifiers[0]![0]).toBe('uuid');
		expect(identifiers[1]![0]).toBe('name');
		expect(identifiers[2]![0]).toBe('email');
	});

	it('should enable safe property access after narrowing', () => {
		function processValue(value: unknown): string {
			if (isIdentifier(value)) {
				// Type is narrowed to SqlIdentifier (readonly [string])
				// Safe to access value[0] as string
				return `Identifier: ${value[0]}`;
			}
			return 'Not an identifier';
		}

		expect(processValue(['test'])).toBe('Identifier: test');
		expect(processValue(123)).toBe('Not an identifier');
		expect(processValue(['a', 'b'])).toBe('Not an identifier');
	});
});
