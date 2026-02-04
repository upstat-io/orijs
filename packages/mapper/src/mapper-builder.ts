/**
 * Mapper Builder Implementations
 *
 * All fluent builder classes for constructing mappers.
 */

import type {
	MapperBuilder as IMapperBuilder,
	BuiltMapper as IBuiltMapper,
	PickBuilder as IPickBuilder,
	JsonBuilder as IJsonBuilder,
	ColBuilder as IColBuilder,
	EmbedBuilder as IEmbedBuilder,
	FieldRenameBuilder as IFieldRenameBuilder,
	FlattenedTable,
	PickConfig,
	JsonConfig,
	ColConfig,
	EmbedConfig,
	FieldRenameConfig,
	TransformConfig,
	MapperConfig
} from './mapper-types';
// Note: IJsonBuilder is used as return type in JsonBuilder.as()
import { BuiltMapper as BuiltMapperClass } from './built-mapper';

/**
 * Convert camelCase to snake_case.
 * Used for inferring column names from property names.
 *
 * Handles consecutive uppercase letters (acronyms) correctly:
 * - parseXMLDocument → parse_xml_document
 * - userId → user_id
 * - parseXml → parse_xml
 */
function camelToSnake(str: string): string {
	return str
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // XMLDocument → XML_Document
		.replace(/([a-z])([A-Z])/g, '$1_$2') // parseXml → parse_Xml
		.toLowerCase();
}

/**
 * Main mapper builder implementation.
 * Collects configuration and produces a BuiltMapper.
 */
export class MapperBuilder<T> implements IMapperBuilder<T> {
	private readonly picks: PickConfig[] = [];
	private readonly jsons: JsonConfig[] = [];
	private readonly cols: ColConfig[] = [];
	private readonly embeds: EmbedConfig[] = [];
	private readonly omits: Set<string> = new Set();
	private readonly fieldRenames: FieldRenameConfig[] = [];
	private readonly transforms: TransformConfig[] = [];
	private readonly includes: Set<string> | undefined;
	private readonly mappedProperties: Set<string> = new Set();

	public constructor(
		private readonly table: FlattenedTable,
		includes?: Set<string>
	) {
		this.includes = includes;
	}

	/**
	 * Validates that a property has not already been mapped.
	 * Throws an error if the property is already mapped to prevent silent overwrites.
	 * @internal
	 */
	private validatePropertyNotMapped(propertyName: string, source: string): void {
		if (this.mappedProperties.has(propertyName)) {
			throw new Error(
				`Property '${propertyName}' is already mapped. ` +
					`Each property can only be mapped once. ` +
					`Attempted duplicate mapping from: ${source}`
			);
		}
		this.mappedProperties.add(propertyName);
	}

	public build(): IBuiltMapper<T> {
		const config: MapperConfig = {
			table: this.table,
			picks: Object.freeze([...this.picks]),
			jsons: Object.freeze([...this.jsons]),
			cols: Object.freeze([...this.cols]),
			embeds: Object.freeze([...this.embeds]),
			omits: this.omits,
			fieldRenames: Object.freeze([...this.fieldRenames]),
			transforms: Object.freeze([...this.transforms]),
			includes: this.includes
		};
		return new BuiltMapperClass<T>(Object.freeze(config));
	}

	public omit(...fields: string[]): IMapperBuilder<T> {
		for (const field of fields) {
			this.omits.add(field);
		}
		return this;
	}

	public pick(table: FlattenedTable, ...fields: string[]): IPickBuilder<T> {
		return new PickBuilder<T>(this, table, fields);
	}

	/** @internal */
	public addPick(config: PickConfig): void {
		// Validate each field is not already mapped
		for (const field of config.fields) {
			this.validatePropertyNotMapped(field, `pick(${config.table.$name}, '${field}')`);
		}
		this.picks.push(config);
	}

	public json<J>(column: string, factory?: (raw: unknown) => J | null | undefined): IJsonBuilder<T, J> {
		return new JsonBuilder<T, J>(this, column, factory);
	}

