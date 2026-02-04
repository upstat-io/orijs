/**
 * Built Mapper Implementation
 *
 * Runtime mapping from database rows to typed objects.
 */

import type {
	BuiltMapper as IBuiltMapper,
	MapResult as IMapResult,
	MapOptions,
	FlattenedTable,
	ResolvedFieldDef,
	MapperConfig
} from './mapper-types';
import { coerceString, coerceNumber, coerceBoolean, coerceDate } from './coercion';
import { MapperError } from './mapper-error';

/**
 * Fluent result wrapper for map operations.
 */
export class MapResult<T> implements IMapResult<T> {
	public constructor(private result: T | undefined) {}

	public mergeWhen(condition: boolean, extra: Partial<T> | undefined): IMapResult<T> {
		if (condition && extra && this.result !== undefined) {
			return new MapResult<T>({ ...this.result, ...extra });
		}
		return this;
	}

	public default<D>(defaultValue: D): T | D {
		return this.result !== undefined ? this.result : defaultValue;
	}

	public value(): T | undefined {
		return this.result;
	}
}

/**
 * Built mapper that performs runtime row-to-object mapping.
 */
export class BuiltMapper<T> implements IBuiltMapper<T> {
	public constructor(private readonly config: MapperConfig) {}

	public map(row: unknown, options?: MapOptions): IMapResult<T> {
		if (row == null || typeof row !== 'object') {
			return new MapResult<T>(undefined);
		}

		const r = row as Record<string, unknown>;
		const prefix = options?.prefix ?? '';
		const result = this.mapFields(r, this.config.table, prefix);
		this.applyFieldRenames(result, r, prefix);
		this.applyPicks(result, r);
		this.applyJsons(result, r);
		this.applyCols(result, r);
		this.applyEmbeds(result, r);
		this.applyTransforms(result);
		return new MapResult<T>(result as T);
	}

	public mapMany(rows: unknown[], options?: MapOptions): T[] {
		return rows
			.map((row) => this.map(row, options).value())
			.filter((result): result is T => result !== undefined);
	}

	/**
	 * Map table fields from a row to an object.
	 */
	private mapFields(
		row: Record<string, unknown>,
		table: FlattenedTable,
		prefix: string
	): Record<string, unknown> {
		const result: Record<string, unknown> = {};

		for (const [property, fieldDef] of Object.entries(table.$fields)) {
			// Skip fields not in includes set (when field selection is active)
			if (this.config.includes && !this.config.includes.has(property)) {
				continue;
			}

			// Skip omitted fields
			if (this.config.omits.has(property)) {
				continue;
			}

			result[property] = this.resolveFieldValue(row, fieldDef, prefix, table.$name);
		}

		return result;
	}

	/**
	 * Apply field renames from the primary table.
	 */
	private applyFieldRenames(
		result: Record<string, unknown>,
		row: Record<string, unknown>,
		prefix: string
	): void {
		for (const rename of this.config.fieldRenames) {
			const fieldDef = this.config.table.$fields[rename.fieldName];
			if (!fieldDef) continue;

			result[rename.propertyName] = this.resolveFieldValue(row, fieldDef, prefix, this.config.table.$name);
		}
	}

	/**
	 * Apply picked fields from other tables.
	 */
	private applyPicks(result: Record<string, unknown>, row: Record<string, unknown>): void {
		for (const pick of this.config.picks) {
			for (const fieldName of pick.fields) {
				const fieldDef = pick.table.$fields[fieldName];
				if (!fieldDef) continue;

				result[fieldName] = this.resolveFieldValue(row, fieldDef, pick.prefix, pick.table.$name);
			}
		}
	}

	/**
	 * Apply JSON columns (query-generated aggregated data).
	 */
	private applyJsons(result: Record<string, unknown>, row: Record<string, unknown>): void {
		for (const json of this.config.jsons) {
			const value = row[json.column];
			const parsed = this.parseJson(value, json.column);
			// Factory is responsible for handling null (e.g., returning [] for null arrays)
			let finalValue = json.factory ? json.factory(parsed) : parsed;
			// Apply default if factory result is null/undefined
			if (finalValue == null && json.defaultValue !== undefined) {
				finalValue = json.defaultValue;
			}
			// Convert null to undefined for optional JSON columns
			if (finalValue == null && json.isOptional) {
				finalValue = undefined;
			}
			result[json.propertyName] = finalValue;
		}
	}

