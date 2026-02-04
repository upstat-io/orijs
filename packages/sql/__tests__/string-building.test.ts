/**
 * Unit tests for oriSql
 *
 * Tests that createOriSql correctly converts identifier markers to Bun SQL
 * identifier calls while passing regular values through for parameterization.
 */

import { describe, expect, it } from 'bun:test';
import { createOriSql } from '../src/ori-sql';
import { createMockSql } from './helpers/mock-sql';

// Note: isIdentifier unit tests are in identifier-detection.test.ts

describe('createOriSql', () => {
	describe('identifier conversion', () => {
		it('should convert identifier marker to bunSql() call', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT ${['uuid']} FROM account`;

			expect(mockSql.lastCall).not.toBeNull();
			// Original template strings preserved
			expect(mockSql.lastCall!.strings).toEqual(['SELECT ', ' FROM account']);
			// Identifier converted to marker object via bunSql('uuid')
			expect(mockSql.lastCall!.values).toHaveLength(1);
			expect(mockSql.isIdentifierMarker(mockSql.lastCall!.values[0])).toBe(true);
			expect((mockSql.lastCall!.values[0] as any).name).toBe('uuid');
		});

		it('should convert multiple identifiers', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT ${['uuid']}, ${['name']} FROM ${['account']}`;

			expect(mockSql.lastCall!.strings).toEqual(['SELECT ', ', ', ' FROM ', '']);
			expect(mockSql.lastCall!.values).toHaveLength(3);
			expect((mockSql.lastCall!.values[0] as any).name).toBe('uuid');
			expect((mockSql.lastCall!.values[1] as any).name).toBe('name');
			expect((mockSql.lastCall!.values[2] as any).name).toBe('account');
		});

		it('should pass reserved words to Bun for handling', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			// 'user' is a reserved word - Bun/PostgreSQL will handle quoting
			oriSql`SELECT * FROM ${['user']}`;

			expect(mockSql.lastCall!.values).toHaveLength(1);
			expect((mockSql.lastCall!.values[0] as any).name).toBe('user');
		});
	});

	describe('parameter passthrough', () => {
		it('should pass regular values through unchanged', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM account WHERE id = ${42}`;

			expect(mockSql.lastCall!.strings).toEqual(['SELECT * FROM account WHERE id = ', '']);
			expect(mockSql.lastCall!.values).toEqual([42]);
		});

		it('should handle multiple parameters', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM account WHERE name = ${'Test'} AND id = ${42}`;

			expect(mockSql.lastCall!.values).toEqual(['Test', 42]);
		});

		it('should handle null and undefined', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`UPDATE account SET a = ${null}, b = ${undefined}`;

			expect(mockSql.lastCall!.values).toEqual([null, undefined]);
		});

		it('should treat multi-element array as parameter', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM account WHERE tags = ${['a', 'b']}`;

			expect(mockSql.lastCall!.values).toEqual([['a', 'b']]);
			expect(mockSql.isIdentifierMarker(mockSql.lastCall!.values[0])).toBe(false);
		});

		it('should treat empty array as parameter', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM account WHERE tags = ${[]}`;

			expect(mockSql.lastCall!.values).toEqual([[]]);
		});

		it('should treat array with non-string element as parameter', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM account WHERE id = ${[123]}`;

			expect(mockSql.lastCall!.values).toEqual([[123]]);
		});
	});

	describe('mixed identifiers and parameters', () => {
		it('should handle identifiers and parameters together', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT ${['uuid']} FROM ${['account']} WHERE ${['id']} = ${42}`;

			expect(mockSql.lastCall!.strings).toEqual(['SELECT ', ' FROM ', ' WHERE ', ' = ', '']);
			expect(mockSql.lastCall!.values).toHaveLength(4);
			// First 3 are identifiers
			expect(mockSql.isIdentifierMarker(mockSql.lastCall!.values[0])).toBe(true);
			expect(mockSql.isIdentifierMarker(mockSql.lastCall!.values[1])).toBe(true);
			expect(mockSql.isIdentifierMarker(mockSql.lastCall!.values[2])).toBe(true);
			// Last is a regular value
			expect(mockSql.lastCall!.values[3]).toBe(42);
		});

		it('should handle complex query with joins', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const userId = 42;

			oriSql`
				SELECT u.${['uuid']}, a.${['name']}
				FROM ${['user']} u
				INNER JOIN ${['account']} a ON a.${['id']} = u.${['account_id']}
				WHERE u.${['id']} = ${userId}
			`;

			// All identifiers should be converted to markers
			const identifiers = mockSql.lastCall!.values.filter((v) => mockSql.isIdentifierMarker(v));
			expect(identifiers).toHaveLength(7); // uuid, name, user, account, id, account_id, id

			// The parameter value should be passed through
			const params = mockSql.lastCall!.values.filter((v) => !mockSql.isIdentifierMarker(v));
			expect(params).toEqual([42]);
		});
	});

	describe('edge cases', () => {
		it('should handle query with no interpolations', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT 1`;

			expect(mockSql.lastCall!.strings).toEqual(['SELECT 1']);
			expect(mockSql.lastCall!.values).toEqual([]);
		});

		it('should handle query with only identifiers', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT ${['a']}, ${['b']} FROM ${['c']}`;

			expect(mockSql.lastCall!.values).toHaveLength(3);
			expect(mockSql.lastCall!.values.every((v) => mockSql.isIdentifierMarker(v))).toBe(true);
		});

		it('should handle query with only parameters', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM account WHERE id = ${1} AND name = ${'test'}`;

			expect(mockSql.lastCall!.values).toEqual([1, 'test']);
		});

		it('should preserve template string structure', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT ${['uuid']}
FROM ${['account']}
WHERE ${['id']} = ${1}`;

			// Newlines should be preserved in strings
			expect(mockSql.lastCall!.strings[1]).toContain('\n');
		});
	});

	describe('SQL injection safety', () => {
		it('should parameterize values preventing SQL injection', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const userInput = "'; DROP TABLE users; --";

			oriSql`SELECT * FROM account WHERE name = ${userInput}`;

			// Value is passed to Bun for parameterization, not in SQL string
			expect(mockSql.lastCall!.strings.join('')).not.toContain('DROP');
			expect(mockSql.lastCall!.values).toEqual([userInput]);
		});

		it('should pass identifiers to Bun sql() for validation', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			// Even malicious identifiers are passed to Bun's sql() function
			// Bun + PostgreSQL will reject invalid identifiers
			const maliciousIdentifier = 'id; DROP TABLE users; --';

			oriSql`SELECT ${[maliciousIdentifier]} FROM account`;

			// The identifier is passed to bunSql() which creates a marker
			// PostgreSQL will reject this with "column does not exist"
			expect(mockSql.isIdentifierMarker(mockSql.lastCall!.values[0])).toBe(true);
			expect((mockSql.lastCall!.values[0] as any).name).toBe(maliciousIdentifier);
		});
	});

	describe('error handling', () => {
		it('should propagate errors from underlying sql function', () => {
			const errorSql = () => {
				throw new Error('Database connection failed');
			};
			const oriSql = createOriSql(errorSql as any);

			expect(() => oriSql`SELECT * FROM account`).toThrow('Database connection failed');
		});
	});
});
