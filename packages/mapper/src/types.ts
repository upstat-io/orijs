/**
 * Mapper Types
 *
 * Core type definitions for the fluent mapper system.
 * Field definitions describe column types and options.
 * Builders provide fluent API for configuring fields.
 */

// --- Field Type Constants ---

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'any';

// --- Field Definition ---

/**
 * Defines a single field (column) in a table.
 */
export interface FieldDef<T = unknown> {
	/** Database column name (snake_case) - always required */
	readonly column: string;
	/** Field data type */
	readonly type: FieldType;
	/** Whether the field can be null/undefined */
	readonly optional: boolean;
	/** Default value when field is null/undefined */
	readonly defaultValue?: T;
}

// --- Field Column Builder ---

/**
 * Builder returned by field(column) that provides type selection methods.
 */
export interface FieldColumnBuilder {
	/** Create a string field */
	string(): StringFieldBuilder;
	/** Create a number field */
	number(): NumberFieldBuilder;
	/** Create a boolean field */
	boolean(): BooleanFieldBuilder;
	/** Create a date field */
	date(): DateFieldBuilder;
	/** Create a generic any field (for JSONB, arrays, etc.) */
	any<T = unknown>(): AnyFieldBuilder<T>;
}

// --- Field Builders ---

/**
 * Base builder interface for field configuration.
 * Type parameter T represents the field's runtime type.
 */
export interface FieldBuilder<T = unknown> {
	/** Internal field definition - readonly access for inspection */
	readonly _def: FieldDef<T>;

	/** Mark field as optional (can be null/undefined) */
	optional(): FieldBuilder<T | undefined>;

	/** Set default value for null/undefined fields */
	default(value: T): FieldBuilder<T>;
}

/**
 * String field builder.
 */
export interface StringFieldBuilder extends FieldBuilder<string> {
	optional(): StringFieldBuilder;
	default(value: string): StringFieldBuilder;
	/** Mark field as nullable (can be null, allows .default(null)) */
	nullable(): NullableFieldBuilder<string>;
}

/**
 * Number field builder.
 */
export interface NumberFieldBuilder extends FieldBuilder<number> {
	optional(): NumberFieldBuilder;
	default(value: number): NumberFieldBuilder;
	/** Mark field as nullable (can be null, allows .default(null)) */
	nullable(): NullableFieldBuilder<number>;
}

/**
 * Boolean field builder.
 */
export interface BooleanFieldBuilder extends FieldBuilder<boolean> {
	optional(): BooleanFieldBuilder;
	default(value: boolean): BooleanFieldBuilder;
	/** Mark field as nullable (can be null, allows .default(null)) */
	nullable(): NullableFieldBuilder<boolean>;
}

/**
 * Date field builder.
 */
export interface DateFieldBuilder extends FieldBuilder<Date> {
	optional(): DateFieldBuilder;
	default(value: Date): DateFieldBuilder;
	/** Mark field as nullable (can be null, allows .default(null)) */
	nullable(): NullableFieldBuilder<Date>;
}

/**
 * Generic any field builder.
 * Used for JSONB columns or other complex types.
 */
export interface AnyFieldBuilder<T> extends FieldBuilder<T> {
	optional(): AnyFieldBuilder<T | undefined>;
	default(value: T): AnyFieldBuilder<T>;
}

/**
 * Nullable field builder.
 * Used when a field can be null (e.g., foreign key references).
 * Allows .default(null) to work type-safely.
 */
export interface NullableFieldBuilder<T> extends FieldBuilder<T | null> {
	optional(): NullableFieldBuilder<T>;
	default(value: T | null): NullableFieldBuilder<T>;
}

// --- Table Definition Input ---

/**
 * Input type for defining a table's fields.
 * Each property is a FieldBuilder defining that column.
 */
export type TableFieldsInput = Record<string, FieldBuilder>;

/**
 * Input type for Mapper.defineTables().
 * Maps table property names to table definitions.
 */
export interface TableDefInput {
	/** Database table name (snake_case) */
	tableName: string;
	/** Field definitions - keys are property names, values are FieldBuilders */
	[key: string]: string | FieldBuilder;
}

// --- Utility Types ---

/**
 * Extract the runtime type from a FieldBuilder.
 */
export type FieldValue<F> = F extends FieldBuilder<infer T> ? T : never;

/**
 * Extract the runtime type for a table's fields.
 */
export type TableShape<T extends TableDefInput> = {
	[K in Exclude<keyof T, 'tableName'>]: T[K] extends FieldBuilder<infer V> ? V : never;
};
