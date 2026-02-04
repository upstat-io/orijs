/**
 * MapperError
 *
 * Custom error class for mapper-related errors with structured context.
 * Provides detailed information about what went wrong during mapping.
 *
 * @example
 * ```typescript
 * throw new MapperError(
 *   'user',
 *   'age',
 *   'coercion failed',
 *   'number',
 *   'abc'
 * );
 * // MapperError: [user.age] coercion failed - expected number, got: "abc"
 * ```
 */

/**
 * Error thrown when mapping fails.
 * Contains context about the table, column, and failure reason.
 */
export class MapperError extends Error {
	public override readonly name = 'MapperError';

	/**
	 * Create a new MapperError.
	 *
	 * @param tableName - Name of the table being mapped
	 * @param columnName - Name of the column that failed
	 * @param reason - Description of why the mapping failed
	 * @param expectedType - Expected data type (optional)
	 * @param actualValue - The actual value that caused the error (optional)
	 */
	public constructor(
		public readonly tableName: string,
		public readonly columnName: string,
		public readonly reason: string,
		public readonly expectedType?: string,
		public readonly actualValue?: unknown
	) {
		super(MapperError.formatMessage(tableName, columnName, reason, expectedType, actualValue));

		// Maintains proper stack trace for where error was thrown (V8 engines)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, MapperError);
		}
	}

	/**
	 * Format error message with all context.
	 */
	private static formatMessage(
		tableName: string,
		columnName: string,
		reason: string,
		expectedType?: string,
		actualValue?: unknown
	): string {
		let message = `[${tableName}.${columnName}] ${reason}`;

		if (expectedType !== undefined) {
			message += ` - expected ${expectedType}`;
		}

		if (actualValue !== undefined) {
			const valueStr = MapperError.formatValue(actualValue);
			message += `, got: ${valueStr}`;
		}

		return message;
	}

	/**
	 * Format a value for display in error message.
	 */
	private static formatValue(value: unknown): string {
		if (value === null) {
			return 'null';
		}
		if (value === undefined) {
			return 'undefined';
		}
		if (typeof value === 'string') {
			return `"${value}"`;
		}
		if (typeof value === 'object') {
			try {
				return JSON.stringify(value);
			} catch {
				return '[object]';
			}
		}
		return String(value);
	}
}
