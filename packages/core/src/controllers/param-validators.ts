/**
 * Interface for path parameter validators.
 *
 * Implement this to create custom validators for route path parameters.
 * Register with `r.param('name', ValidatorClass)` in a controller's configure method.
 *
 * @example Custom slug validator
 * ```ts
 * class SlugParam implements ParamValidator {
 *   validate(value: string): boolean {
 *     return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
 *   }
 * }
 *
 * r.param('slug', SlugParam);
 * r.get('/:slug', this.getBySlug);
 * ```
 */
export interface ParamValidator {
	validate(value: string): boolean;
}

/** Constructor type for ParamValidator classes. */
export type ParamValidatorClass = new () => ParamValidator;

/**
 * Validates that a path parameter is a valid UUID (RFC 4122).
 *
 * @example
 * ```ts
 * r.param('uuid', UuidParam);
 * r.get('/:uuid', this.getOne);  // only matches valid UUIDs
 * ```
 */
export class UuidParam implements ParamValidator {
	private static readonly PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	validate(value: string): boolean {
		return UuidParam.PATTERN.test(value);
	}
}

/**
 * Validates that a path parameter is a non-empty string.
 *
 * @example
 * ```ts
 * r.param('name', StringParam);
 * r.get('/:name', this.getByName);
 * ```
 */
export class StringParam implements ParamValidator {
	validate(value: string): boolean {
		return value.length > 0;
	}
}

/**
 * Validates that a path parameter is a numeric string (integer).
 *
 * @example
 * ```ts
 * r.param('id', NumberParam);
 * r.get('/:id', this.getById);  // only matches numeric IDs
 * ```
 */
export class NumberParam implements ParamValidator {
	private static readonly PATTERN = /^[0-9]+$/;

	validate(value: string): boolean {
		return NumberParam.PATTERN.test(value);
	}
}
