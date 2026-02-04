/**
 * Type definitions for OriSQL
 *
 * Uses array syntax ${[identifier]} for SQL identifiers (tables, columns)
 * Regular interpolation ${value} for parameterized values
 */

/**
 * Single-element string array marks SQL identifier.
 * O(1) detection via Array.isArray check.
 *
 * @example
 * ```typescript
 * // Using with oriSql template - identifies table/column names
 * const table: SqlIdentifier = ['account'];
 * const column: SqlIdentifier = ['uuid'];
 * oriSql`SELECT ${column} FROM ${table}`;
 *
 * // With Table definitions (recommended)
 * const Tables = { User: { $name: 'user', uuid: 'uuid' } };
 * oriSql`SELECT ${[Tables.User.uuid]} FROM ${[Tables.User.$name]}`;
 * ```
 */
export type SqlIdentifier = readonly [string];

/**
 * Factory function signature for oriSql tagged template.
 *
 * Returns `Promise<T> & T` to match Bun's SQL thenable pattern:
 * - Can be awaited: `const rows = await oriSql\`...\``
 * - Can access array properties directly: `oriSql\`...\`.length`
 *
 * This intersection type mirrors Bun's native `sql` return type.
 * Generic T is required - no default to enforce explicit typing.
 *
 * @example
 * ```typescript
 * import { createOriSql, type OriSqlFactory } from '@orijs/sql';
 * import { SQL } from 'bun';
 *
 * const sql = new SQL({ url: process.env.DATABASE_URL });
 * const oriSql: OriSqlFactory = createOriSql(sql);
 *
 * // SELECT queries - specify array type
 * type User = { id: number; name: string };
 * const users = await oriSql<User[]>`SELECT * FROM users`;
 * users[0].name; // string
 *
 * // INSERT/UPDATE/DELETE - specify command result type
 * type SqlResult = { count: number };
 * const result = await oriSql<SqlResult>`DELETE FROM users WHERE id = ${id}`;
 * result.count; // number
 * ```
 */
export type OriSqlFactory = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T> & T;
