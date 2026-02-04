import type { Logger } from '@orijs/logging';

/**
 * Base context with shared properties available to all context types.
 *
 * Provides:
 * - log: Logger instance for structured logging
 *
 * Both AppContext and RequestContext have access to these shared properties.
 */
export interface BaseContext {
	/** Logger instance for structured logging */
	readonly log: Logger;
}
