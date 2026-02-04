/**
 * @orijs/sql - Type-safe SQL interpolation for Bun
 *
 * @example
 * ```typescript
 * import { sql } from 'bun';
 * import { createOriSql } from '@orijs/sql';
 *
 * const oriSql = createOriSql(sql);
 *
 * // Use ${[identifier]} for table/column names
 * // Use ${value} for parameterized values
 * const rows = await oriSql`
 *   SELECT ${['uuid']}, ${['email']}
 *   FROM ${['user']}
 *   WHERE ${['id']} = ${userId}
 * `;
 * ```
 *
 * @security
 * **IMPORTANT**: Identifiers (`${[name]}`) are passed to Bun's sql('identifier')
 * function which provides PostgreSQL-level validation. Invalid identifiers
 * (including SQL injection attempts) are rejected by PostgreSQL.
 *
 * Identifiers should come from trusted sources (e.g., Table definitions),
 * NEVER from user input. User input should always use the value syntax (`${value}`)
 * which is parameterized by Bun's SQL driver.
 *
 * @see ADR-004-sql-interpolation-design.md for design decisions
 */

/**
 * Factory to create oriSql from Bun's sql connection.
 * @see createOriSql in ori-sql.ts for full documentation
 */
export { createOriSql } from './ori-sql';

/**
 * Type guard to check if a value is a SqlIdentifier (single-element string array).
 * @see isIdentifier in ori-sql.ts for full documentation
 */
export { isIdentifier } from './ori-sql';

/**
 * Type representing Bun's SQL function signature.
 * Use this to type your sql parameter when creating oriSql.
 */
export type { BunSqlFunction } from './ori-sql';

/**
 * Single-element string array marking a SQL identifier.
 * Use `${[tableName]}` syntax in oriSql templates.
 */
export type { SqlIdentifier } from './types';

/**
 * Type signature for the oriSql tagged template function.
 * Returned by createOriSql().
 */
export type { OriSqlFactory } from './types';
