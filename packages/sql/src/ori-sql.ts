/**
 * OriSQL - Type-Safe SQL Interpolation
 *
 * Wraps Bun's sql tagged template to support type-safe identifiers.
 *
 * Syntax:
 * - ${[identifier]} → table/column name (uses Bun's native sql() identifier handling)
 * - ${value} → parameterized value (SQL injection safe)
 *
 * Security: Identifiers are passed to Bun's sql('identifier') function which
 * delegates validation to PostgreSQL. Invalid identifiers (including SQL injection
 * attempts) are rejected by PostgreSQL with "column does not exist" errors.
 */

import type { OriSqlFactory, SqlIdentifier } from './types';

/**
 * Bun SQL function type supporting both template and identifier modes.
 *
 * Bun's sql has two calling patterns:
 * 1. Tagged template: sql`SELECT * FROM users` - executes query
 * 2. Identifier function: sql('tablename') - creates safe identifier reference
 *
 * Exported for consumers who need to type their sql parameter.
 */
export interface BunSqlFunction {
	/** Tagged template mode - executes SQL query */
	(strings: TemplateStringsArray, ...values: unknown[]): unknown;
	/** Identifier mode - creates safe identifier reference for interpolation */
	(identifier: string): unknown;
}

/**
 * Check if value is an identifier marker.
 * O(1) Array.isArray check + O(1) length and type checks.
 *
 * @param value - Value to check (any type)
 * @returns true if value is a single-element string array (SqlIdentifier)
 *
 * @example
 * ```typescript
 * isIdentifier(['columnName']);  // true - valid identifier marker
 * isIdentifier(['a', 'b']);      // false - multi-element array
 * isIdentifier('string');        // false - not an array
 * isIdentifier([123]);           // false - element not a string
 * isIdentifier([]);              // false - empty array
 * ```
 */
export function isIdentifier(value: unknown): value is SqlIdentifier {
	return Array.isArray(value) && value.length === 1 && typeof value[0] === 'string';
}

/**
 * Create an oriSql tagged template function bound to a Bun SQL connection.
 *
 * Uses Bun's native sql('identifier') function for SQL identifiers, which provides:
 * - Automatic quoting of reserved words
 * - PostgreSQL-level validation (invalid identifiers rejected with "column does not exist")
 * - SQL injection protection (malicious identifiers rejected by PostgreSQL)
 *
 * @param bunSql - Bun's sql tagged template function
 * @returns oriSql function that supports identifier markers
 *
 * @throws Propagates any errors from Bun's sql function. Common error scenarios:
 *         - Connection errors: Check `error.code` for PostgreSQL error codes
 *         - Invalid identifiers: Code `42703` (undefined_column) or `42601` (syntax_error)
 *         - Constraint violations: Code `23505` (unique_violation), `23503` (foreign_key_violation)
 *         - Query syntax: Code `42601` (syntax_error)
 *         Errors are native Bun/PostgreSQL errors - catch and check `error.code` for handling.
 *
 * @example
 * ```typescript
 * import { sql } from 'bun';
 * import { createOriSql } from '@orijs/sql';
 *
 * // Define table/column names (typically from your schema definitions)
 * const Tables = {
 *   User: { $name: 'user', uuid: 'uuid', email: 'email', id: 'id' }
 * } as const;
 *
 * const oriSql = createOriSql(sql);
 *
 * // Type-safe query - identifiers use ${[name]} syntax
 * const userId = 42;
 * const rows = await oriSql`
 *   SELECT ${[Tables.User.uuid]}, ${[Tables.User.email]}
 *   FROM ${[Tables.User.$name]}
 *   WHERE ${[Tables.User.id]} = ${userId}
 * `;
 * // Identifiers are passed to Bun's sql('identifier') for native handling
 * // Reserved words like "user" are automatically quoted by PostgreSQL
 * ```
 */
export function createOriSql(bunSql: BunSqlFunction): OriSqlFactory {
	return function oriSql<T>(strings: TemplateStringsArray, ...values: unknown[]) {
		// Convert identifier markers to Bun SQL identifier fragments
		const convertedValues = values.map((value) => {
			if (isIdentifier(value)) {
				// Use Bun's native identifier handling: sql('identifier')
				// This provides PostgreSQL-level validation and SQL injection protection
				return bunSql(value[0]);
			}
			return value;
		});

		// Pass the original template structure to Bun SQL
		// Bun handles both regular values (parameterized) and identifier fragments
		return bunSql(strings, ...convertedValues) as Promise<T> & T;
	} as OriSqlFactory;
}