	/**
	 * Parse JSON value - handles string, array, object, or null.
	 * Throws MapperError if string is not valid JSON.
	 */
	private parseJson(value: unknown, columnName: string): unknown {
		if (value == null) {
			return null;
		}
		if (typeof value === 'string') {
			try {
				return JSON.parse(value);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'invalid JSON';
				throw new MapperError(
					this.config.table.$name,
					columnName,
					`JSON parse failed: ${message}`,
					'JSON',
					value.length > 100 ? value.slice(0, 100) + '...' : value
				);
			}
		}
		return value; // Already parsed (array or object)
	}

	/**
	 * Apply raw columns (calculated, aggregated, from JOINs, or computed).
	 */
	private applyCols(result: Record<string, unknown>, row: Record<string, unknown>): void {
		for (const col of this.config.cols) {
			let value: unknown;

			// If compute function is provided, use it instead of reading from column
			if (col.computeFn) {
				value = col.computeFn(row);
			} else {
				value = row[col.column];
			}

			if (value == null && col.defaultValue !== undefined) {
				value = col.defaultValue;
			}
			if (value == null && col.isOptional) {
				// Optional columns: convert null to undefined (TypeScript optional property semantics)
				value = undefined;
			}
			// Preserve null for non-optional columns (SQL null semantics)
			// Only optional columns are converted to undefined above
			result[col.propertyName] = value;
		}
	}

	/**
	 * Apply embedded objects from prefixed columns.
	 */
	private applyEmbeds(result: Record<string, unknown>, row: Record<string, unknown>): void {
		for (const embed of this.config.embeds) {
			const embeddedRow = this.extractPrefixedColumns(row, embed.prefix);
			if (this.hasAnyValue(embeddedRow)) {
				result[embed.key] = this.mapFields(row, embed.table, embed.prefix);
			} else {
				result[embed.key] = undefined;
			}
		}
	}

	/**
	 * Apply field transforms after all coercion is complete.
	 */
	private applyTransforms(result: Record<string, unknown>): void {
		for (const transform of this.config.transforms) {
			if (transform.propertyName in result) {
				result[transform.propertyName] = transform.fn(result[transform.propertyName]);
			}
		}
	}

	/**
	 * Resolve a field value from a row - handles defaults, optionals, and coercion.
	 * This is the single source of truth for field value resolution.
	 *
	 * @returns The resolved value, or undefined if the field should be set to undefined
	 */
	private resolveFieldValue(
		row: Record<string, unknown>,
		fieldDef: ResolvedFieldDef,
		prefix: string,
		tableName: string
	): unknown {
		const columnName = prefix + fieldDef.column;
		const value = row[columnName];

		// Check if a default is configured (even if default is null)
		const hasDefault = 'defaultValue' in fieldDef;

		// Apply default if value is null/undefined and default exists
		if (value == null && hasDefault) {
			return fieldDef.defaultValue;
		}

		// Return undefined if optional and still null/undefined (no default was set)
		if (value == null && fieldDef.optional) {
			return undefined;
		}

		// Coerce based on type (will throw for required fields with null value)
		return this.coerceField(value, fieldDef, tableName);
	}

	private coerceField(value: unknown, fieldDef: ResolvedFieldDef, tableName: string): unknown {
		switch (fieldDef.type) {
			case 'string':
				return coerceString(value, tableName, fieldDef.column);
			case 'number':
				return coerceNumber(value, tableName, fieldDef.column);
			case 'boolean':
				return coerceBoolean(value);
			case 'date':
				return coerceDate(value, tableName, fieldDef.column);
			default:
				return value;
		}
	}

	private extractPrefixedColumns(row: Record<string, unknown>, prefix: string): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(row)) {
			if (key.startsWith(prefix)) {
				result[key] = value;
			}
		}
		return result;
	}

	private hasAnyValue(obj: Record<string, unknown>): boolean {
		return Object.values(obj).some((v) => v != null);
	}
}
