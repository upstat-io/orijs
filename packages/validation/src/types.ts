import { Type, Kind, FormatRegistry, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Json } from './json';

// Re-export TypeBox for convenience
export { Type, Type as t, Value, FormatRegistry };
export type { Static, TSchema };

/**
 * Standard Schema interface for library-agnostic validation.
 * TypeBox is the primary schema library for OriJS.
 */
export interface StandardSchema<T = unknown> {
	'~standard': {
		version: 1;
		vendor: string;
		validate: (value: unknown) => { value: T } | { issues: StandardSchemaIssue[] };
	};
}

export interface StandardSchemaIssue {
	message: string;
	path?: (string | number)[];
}

/**
 * Custom validator function type.
 * Return the validated/transformed data, or throw an error to fail validation.
 *
 * @example
 * ```ts
 * const validateUser: Validator<User> = async (data) => {
 *   if (!data || typeof data !== 'object') {
 *     throw new Error('Invalid user data');
 *   }
 *   const user = data as User;
 *   if (await userExists(user.email)) {
 *     throw new Error('Email already registered');
 *   }
 *   return user;
 * };
 * ```
 */
export type Validator<T = unknown> = (data: unknown) => T | Promise<T>;

/**
 * Schema type that can be TypeBox, Standard Schema, or custom validator.
 */
export type Schema<T = unknown> = TSchema | StandardSchema<T> | Validator<T>;

/**
 * Validation result type.
 */
export type ValidationResult<T> = { success: true; data: T } | { success: false; errors: ValidationError[] };

export interface ValidationError {
	path: string;
	message: string;
	value?: unknown;
}

/**
 * Check if a schema is a custom validator function
 */
export function isValidator(schema: unknown): schema is Validator {
	return typeof schema === 'function';
}

/**
 * Check if a schema is a Standard Schema (has ~standard property)
 */
export function isStandardSchema(schema: unknown): schema is StandardSchema {
	return typeof schema === 'object' && schema !== null && '~standard' in schema;
}

/**
 * Check if a schema is a TypeBox schema
 */
export function isTypeBoxSchema(schema: unknown): schema is TSchema {
	return typeof schema === 'object' && schema !== null && Kind in (schema as Record<symbol, unknown>);
}

/**
 * Validate data against a TypeBox schema synchronously.
 * Use this when you have a TypeBox schema and need sync validation.
 *
 * @throws Error if schema is not a TypeBox schema
 */
export function validateSync<T>(schema: TSchema, data: unknown): ValidationResult<T> {
	if (!isTypeBoxSchema(schema)) {
		throw new Error('validateSync only supports TypeBox schemas');
	}
	return validateTypeBox(schema, data);
}

/**
 * Validate data against a schema (TypeBox, Standard Schema, or custom validator)
 */
export async function validate<T>(schema: Schema<T>, data: unknown): Promise<ValidationResult<T>> {
	if (isValidator(schema)) {
		return validateCustom(schema, data);
	}

	if (isStandardSchema(schema)) {
		return validateStandardSchema(schema, data);
	}

	if (isTypeBoxSchema(schema)) {
		return validateTypeBox(schema, data);
	}

	throw new Error('Unknown schema type');
}

async function validateCustom<T>(validator: Validator<T>, data: unknown): Promise<ValidationResult<T>> {
	try {
		const result = await validator(data);
		return { success: true, data: result };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			errors: [{ path: '', message }]
		};
	}
}

function validateTypeBox<T>(schema: TSchema, data: unknown): ValidationResult<T> {
	// Sanitize input to prevent prototype pollution attacks.
	// This is defense-in-depth - strips __proto__, constructor, prototype keys
	// even if schema doesn't specify additionalProperties: false.
	const sanitized = Json.sanitize(data);

	const errors = [...Value.Errors(schema, sanitized)];

	if (errors.length === 0) {
		// Apply defaults and coercion
		const decoded = Value.Decode(schema, sanitized);
		return { success: true, data: decoded as T };
	}

	return {
		success: false,
		errors: errors.map((err) => ({
			path: err.path,
			message: err.message,
			value: err.value
		}))
	};
}

function validateStandardSchema<T>(schema: StandardSchema<T>, data: unknown): ValidationResult<T> {
	const result = schema['~standard'].validate(data);

	if ('value' in result) {
		return { success: true, data: result.value };
	}

	return {
		success: false,
		errors: result.issues.map((issue) => ({
			path: issue.path?.join('.') ?? '',
			message: issue.message
		}))
	};
}
