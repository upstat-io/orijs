/**
 * Field Builders
 *
 * Factory functions for creating type-safe field definitions.
 * Column name is mandatory as the first argument.
 *
 * @example
 * ```typescript
 * // Basic field (column name always required)
 * const uuidField = field('uuid').string();
 *
 * // With optional modifier
 * const emailField = field('email').string().optional();
 *
 * // With default value
 * const isActiveField = field('is_active').boolean().default(true);
 *
 * // Nullable field (e.g., foreign key that can be null)
 * const parentId = field('parent_id').string().nullable().default(null);
 *
 * // JSONB field
 * const metadataField = field('metadata').any<Metadata>().optional();
 * ```
 */

import type {
	FieldDef,
	FieldType,
	StringFieldBuilder,
	NumberFieldBuilder,
	BooleanFieldBuilder,
	DateFieldBuilder,
	AnyFieldBuilder,
	FieldColumnBuilder
} from './types';

// --- Internal Builder Implementation ---

/**
 * Internal builder class implementing the fluent API.
 * Returns new instances for immutability.
 */
class FieldBuilderInternal<T> {
	public readonly _def: FieldDef<T>;

	public constructor(type: FieldType, column: string, optional: boolean = false, defaultValue?: T) {
		this._def =
			defaultValue !== undefined ? { column, type, optional, defaultValue } : { column, type, optional };
	}

	public optional(): FieldBuilderInternal<T | undefined> {
		return new FieldBuilderInternal(
			this._def.type,
			this._def.column,
			true,
			this._def.defaultValue as T | undefined
		);
	}

	public nullable(): FieldBuilderInternal<T | null> {
		return new FieldBuilderInternal<T | null>(
			this._def.type,
			this._def.column,
			this._def.optional,
			this._def.defaultValue as T | null
		);
	}

	public default(value: T): FieldBuilderInternal<T> {
		return new FieldBuilderInternal(this._def.type, this._def.column, this._def.optional, value);
	}
}

// --- Column Builder Implementation ---

/**
 * Builder that accepts column name first, then provides type methods.
 */
class FieldColumnBuilderInternal implements FieldColumnBuilder {
	public constructor(private readonly column: string) {}

	public string(): StringFieldBuilder {
		return new FieldBuilderInternal<string>('string', this.column) as StringFieldBuilder;
	}

	public number(): NumberFieldBuilder {
		return new FieldBuilderInternal<number>('number', this.column) as NumberFieldBuilder;
	}

	public boolean(): BooleanFieldBuilder {
		return new FieldBuilderInternal<boolean>('boolean', this.column) as BooleanFieldBuilder;
	}

	public date(): DateFieldBuilder {
		return new FieldBuilderInternal<Date>('date', this.column) as DateFieldBuilder;
	}

	public any<T = unknown>(): AnyFieldBuilder<T> {
		return new FieldBuilderInternal<T>('any', this.column) as AnyFieldBuilder<T>;
	}
}

// --- Public API ---

/**
 * Field builder factory.
 *
 * Creates a field definition with the given column name.
 * Column name is mandatory.
 *
 * @param column - Database column name (snake_case)
 * @returns FieldColumnBuilder for selecting the type
 *
 * @example
 * ```typescript
 * import { field } from './field';
 *
 * const Tables = Mapper.defineTables({
 *   User: {
 *     name: 'user',
 *     uuid: field('uuid').string(),
 *     fbUid: field('fb_uid').string(),
 *     displayName: field('display_name').string().optional(),
 *     isActive: field('is_active').boolean().default(true),
 *     createdAt: field('created_at').date(),
 *     metadata: field('metadata').any<UserMetadata>(),
 *   }
 * });
 * ```
 */
export function field(column: string): FieldColumnBuilder {
	return new FieldColumnBuilderInternal(column);
}