	/** @internal */
	public addJson(config: JsonConfig): void {
		this.validatePropertyNotMapped(config.propertyName, `json('${config.column}')`);
		this.jsons.push(config);
	}

	public col<C>(
		propertyName: string,
		columnOrCompute?: string | ((row: Record<string, unknown>) => C | null | undefined)
	): IColBuilder<T, C> {
		// If second arg is a function, it's a compute function
		if (typeof columnOrCompute === 'function') {
			return new ColBuilder<T, C>(this, '', propertyName, columnOrCompute);
		}
		// Otherwise it's a column name (or use default snake_case)
		const resolvedColumn = columnOrCompute ?? camelToSnake(propertyName);
		return new ColBuilder<T, C>(this, resolvedColumn, propertyName);
	}

	/** @internal */
	public addCol(config: ColConfig): void {
		this.validatePropertyNotMapped(config.propertyName, `col('${config.propertyName}')`);
		this.cols.push(config);
	}

	public embed(key: string, table: FlattenedTable): IEmbedBuilder<T> {
		return new EmbedBuilder<T>(this, key, table);
	}

	/** @internal */
	public addEmbed(config: EmbedConfig): void {
		this.validatePropertyNotMapped(config.key, `embed('${config.key}')`);
		this.embeds.push(config);
	}

	public field(fieldName: string): IFieldRenameBuilder<T> {
		return new FieldRenameBuilder<T>(this, fieldName);
	}

	/** @internal */
	public addFieldRename(config: FieldRenameConfig): void {
		this.validatePropertyNotMapped(
			config.propertyName,
			`field('${config.fieldName}').as('${config.propertyName}')`
		);
		this.omits.add(config.fieldName);
		this.fieldRenames.push(config);
	}

	public transform<K extends keyof T>(propertyName: K, fn: (value: T[K]) => T[K]): IMapperBuilder<T> {
		this.transforms.push({
			propertyName: propertyName as string,
			fn: fn as (value: unknown) => unknown
		});
		return this;
	}
}

/**
 * Base class for chained builders that need to finalize configuration before delegating.
 * Reduces duplication across PickBuilder, JsonBuilder, and ColBuilder.
 */
abstract class ChainedBuilder<T> implements IMapperBuilder<T> {
	protected finalized = false;

	protected constructor(protected readonly parent: MapperBuilder<T>) {}

	/** Subclasses implement this to add their configuration to the parent. */
	protected abstract doFinalize(): void;

	/** Finalize this builder's configuration (idempotent). */
	protected finalize(): void {
		if (this.finalized) return;
		this.finalized = true;
		this.doFinalize();
	}

	public build(): IBuiltMapper<T> {
		this.finalize();
		return this.parent.build();
	}

	public pick(table: FlattenedTable, ...fields: string[]): IPickBuilder<T> {
		this.finalize();
		return this.parent.pick(table, ...fields);
	}

	public json<J>(column: string, factory?: (raw: unknown) => J | null | undefined): IJsonBuilder<T, J> {
		this.finalize();
		return this.parent.json(column, factory);
	}

	public col<C>(
		propertyName: string,
		columnOrCompute?: string | ((row: Record<string, unknown>) => C | null | undefined)
	): IColBuilder<T, C> {
		this.finalize();
		return this.parent.col(propertyName, columnOrCompute);
	}

	public embed(key: string, table: FlattenedTable): IEmbedBuilder<T> {
		this.finalize();
		return this.parent.embed(key, table);
	}

	public omit(...fields: string[]): IMapperBuilder<T> {
		this.finalize();
		return this.parent.omit(...fields);
	}

	public field(fieldName: string): IFieldRenameBuilder<T> {
		this.finalize();
		return this.parent.field(fieldName);
	}

	public transform<K extends keyof T>(propertyName: K, fn: (value: T[K]) => T[K]): IMapperBuilder<T> {
		this.finalize();
		return this.parent.transform(propertyName, fn);
	}
}

