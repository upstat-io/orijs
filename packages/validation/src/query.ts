import { Type, type TObject } from '@sinclair/typebox';

export interface PaginationOptions {
	defaultPage?: number;
	defaultLimit?: number;
	maxLimit?: number;
	minLimit?: number;
}

export interface SearchOptions {
	minLength?: number;
	maxLength?: number;
}

export interface SortOptions {
	allowed?: string[];
	defaultField?: string;
	defaultOrder?: 'asc' | 'desc';
}

/** Default pagination values */
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_LIMIT = 1;

/**
 * Helpers for common query parameter validation patterns.
 */
export const Query = {
	/**
	 * Create a pagination schema with page and limit.
	 * Query params come as strings, so this coerces to numbers.
	 * @param options - Pagination constraints
	 * @example
	 * Query.pagination()
	 * Query.pagination({ maxLimit: 50 })
	 */
	pagination(options: PaginationOptions = {}): TObject {
		const {
			defaultPage = DEFAULT_PAGE,
			defaultLimit = DEFAULT_LIMIT,
			maxLimit = MAX_LIMIT,
			minLimit = MIN_LIMIT
		} = options;

		return Type.Object({
			page: Type.Optional(
				Type.Transform(Type.String({ pattern: '^[0-9]+$', default: String(defaultPage) }))
					.Decode((v) => {
						const num = parseInt(v, 10);
						return Math.max(1, num);
					})
					.Encode((v) => String(v))
			),
			limit: Type.Optional(
				Type.Transform(Type.String({ pattern: '^[0-9]+$', default: String(defaultLimit) }))
					.Decode((v) => {
						const num = parseInt(v, 10);
						return Math.min(maxLimit, Math.max(minLimit, num));
					})
					.Encode((v) => String(v))
			)
		});
	},

	/**
	 * Create a search schema with a 'q' query parameter.
	 * @param options - Search constraints
	 * @example
	 * Query.search()
	 * Query.search({ minLength: 2, maxLength: 100 })
	 */
	search(options: SearchOptions = {}): TObject {
		const { minLength = 1, maxLength = 100 } = options;

		return Type.Object({
			q: Type.Optional(Type.String({ minLength, maxLength }))
		});
	},

	/**
	 * Create a sort schema with sortBy and order parameters.
	 * @param options - Sort constraints
	 * @example
	 * Query.sort({ allowed: ['createdAt', 'name'] })
	 * Query.sort({ allowed: ['createdAt'], defaultField: 'createdAt', defaultOrder: 'desc' })
	 */
	sort(options: SortOptions = {}): TObject {
		const { allowed, defaultField, defaultOrder = 'asc' } = options;

		const sortBySchema = allowed
			? Type.Optional(
					Type.Union(
						allowed.map((field) => Type.Literal(field)),
						{ default: defaultField }
					)
				)
			: Type.Optional(Type.String({ default: defaultField }));

		return Type.Object({
			sortBy: sortBySchema,
			order: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')], { default: defaultOrder }))
		});
	}
};
