/**
 * Mapper Type Definitions
 *
 * All interfaces and type definitions for the fluent mapper API.
 * This file contains no runtime code - only type definitions.
 */

import type { FieldType } from './types';

// --- TABLE DEFINITION TYPES ---

/**
 * A field definition with resolved column name.
 */
export interface ResolvedFieldDef {
	readonly property: string;
	readonly column: string;
	readonly type: FieldType;
	readonly optional: boolean;
	readonly defaultValue?: unknown;
}

/**
 * A flattened table definition ready for mapper use.
 */
export interface FlattenedTable {
	readonly $name: string;
	readonly $fields: Readonly<Record<string, ResolvedFieldDef>>;
}

// --- MAPPER OPTIONS ---

/**
 * Options for mapping operations.
 */
export interface MapOptions {
	/** Column name prefix for join queries (e.g., 'user_' for user_uuid, user_email) */
	prefix?: string;
}

// --- MAP RESULT INTERFACE ---

/**
 * Fluent result wrapper for map operations.
 * Allows chaining .mergeWhen() and .default() for cleaner mapper functions.
 *
 * @example
 * ```typescript
 * // Simple mapping with null default
 * const user = UserMapper.map(row).default(null);
 *
 * // Conditional merge with null default
 * const user = UserMapper.map(row, { prefix })
 *   .mergeWhen(!!extra, extra)
 *   .default(null);
 * ```
 */
export interface MapResult<T> {
	/**
	 * Conditionally merge additional fields into the result.
	 * Only merges if condition is true and result is not undefined.
	 *
	 * @param condition - When true, merge the extra fields
	 * @param extra - Partial object to merge into result
	 */
	mergeWhen(condition: boolean, extra: Partial<T> | undefined): MapResult<T>;

	/**
	 * Return the result or a default value if undefined.
	 * Terminates the chain.
	 *
	 * @param defaultValue - Value to return if result is undefined
	 */
	default<D>(defaultValue: D): T | D;

	/**
	 * Get the raw result value.
	 * Terminates the chain.
	 */
	value(): T | undefined;
}

// --- BUILT MAPPER INTERFACE ---

/**
 * A built mapper that can map rows to objects.
 */
export interface BuiltMapper<T> {
	/**
	 * Map a single database row to an object.
	 * Returns a MapResult for fluent chaining.
	 *
	 * @example
	 * ```typescript
	 * // Get value directly
	 * const user = UserMapper.map(row).value();
	 *
	 * // With default
	 * const user = UserMapper.map(row).default(null);
	 *
	 * // With conditional merge
	 * const user = UserMapper.map(row)
	 *   .mergeWhen(!!extra, extra)
	 *   .default(null);
	 * ```
	 */
	map(row: unknown, options?: MapOptions): MapResult<T>;

	/**
	 * Map multiple database rows to objects.
	 * Filters out null/undefined results.
	 */
	mapMany(rows: unknown[], options?: MapOptions): T[];
}

// --- MAPPER BUILDER INTERFACES ---

/**
 * Builder for configuring a mapper.
 */
export interface MapperBuilder<T> {
	/**
	 * Build the mapper with current configuration.
	 */
	build(): BuiltMapper<T>;

	/**
	 * Pick specific fields from another table (for JOINs).
	 * Primary table fields are always included via Mapper.for().
	 *
	 * @param table - The table to pick fields from
	 * @param fields - Field names to include from that table
	 * @returns PickBuilder to optionally specify column prefix
	 *
	 * @example
	 * ```typescript
	 * // Without prefix (columns have unique names)
	 * Mapper.for<UserWithAccount>(UserTable)
	 *   .pick(AccountTable, 'id', 'displayName')
	 *   .build();
	 *
	 * // With prefix (for aliased columns in JOINs)
	 * Mapper.for<UserWithAccount>(UserTable)
	 *   .pick(AccountTable, 'id', 'uuid').prefix('account_')
	 *   .build();
	 * ```
	 */
	pick(table: FlattenedTable, ...fields: string[]): PickBuilder<T>;

	/**
	 * Parse a JSON column and cast to a type.
	 * Use for aggregated JSON arrays/objects from queries.
	 *
	 * @param column - The column name containing JSON data
	 * @param factory - Optional factory to transform raw JSON (e.g., snake_case to camelCase)
	 * @returns JsonBuilder to optionally rename the property
	 *
	 * @example
	 * ```typescript
	 * // Simple passthrough
	 * Mapper.for<UserWithProjects>(UserTable)
	 *   .json<ProjectRole[]>('project_roles')
	 *   .build();
	 *
	 * // With transformation factory
	 * Mapper.for<UserWithProjects>(UserTable)
	 *   .json<ProjectRole[]>('project_roles', mapProjectRoles)
	 *   .build();
	 * ```
	 */
	json<J>(column: string, factory?: (raw: unknown) => J | null | undefined): JsonBuilder<T, J>;