/**
 * Builder for renaming a field from the primary table.
 */
class FieldRenameBuilder<T> implements IFieldRenameBuilder<T> {
	public constructor(
		private readonly parent: MapperBuilder<T>,
		private readonly fieldName: string
	) {}

	public as(propertyName: string): IMapperBuilder<T> {
		this.parent.addFieldRename({
			fieldName: this.fieldName,
			propertyName
		});
		return this.parent;
	}
}

/**
 * Builder for picking fields from another table.
 */
class PickBuilder<T> extends ChainedBuilder<T> implements IPickBuilder<T> {
	private pickPrefix = '';

	public constructor(
		parent: MapperBuilder<T>,
		private readonly table: FlattenedTable,
		private readonly fields: string[]
	) {
		super(parent);
	}

	public prefix(prefixStr: string): IMapperBuilder<T> {
		this.pickPrefix = prefixStr;
		this.finalize();
		return this.parent;
	}

	protected doFinalize(): void {
		this.parent.addPick({
			table: this.table,
			fields: this.fields,
			prefix: this.pickPrefix
		});
	}
}

/**
 * Builder for JSON column mapping.
 */
class JsonBuilder<T, J> extends ChainedBuilder<T> implements IJsonBuilder<T, J> {
	private jsonPropertyName: string;
	private jsonDefault?: J;
	private jsonOptional = false;

	public constructor(
		parent: MapperBuilder<T>,
		private readonly column: string,
		private readonly factory?: (raw: unknown) => J | null | undefined
	) {
		super(parent);
		this.jsonPropertyName = column; // Default: property name = column name
	}

	public as(propertyName: string): IJsonBuilder<T, J> {
		this.jsonPropertyName = propertyName;
		return this;
	}

	public default(value: J): IMapperBuilder<T> {
		this.jsonDefault = value;
		this.finalize();
		return this.parent;
	}

	public optional(): IMapperBuilder<T> {
		this.jsonOptional = true;
		this.finalize();
		return this.parent;
	}

	protected doFinalize(): void {
		this.parent.addJson({
			column: this.column,
			propertyName: this.jsonPropertyName,
			factory: this.factory,
			defaultValue: this.jsonDefault,
			isOptional: this.jsonOptional
		});
	}
}

/**
 * Builder for raw column mapping.
 */
class ColBuilder<T, C> extends ChainedBuilder<T> implements IColBuilder<T, C> {
	private colDefault?: C;
	private colOptional = false;

	public constructor(
		parent: MapperBuilder<T>,
		private readonly column: string,
		private readonly colPropertyName: string,
		private readonly computeFn?: (row: Record<string, unknown>) => C | null | undefined
	) {
		super(parent);
	}

	public default(value: C): IMapperBuilder<T> {
		this.colDefault = value;
		this.finalize();
		return this.parent;
	}

	public optional(): IMapperBuilder<T> {
		this.colOptional = true;
		this.finalize();
		return this.parent;
	}

	protected doFinalize(): void {
		this.parent.addCol({
			column: this.column,
			propertyName: this.colPropertyName,
			defaultValue: this.colDefault,
			isOptional: this.colOptional,
			computeFn: this.computeFn
		});
	}
}

/**
 * Builder for embedding a related object.
 * Extends ChainedBuilder to support .build() without .prefix().
 */
class EmbedBuilder<T> extends ChainedBuilder<T> implements IEmbedBuilder<T> {
	private embedPrefix = '';

	public constructor(
		parent: MapperBuilder<T>,
		private readonly key: string,
		private readonly table: FlattenedTable
	) {
		super(parent);
	}

	public prefix(prefixStr: string): IMapperBuilder<T> {
		this.embedPrefix = prefixStr;
		this.finalize();
		return this.parent;
	}

	protected doFinalize(): void {
		this.parent.addEmbed({
			key: this.key,
			table: this.table,
			prefix: this.embedPrefix
		});
	}
}
