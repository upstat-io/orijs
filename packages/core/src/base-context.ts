import type { Logger } from '@orijs/logging';
import type { EventSystem } from '@orijs/events';

/**
 * Base context with shared properties available to all context types.
 *
 * Provides:
 * - log: Logger instance for structured logging
 * - event: Event system for emitting/subscribing to events
 *
 * Both AppContext and RequestContext have access to these shared properties.
 */
export interface BaseContext {
	/** Logger instance for structured logging */
	readonly log: Logger;

	/** Event system for emitting and subscribing to events */
	readonly event: EventSystem | undefined;
}
