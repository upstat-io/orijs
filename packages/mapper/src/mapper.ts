/**
 * Mapper Factory
 *
 * Factory for creating table definitions and mappers.
 *
 * @example
 * ```typescript
 * const Tables = Mapper.defineTables({
 *   User: {
 *     tableName: 'user',
 *     uuid: field('uuid').string(),
 *     displayName: field('display_name').string().optional(),
 *   },
 * });
 *
 * const UserMapper = Mapper.for<User>(Tables.User).build();
 * const user = UserMapper.map(row);
 * ```
 */

import type { FieldBuilder, TableDefInput } from './types';
import type { FlattenedTable, ResolvedFieldDef, MapperBuilder } from './mapper-types';
import { MapperBuilder as MapperBuilderClass } from './mapper-builder';

// Re-export all types from ./types so they can be accessed through ./mapper
export type {
	FieldBuilder,
	FieldDef,
	FieldType,
	FieldValue,
	TableDefInput,
	TableFieldsInput,
	TableShape,
	StringFieldBuilder,
	NumberFieldBuilder,
	BooleanFieldBuilder,
	DateFieldBuilder,
	AnyFieldBuilder,
	NullableFieldBuilder
} from './types';

// Re-export mapper types
export type {
	ResolvedFieldDef,
	FlattenedTable,
	MapOptions,
	MapResult,
	BuiltMapper,
	MapperBuilder,
	FieldRenameBuilder,
	PickBuilder,
	JsonBuilder,
	ColBuilder,
	EmbedBuilder
} from './mapper-types';

// --- TABLE OUTPUT TYPE ---

/**
 * Output type from defineTables - adds column name properties to FlattenedTable.
 */
export type FlattenedTableOutput<T extends TableDefInput> = FlattenedTable & {
	readonly [K in Exclude<keyof T, 'tableName'>]: string;
};

// --- TABLE PROCESSING ---

/**
 * Type guard to validate FieldBuilder instances.
 */
function isFieldBuilder(value: unknown): value is FieldBuilder {
	return (
		typeof value === 'object' &&
		value !== null &&
		'_def' in value &&
		typeof (value as FieldBuilder)._def === 'object'
	);
}

/**
 * Process a single table definition into a flattened structure.
 */
function flattenTable<T extends TableDefInput>(input: T): FlattenedTableOutput<T> {
	const tableName = input.tableName;
	const fields: Record<string, ResolvedFieldDef> = {};
	const columnNames: Record<string, string> = {};

	for (const key of Object.keys(input)) {
		if (key === 'tableName') continue;

		const value = input[key];
		if (!isFieldBuilder(value)) continue; // Only process FieldBuilder values

		const def = value._def;

		// Column name is always defined (mandatory in field API)
		const column = def.column;

		// Store in fields map - only include defaultValue if actually set
		// (allows distinguishing between "no default" vs "default is null")
		fields[key] =
			'defaultValue' in def
				? {
						property: key,
						column,
						type: def.type,
						optional: def.optional,
						defaultValue: def.defaultValue
					}
				: {
						property: key,
						column,
						type: def.type,
						optional: def.optional
					};

		// Store column name for direct access (e.g., Tables.User.displayName -> 'display_name')
		columnNames[key] = column;
	}

	// Build the output object with $name, $fields, and column name properties
	const result = {
		$name: tableName,
		$fields: Object.freeze(fields),
		...columnNames
	} as FlattenedTableOutput<T>;

	return Object.freeze(result) as FlattenedTableOutput<T>;
}

// --- PUBLIC API ---

/**
 * Mapper factory for creating table definitions and mappers.
 */
export const Mapper = {
	/**
	 * Define tables with flattened column access.
	 *
	 * @param tables - Object with table definitions
	 * @returns Object with flattened tables (access column names directly)
	 *
	 * @example
	 * ```typescript
	 * const Tables = Mapper.defineTables({
	 *   User: {
	 *     tableName: 'user',
	 *     uuid: field('uuid').string(),
	 *     displayName: field('display_name').string().optional(),
	 *   },
	 * });
	 *
	 * console.log(Tables.User.$name);       // 'user'
	 * console.log(Tables.User.displayName); // 'display_name'
	 * console.log(Tables.User.uuid);        // 'uuid'
	 * ```
	 */
	defineTables<T extends Record<string, TableDefInput>>(
		tables: T
	): { readonly [K in keyof T]: FlattenedTableOutput<T[K]> } {
		const result: Record<string, FlattenedTableOutput<TableDefInput>> = {};

		for (const key of Object.keys(tables)) {
			result[key] = flattenTable(tables[key]!);
		}

		return Object.freeze(result) as { readonly [K in keyof T]: FlattenedTableOutput<T[K]> };
	},

	/**
	 * Define a single table with flattened column access.
	 *
	 * @param table - Table definition with tableName and field builders
	 * @returns Flattened table (access column names directly)
	 *
	 * @example
	 * ```typescript
	 * export const UserTable = Mapper.defineTable({
	 *   tableName: 'user',
	 *   uuid: field('uuid').string(),
	 *   displayName: field('display_name').string().optional(),
	 * });
	 *
	 * console.log(UserTable.$name);       // 'user'
	 * console.log(UserTable.displayName); // 'display_name'
	 * ```
	 */
	defineTable<T extends TableDefInput>(table: T): FlattenedTableOutput<T> {
		return flattenTable(table);
	},

	/**
	 * Create a mapper builder for a table.
	 *
	 * @param table - Flattened table from defineTables()
	 * @param fields - Optional field names to include (if omitted, all fields are mapped)
	 * @returns MapperBuilder for fluent configuration
	 *
	 * @example
	 * ```typescript
	 * // Map all fields
	 * const UserMapper = Mapper.for<User>(Tables.User).build();
	 *
	 * // Map only specific fields (for subset types like BasicUser)
	 * const BasicUserMapper = Mapper.for<BasicUser>(Tables.User, 'uuid', 'displayName', 'email').build();
	 * ```
	 */
	for<T>(table: FlattenedTable, ...fields: string[]): MapperBuilder<T> {
		return new MapperBuilderClass<T>(table, fields.length > 0 ? new Set(fields) : undefined);
	}
};