	/**
	 * Map a raw column (calculated, aggregated, or from JOIN).
	 * Use for columns that don't belong to any table definition.
	 *
	 * @param propertyName - The property name on the result object
	 * @param columnOrCompute - Column name (defaults to snake_case of propertyName) OR compute function
	 * @returns ColBuilder to optionally set default value
	 *
	 * @example
	 * ```typescript
	 * Mapper.for<UserProfile>(UserTable)
	 *   // Column inferred from property name (camelCase → snake_case)
	 *   .col<number>('activeOrderCount').default(0)  // → 'active_order_count'
	 *   .col<boolean>('isOnCall').default(false)        // → 'is_on_call'
	 *   // Or explicit column name when it differs
	 *   .col<string>('createdBy', 'author_uuid')
	 *   // Or computed from row (for derived/nested values)
	 *   .col<string>('name', (row) => row.payload?.title || '')
	 *   .col<string>('description', (row) => row.payload?.description || '')
	 *   .build();
	 * ```
	 */
	col<C>(
		propertyName: string,
		columnOrCompute?: string | ((row: Record<string, unknown>) => C | null | undefined)
	): ColBuilder<T, C>;

	/**
	 * Embed a related object from prefixed columns.
	 */
	embed(key: string, table: FlattenedTable): EmbedBuilder<T>;

	/**
	 * Omit specific fields from the primary table.
	 * Use when the target type doesn't include certain table fields (e.g., Omit<T, 'id'>).
	 *
	 * @param fields - Property names to exclude from mapping
	 * @returns MapperBuilder for chaining
	 *
	 * @example
	 * ```typescript
	 * // Map to ProjectWithoutIds (excludes id and accountId)
	 * Mapper.for<ProjectWithoutIds>(ProjectTable)
	 *   .omit('id', 'accountId')
	 *   .build();
	 * ```
	 */
	omit(...fields: string[]): MapperBuilder<T>;

	/**
	 * Reference a field from the primary table to rename it.
	 * Uses the table's field definition for type coercion.
	 *
	 * @param fieldName - The field name in the table
	 * @returns FieldRenameBuilder to specify the new property name
	 *
	 * @example
	 * ```typescript
	 * // Map table field 'id' to property 'userId'
	 * Mapper.for<UserWithAccount>(UserTable)
	 *   .field('id').as('userId')
	 *   .build();
	 * ```
	 */
	field(fieldName: string): FieldRenameBuilder<T>;

	/**
	 * Transform a field value after type coercion.
	 * Use for post-processing like converting null to undefined or formatting values.
	 *
	 * @param propertyName - The property name on the result object
	 * @param fn - Transform function receiving the coerced value
	 * @returns MapperBuilder for chaining
	 *
	 * @example
	 * ```typescript
	 * // Convert null logoUrl to undefined
	 * Mapper.for<Account>(AccountTable)
	 *   .transform('logoUrl', v => v || undefined)
	 *   .build();
	 *
	 * // Format a date field
	 * Mapper.for<Event>(EventTable)
	 *   .transform('scheduledAt', v => v instanceof Date ? v.toISOString() : v)
	 *   .build();
	 * ```
	 */
	transform<K extends keyof T>(propertyName: K, fn: (value: T[K]) => T[K]): MapperBuilder<T>;
}

/**
 * Builder for renaming a field from the primary table.
 */
export interface FieldRenameBuilder<T> {
	/**
	 * Map the field to a different property name.
	 */
	as(propertyName: string): MapperBuilder<T>;
}

/**
 * Builder for configuring picked fields.
 */
export interface PickBuilder<T> extends MapperBuilder<T> {
	/**
	 * Specify a column prefix for the picked fields.
	 * Use when JOIN aliases columns with a prefix (e.g., account_id, account_uuid).
	 */
	prefix(prefixStr: string): MapperBuilder<T>;
}

/**
 * Builder for configuring JSON column mapping.
 */
