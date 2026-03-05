import { Type, FormatRegistry, type TSchema, type TProperties } from '@sinclair/typebox';

export interface StringParamOptions {
	minLength?: number;
	maxLength?: number;
	pattern?: string;
}

export interface NumberParamOptions {
	min?: number;
	max?: number;
}

// UUID regex pattern (RFC 4122)
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * Helpers for common URL path parameter validation patterns.
 */
export const Params = {
	/**
	 * Create a schema for UUID path parameters.
	 * @param names - Parameter names to validate as UUIDs
	 * @example
	 * Params.uuid('id')
	 * Params.uuid('orgId', 'userId')
	 */
	uuid(...names: string[]): TSchema {
		const properties: TProperties = {};
		for (const name of names) {
			properties[name] = Type.String({ pattern: UUID_PATTERN });
		}
		return Type.Object(properties);
	},

	/**
	 * Create a schema for a string path parameter.
	 * @param name - Parameter name
	 * @param options - String constraints
	 * @example
	 * Params.string('slug')
	 * Params.string('slug', { minLength: 1, maxLength: 100 })
	 */
	string(name: string, options: StringParamOptions = {}): TSchema {
		const stringOptions: Record<string, unknown> = {};
		if (options.minLength !== undefined) stringOptions.minLength = options.minLength;
		if (options.maxLength !== undefined) stringOptions.maxLength = options.maxLength;
		if (options.pattern !== undefined) stringOptions.pattern = options.pattern;

		return Type.Object({
			[name]: Type.String(stringOptions)
		});
	},

	/**
	 * Create a schema for a numeric path parameter (validated as numeric string).
	 * Path params are always strings from the URL, this validates them as numeric.
	 * @param name - Parameter name
	 * @param options - Number constraints
	 * @example
	 * Params.number('id')
	 * Params.number('id', { min: 1 })
	 */
	number(name: string, options: NumberParamOptions = {}): TSchema {
		// Path params are strings, so we validate as a numeric string pattern
		// The handler can parse to number if needed
		let pattern = '^[0-9]+$';
		if (options.min !== undefined && options.min > 0) {
			pattern = '^[1-9][0-9]*$';
		}

		// When min/max specified, register a custom format for numeric bounds
		if (options.min !== undefined || options.max !== undefined) {
			const formatName = `numeric-param:${options.min ?? ''}:${options.max ?? ''}`;
			if (!FormatRegistry.Has(formatName)) {
				FormatRegistry.Set(formatName, (value: string) => {
					if (!new RegExp(pattern).test(value)) return false;
					const num = parseInt(value, 10);
					if (options.min !== undefined && num < options.min) return false;
					if (options.max !== undefined && num > options.max) return false;
					return true;
				});
			}
			return Type.Object({
				[name]: Type.String({ format: formatName, minLength: 1 })
			});
		}

		return Type.Object({
			[name]: Type.String({
				pattern,
				minLength: 1
			})
		});
	}
};
