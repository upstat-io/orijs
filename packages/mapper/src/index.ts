/**
 * Fluent Mapper Framework
 *
 * Factory-based table definitions with fluent mapper builder.
 *
 * @example
 * ```typescript
 * import { Mapper, field } from '@orijs/mapper';
 *
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

export { Mapper } from './mapper';
export type {
	// From mapper.ts
	TableDefInput,
	FlattenedTable,
	FlattenedTableOutput,
	ResolvedFieldDef,
	MapperBuilder,
	BuiltMapper,
	MapResult,
	MapOptions,
	PickBuilder,
	JsonBuilder,
	ColBuilder,
	EmbedBuilder,
	FieldRenameBuilder,
	// Re-exported from types.ts via mapper.ts (single source)
	FieldBuilder,
	FieldDef,
	FieldType,
	FieldValue,
	TableFieldsInput,
	TableShape,
	StringFieldBuilder,
	NumberFieldBuilder,
	BooleanFieldBuilder,
	DateFieldBuilder,
	AnyFieldBuilder,
	NullableFieldBuilder
} from './mapper';

export type { FieldColumnBuilder } from './types';

export { field } from './field';

export { MapperError } from './mapper-error';

export { coerceString, coerceNumber, coerceBoolean, coerceDate } from './coercion';