export interface JsonBuilder<T, J> extends MapperBuilder<T> {
	/**
	 * Rename the property on the result object.
	 * By default, uses the column name as property name.
	 * Returns JsonBuilder to allow chaining with .default() or .optional().
	 *
	 * @example
	 * ```typescript
	 * // Chain .as() and .default()
	 * .json<Item[]>('items', mapItems).as('lineItems').default([])
	 *
	 * // Chain .as() and .optional()
	 * .json<Item[]>('items').as('lineItems').optional()
	 * ```
	 */
	as(propertyName: string): JsonBuilder<T, J>;

	/**
	 * Set a default value when JSON column is null/undefined.
	 */
	default(value: J): MapperBuilder<T>;

	/**
	 * Mark the JSON column as optional (returns undefined when null).
	 * Use this instead of including `| undefined` in the type parameter.
	 *
	 * @example
	 * ```typescript
	 * // Instead of verbose type annotation:
	 * .json<ProjectRole[] | undefined>('project_roles')
	 *
	 * // Use .optional():
	 * .json<ProjectRole[]>('project_roles').optional()
	 * ```
	 */
	optional(): MapperBuilder<T>;
}

/**
 * Builder for configuring raw column mapping.
 */
export interface ColBuilder<T, C> extends MapperBuilder<T> {
	/**
	 * Set a default value when column is null/undefined.
	 */
	default(value: C): MapperBuilder<T>;

	/**
	 * Mark the column as optional (returns undefined when null).
	 * Use instead of `.default(undefined)`.
	 */
	optional(): MapperBuilder<T>;
}

/**
 * Builder for configuring an embedded object.
 * Extends MapperBuilder so .build() can be called without .prefix() for direct column mapping.
 */
export interface EmbedBuilder<T> extends MapperBuilder<T> {
	/**
	 * Specify the column prefix for embedded fields.
	 * Use when JOIN aliases columns with a prefix (e.g., user_uuid, user_email).
	 *
	 * If not called, columns are read directly using the sub-table's column names.
	 * This is useful for nesting flat columns into a structured object.
	 *
	 * @example
	 * ```typescript
	 * // With prefix (for JOINs with aliased columns)
	 * Mapper.for<CommentWithUser>(CommentTable)
	 *   .embed('user', UserTable).prefix('user_')
	 *   .build();
	 *
	 * // Without prefix (for nesting flat columns)
	 * const UsageTable = Mapper.defineTable({
	 *   seats: field('seats_usage').number(),
	 *   products: field('products_usage').number(),
	 * });
	 * Mapper.for<AccountEntitlement>(EntitlementTable)
	 *   .embed('usage', UsageTable)
	 *   .build();
	 * ```
	 */
	prefix(prefixStr: string): MapperBuilder<T>;
}

// --- INTERNAL CONFIG TYPES ---
// These types are used internally by the mapper module for builder-to-runtime communication.
// They are NOT exported from index.ts and should NOT be used by external consumers.
// The `export` keyword is required for cross-file imports within the mapper module.

/** @internal - Pick configuration for joined table fields */
export interface PickConfig {
	table: FlattenedTable;
	fields: string[];
	prefix: string;
}

/** @internal - JSON column configuration */
export interface JsonConfig {
	column: string;
	propertyName: string;
	factory?: (raw: unknown) => unknown;
	defaultValue?: unknown;
	isOptional?: boolean;
}

/** @internal - Raw column configuration */
export interface ColConfig {
	column: string;
	propertyName: string;
	defaultValue?: unknown;
	isOptional?: boolean;
	/** Compute function for derived values (e.g., extracting from nested JSON) */
	computeFn?: (row: Record<string, unknown>) => unknown;
}

/** @internal - Embedded object configuration */
export interface EmbedConfig {
	key: string;
	table: FlattenedTable;
	prefix: string;
}

/** @internal - Field rename configuration */
export interface FieldRenameConfig {
	fieldName: string;
	propertyName: string;
}

/** @internal - Field transform configuration */
export interface TransformConfig {
	propertyName: string;
	fn: (value: unknown) => unknown;
}

/**
 * @internal - Complete mapper configuration passed from builder to runtime.
 * Groups all builder configuration into a single object to reduce constructor parameters.
 */
export interface MapperConfig {
	readonly table: FlattenedTable;
	readonly picks: readonly PickConfig[];
	readonly jsons: readonly JsonConfig[];
	readonly cols: readonly ColConfig[];
	readonly embeds: readonly EmbedConfig[];
	readonly omits: Set<string>;
	readonly fieldRenames: readonly FieldRenameConfig[];
	readonly transforms: readonly TransformConfig[];
	readonly includes: Set<string> | undefined;
}
