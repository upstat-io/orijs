export {
	Type,
	t,
	Value,
	validate,
	validateSync,
	isValidator,
	isStandardSchema,
	isTypeBoxSchema
} from './types';

export type {
	Static,
	TSchema,
	StandardSchema,
	StandardSchemaIssue,
	Validator,
	Schema,
	ValidationResult,
	ValidationError
} from './types';

export { Params, type StringParamOptions, type NumberParamOptions } from './params';
export { Query, type PaginationOptions, type SearchOptions, type SortOptions } from './query';

// Safe JSON parsing with prototype pollution protection
export { Json } from './json';
