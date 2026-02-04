/**
 * Event Idempotency Helper - Prevents duplicate event processing.
 *
 * When events are retried (due to failures, network issues, etc.),
 * handlers may be called multiple times with the same event.
 * This helper ensures each event is processed exactly once.
 *
 * @module events/event-idempotency
 *
 * @example
 * ```ts
 * const idempotency = new EventIdempotency();
 *
 * events.onEvent('user.created', async (ctx) => {
 *   // Only executes once per eventId, even if retried
 *   return idempotency.processOnce(ctx.eventId, async () => {
 *     await db.insertUser(ctx.data);
 *     await emailService.sendWelcome(ctx.data.email);
 *     return { processed: true };
 *   });
 * });
 * ```
 */

/**
 * Result of processOnce - indicates whether handler was executed or skipped.
 */
export interface IdempotencyResult<T> {
	/** Whether the handler was executed (true) or skipped as duplicate (false) */
	readonly executed: boolean;
	/** The result if executed, undefined if skipped */
	readonly result: T | undefined;
}

/**
 * Options for EventIdempotency constructor.
 */
export interface EventIdempotencyOptions {
	/**
	 * Maximum number of event IDs to track (LRU eviction).
	 * Default: 10000
	 */
	readonly maxSize?: number;

	/**
	 * TTL in milliseconds for tracked event IDs.
	 * After this time, the event ID is removed and can be processed again.
	 * Default: 3600000 (1 hour)
	 */
	readonly ttlMs?: number;
}

/**
 * In-memory idempotency tracker for event handlers.
 *
 * Tracks processed event IDs to prevent duplicate processing.
 * Uses LRU eviction when max size is reached.
 *
 * Note: This is an in-memory implementation suitable for single-process
 * deployments. For distributed systems, use Redis-backed idempotency.
 */
export class EventIdempotency {
	private readonly processed = new Map<string, number>(); // eventId -> timestamp
	private readonly maxSize: number;
	private readonly ttlMs: number;

	constructor(options: EventIdempotencyOptions = {}) {
		this.maxSize = options.maxSize ?? 10000;
		this.ttlMs = options.ttlMs ?? 3600000; // 1 hour default
	}

	/**
	 * Process an event only if it hasn't been processed before.
	 *
	 * @param eventId - Unique event identifier
	 * @param handler - Handler function to execute
	 * @returns Result with executed flag and handler result
	 *
	 * @example
	 * ```ts
	 * const result = await idempotency.processOnce(ctx.eventId, async () => {
	 *   await db.insertUser(ctx.data);
	 *   return { created: true };
	 * });
	 *
	 * if (!result.executed) {
	 *   ctx.log.info('Skipped duplicate event', { eventId: ctx.eventId });
	 * }
	 * ```
	 */
	async processOnce<T>(eventId: string, handler: () => Promise<T>): Promise<IdempotencyResult<T>> {
		// Clean expired entries periodically
		this.cleanExpired();

		// Check if already processed
		if (this.processed.has(eventId)) {
			return { executed: false, result: undefined };
		}

		// Mark as processing (before execution to handle concurrent calls)
		this.processed.set(eventId, Date.now());

		// Enforce max size with LRU eviction
		if (this.processed.size > this.maxSize) {
			this.evictOldest();
		}

		// Execute handler
		const result = await handler();

		return { executed: true, result };
	}

	/**
	 * Check if an event has been processed.
	 *
	 * @param eventId - Event ID to check
	 * @returns True if event was already processed
	 */
	isProcessed(eventId: string): boolean {
		const timestamp = this.processed.get(eventId);
		if (timestamp === undefined) {
			return false;
		}

		// Check if expired
		if (Date.now() - timestamp > this.ttlMs) {
			this.processed.delete(eventId);
			return false;
		}

		return true;
	}

	/**
	 * Manually mark an event as processed.
	 * Useful when processing happens outside processOnce().
	 *
	 * @param eventId - Event ID to mark
	 */
	markProcessed(eventId: string): void {
		this.processed.set(eventId, Date.now());

		if (this.processed.size > this.maxSize) {
			this.evictOldest();
		}
	}

	/**
	 * Clear all tracked event IDs.
	 * Useful for testing.
	 */
	clear(): void {
		this.processed.clear();
	}

	/**
	 * Returns the number of tracked event IDs.
	 */
	get size(): number {
		return this.processed.size;
	}

	/**
	 * Remove expired entries.
	 */
	private cleanExpired(): void {
		const now = Date.now();
		for (const [eventId, timestamp] of this.processed) {
			if (now - timestamp > this.ttlMs) {
				this.processed.delete(eventId);
			}
		}
	}

	/**
	 * Evict oldest entries to stay under maxSize.
	 */
	private evictOldest(): void {
		// Map maintains insertion order, so first entries are oldest
		const iterator = this.processed.keys();
		const toDelete = this.processed.size - this.maxSize;

		for (let i = 0; i < toDelete; i++) {
			const key = iterator.next().value;
			if (key) {
				this.processed.delete(key);
			}
		}
	}
}
