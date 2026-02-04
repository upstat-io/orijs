/**
 * Event Subscription - Request-response pattern support.
 *
 * EventSubscription enables the request-response pattern:
 * - Emitter calls emit() and gets EventSubscription
 * - Emitter calls .subscribe() to receive handler's return value
 * - Handler returns a value, which flows to the subscription
 *
 * For fire-and-forget, the subscription is simply ignored.
 *
 * Uses a state machine pattern with discriminated unions for
 * type-safe state management - impossible states are unrepresentable.
 *
 * @module events/event-subscription
 */

/**
 * Callback for receiving handler return value.
 */
export type SubscribeCallback<T> = (result: T) => void;

/**
 * Callback for receiving handler errors.
 */
export type ErrorCallback = (error: Error) => void;

/**
 * Subscription state machine.
 * Uses discriminated union to make impossible states unrepresentable.
 */
type SubscriptionState<T> =
	| { readonly status: 'pending' }
	| { readonly status: 'resolved'; readonly value: T }
	| { readonly status: 'rejected'; readonly error: Error };

/**
 * Promise handlers stored together for cleaner state management.
 */
interface PromiseHandlers<T> {
	readonly resolve: (value: T) => void;
	readonly reject: (error: Error) => void;
}

/**
 * Represents a subscription to an event's result.
 *
 * Supports three usage patterns:
 *
 * **Fire-and-forget:**
 * ```ts
 * events.emit('notification.send', payload); // Subscription ignored
 * ```
 *
 * **Callback-based (request-response):**
 * ```ts
 * events.emit('order.validate', payload)
 *   .subscribe((result) => {
 *     console.log('Validation result:', result.status);
 *   })
 *   .catch((error) => {
 *     console.error('Validation failed:', error);
 *   });
 * ```
 *
 * **Async/await (request-response):**
 * ```ts
 * const result = await events.emit<ValidationResult>('order.validate', payload);
 * console.log('Validation result:', result.status);
 * ```
 *
 * @template T - The type of the handler's return value
 */
export class EventSubscription<T = void> {
	/** Current state - single source of truth */
	private state: SubscriptionState<T> = { status: 'pending' };

	/** Callback for successful results */
	private subscribeCallback: SubscribeCallback<T> | null = null;

	/** Callback for errors */
	private errorCallback: ErrorCallback | null = null;

	/** Promise handlers (stored together) */
	private promiseHandlers: PromiseHandlers<T> | null = null;

	/** Cached promise for toPromise() */
	private promise: Promise<T> | null = null;

	/**
	 * Creates a new EventSubscription.
	 * @param correlationId - Unique ID for correlating with handler response
	 */
	public constructor(public readonly correlationId: string) {}

	/**
	 * Registers a callback to receive the handler's return value.
	 * If already resolved, callback is invoked immediately.
	 *
	 * @param callback - Function to receive the result
	 * @returns this (for chaining with .catch())
	 */
	public subscribe(callback: SubscribeCallback<T>): this {
		this.subscribeCallback = callback;

		// If already resolved, invoke immediately
		if (this.state.status === 'resolved') {
			callback(this.state.value);
		}

		return this;
	}

	/**
	 * Registers a callback to receive handler errors.
	 * If already rejected, callback is invoked immediately.
	 *
	 * @param callback - Function to receive the error
	 * @returns this (for chaining)
	 */
	public catch(callback: ErrorCallback): this {
		this.errorCallback = callback;

		// If already rejected, invoke immediately
		if (this.state.status === 'rejected') {
			callback(this.state.error);
		}

		return this;
	}

	/**
	 * Resolves the subscription with a value.
	 * Called by the provider when handler completes.
	 *
	 * @internal
	 * @param value - The handler's return value
	 */
	public _resolve(value: T): void {
		if (this.state.status !== 'pending') {
			return; // Already settled
		}

		this.state = { status: 'resolved', value };

		this.subscribeCallback?.(value);
		this.promiseHandlers?.resolve(value);
	}

	/**
	 * Rejects the subscription with an error.
	 * Called by the provider when handler throws.
	 *
	 * @internal
	 * @param error - The error from the handler
	 */
	public _reject(error: Error): void {
		if (this.state.status !== 'pending') {
			return; // Already settled
		}

		this.state = { status: 'rejected', error };

		this.errorCallback?.(error);
		this.promiseHandlers?.reject(error);
	}

	/**
	 * Returns whether this subscription has been resolved.
	 */
	public isResolved(): boolean {
		return this.state.status === 'resolved';
	}

	/**
	 * Returns whether this subscription has been rejected.
	 */
	public isRejected(): boolean {
		return this.state.status === 'rejected';
	}

	/**
	 * Returns whether this subscription has been settled (resolved or rejected).
	 */
	public isSettled(): boolean {
		return this.state.status !== 'pending';
	}

	/**
	 * Converts this subscription to a Promise.
	 * Enables async/await usage with optional timeout.
	 *
	 * @param timeoutMs - Optional timeout in milliseconds. If handler doesn't
	 *                    respond within this time, the promise rejects with a
	 *                    timeout error. Prevents hanging awaits.
	 * @returns Promise that resolves with handler result or rejects with error/timeout
	 *
	 * @example
	 * ```ts
	 * // Without timeout
	 * const result = await events.emit<Result>('event', payload).toPromise();
	 *
	 * // With 5 second timeout
	 * const result = await events.emit<Result>('slow.event', payload).toPromise(5000);
	 * ```
	 */
	public toPromise(timeoutMs?: number): Promise<T> {
		// Create base promise if not already created
		if (!this.promise) {
			this.promise = new Promise<T>((resolve, reject) => {
				// If already settled, resolve/reject immediately
				if (this.state.status === 'resolved') {
					resolve(this.state.value);
					return;
				}
				if (this.state.status === 'rejected') {
					reject(this.state.error);
					return;
				}

				// Store handlers for later resolution
				this.promiseHandlers = { resolve, reject };
			});
		}

		// If no timeout or already settled, return cached promise
		if (!timeoutMs || timeoutMs <= 0 || this.isSettled()) {
			return this.promise;
		}

		// Wrap with timeout that cleans up properly
		return new Promise<T>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				if (!this.isSettled()) {
					reject(new Error(`EventSubscription timeout after ${timeoutMs}ms`));
				}
			}, timeoutMs);

			this.promise!.then((value) => {
				clearTimeout(timeoutId);
				resolve(value);
			}).catch((error) => {
				clearTimeout(timeoutId);
				reject(error);
			});
		});
	}

	/**
	 * Makes EventSubscription "thenable" for direct await support.
	 * This allows `await events.emit(...)` without calling .toPromise().
	 *
	 * @param onfulfilled - Called when the handler returns successfully
	 * @param onrejected - Called when the handler throws
	 * @returns Promise for chaining
	 *
	 * @example
	 * ```ts
	 * // Direct await (no .toPromise() needed)
	 * const result = await events.emit<Result>('event', payload);
	 * ```
	 */
	// oxlint-disable-next-line unicorn/no-thenable -- Intentional: implements Promise-like interface for await support
	public then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: Error) => TResult2 | PromiseLike<TResult2>) | null
	): Promise<TResult1 | TResult2> {
		return this.toPromise().then(onfulfilled, onrejected);
	}
}

/**
 * Creates a new EventSubscription with a generated correlation ID.
 *
 * @template T - The expected return type
 * @returns New EventSubscription instance
 */
export function createSubscription<T = void>(): EventSubscription<T> {
	const correlationId = crypto.randomUUID();
	return new EventSubscription<T>(correlationId);
}
