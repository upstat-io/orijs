/**
 * Completion Tracker - Handles request-response pattern via QueueEvents.
 *
 * Uses BullMQ's QueueEvents to listen for job completion and route
 * results back to the original emitter via correlation IDs.
 *
 * Flow:
 * 1. emit() registers a callback with correlationId
 * 2. Job is added to queue with correlationId in data
 * 3. Worker processes job and returns result
 * 4. QueueEvents fires 'completed' with returnvalue
 * 5. CompletionTracker routes result to registered callback
 *
 * @module events/completion-tracker
 */

import { QueueEvents, type ConnectionOptions } from 'bullmq';
import { Logger } from '@orijs/logging';
import { DEFAULT_TIMEOUT_MS } from '../constants.ts';

/**
 * Minimal logger interface for dependency injection.
 * Compatible with @orijs/logging Logger class.
 */
export interface ILogger {
	warn(msg: string, data?: Record<string, unknown>): void;
	error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Callback for successful job completion.
 */
export type CompletionCallback<TResult = unknown> = (result: TResult) => void;

/**
 * Callback for job failure.
 */
export type ErrorCallback = (error: Error) => void;

/**
 * Registration options.
 */
export interface RegisterOptions {
	/** Timeout in milliseconds (0 = no timeout) */
	readonly timeout?: number;
}

/**
 * Internal ioredis client interface.
 */
interface IRedisClient {
	on(event: string, handler: (...args: unknown[]) => void): this;
}

/**
 * BullMQ's RedisConnection exposes _client for accessing the underlying ioredis client.
 */
interface IRedisConnection {
	_client: IRedisClient;
}

/**
 * Interface for QueueEvents-like object (for testing).
 */
export interface IQueueEventsLike {
	on(event: string, callback: (...args: unknown[]) => void): void;
	close(): Promise<void>;
	/** Main ioredis connection - exposed for adding error handlers that persist through close() */
	connection: IRedisConnection;
}

/**
 * Completion tracker configuration options.
 */
export interface CompletionTrackerOptions {
	/** Redis connection options */
	readonly connection: ConnectionOptions;
	/** Default timeout in milliseconds for pending completions (default: 30000, 0 = no timeout) */
	readonly defaultTimeout?: number;
	/** Optional logger for warnings (defaults to new Logger('CompletionTracker')) */
	readonly logger?: ILogger;
	/** Optional QueueEvents class override (for testing) */
	readonly QueueEventsClass?: new (
		name: string,
		options: { connection: ConnectionOptions }
	) => IQueueEventsLike;
}

/**
 * Pending completion registration.
 */
interface PendingCompletion {
	readonly onSuccess: CompletionCallback;
	readonly onError?: ErrorCallback;
	readonly timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Early result for jobs that complete before mapJobId is called.
 * Handles race condition where very fast jobs complete before the
 * job ID to correlation ID mapping is established.
 */
interface EarlyResult {
	readonly result: unknown;
	readonly isFailure: boolean;
	readonly error?: Error;
}

/**
 * Completion Tracker interface for dependency injection.
 */
export interface ICompletionTracker {
	/** Register a callback for a correlation ID */
	register<TResult = unknown>(
		queueName: string,
		correlationId: string,
		onSuccess: CompletionCallback<TResult>,
		onError?: ErrorCallback,
		options?: RegisterOptions
	): void;
	/** Map a job ID to its correlation ID */
	mapJobId(queueName: string, jobId: string, correlationId: string): void;
	/** Get correlation ID for a job ID */
	getCorrelationId(queueName: string, jobId: string): string | undefined;
	/** Check if there's a pending completion for a correlation ID */
	hasPending(queueName: string, correlationId: string): boolean;
	/** Complete a pending registration with a result */
	complete(queueName: string, correlationId: string, result: unknown): void;
	/** Fail a pending registration with an error */
	fail(queueName: string, correlationId: string, error: Error): void;
	/** Stop and clean up */
	stop(): Promise<void>;
}

/**
 * Tracks job completions for request-response pattern.
 *
 * Each queue gets its own QueueEvents instance to listen for
 * completions and failures.
 *
 * @example
 * ```ts
 * const tracker = new CompletionTracker({
 *   connection: { host: 'localhost', port: 6379 }
 * });
 *
 * // Register for completion
 * tracker.register(
 *   'event:monitor.check',
 *   correlationId,
 *   (result) => console.log('Success:', result),
 *   (error) => console.error('Failed:', error)
 * );
 *
 * // Map job ID when job is created
 * tracker.mapJobId('event:monitor.check', job.id, correlationId);
 *
 * // QueueEvents will automatically trigger callbacks when job completes
 * ```
 */
export class CompletionTracker implements ICompletionTracker {
	private readonly connection: ConnectionOptions;
	private readonly defaultTimeout: number;
	private readonly logger: ILogger;
	private readonly queueEvents = new Map<string, IQueueEventsLike>();
	private readonly pending = new Map<string, Map<string, PendingCompletion>>();
	private readonly jobIdToCorrelationId = new Map<string, Map<string, string>>();
	// Stores results for jobs that complete before mapJobId is called (race condition handling)
	private readonly earlyResults = new Map<string, Map<string, EarlyResult>>();
	private readonly QueueEventsClass: new (
		name: string,
		options: { connection: ConnectionOptions }
	) => IQueueEventsLike;

	/**
	 * Creates a new CompletionTracker.
	 *
	 * @param options - Configuration including Redis connection
	 */
	public constructor(options: CompletionTrackerOptions) {
		this.connection = options.connection;
		this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT_MS;
		this.logger = options.logger ?? new Logger('CompletionTracker');
		this.QueueEventsClass =
			options.QueueEventsClass ?? (QueueEvents as unknown as typeof this.QueueEventsClass);
	}

	/**
	 * Gets or creates a QueueEvents instance for a queue.
	 */
	private getQueueEvents(queueName: string): IQueueEventsLike {
		const existingEvents = this.queueEvents.get(queueName);
		if (existingEvents) {
			return existingEvents;
		}

		const events = new this.QueueEventsClass(queueName, {
			connection: this.connection
		});

		// Handle QueueEvents errors per BullMQ docs
		events.on('error', (err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error('QueueEvents error', { queueName, error: message });
		});

		// Listen for job completions
		events.on('completed', (...eventArgs: unknown[]) => {
			const args = eventArgs[0] as { jobId: string; returnvalue?: string | unknown };
			const { jobId, returnvalue } = args;
			const correlationId = this.getCorrelationId(queueName, jobId);

			// Parse the result
			let result: unknown;
			if (returnvalue == null) {
				result = undefined;
			} else if (typeof returnvalue === 'string') {
				try {
					result = JSON.parse(returnvalue);
				} catch (error) {
					this.logger.warn('Failed to parse job result as JSON', {
						queueName,
						jobId,
						correlationId: correlationId ?? 'unknown',
						returnvalue: returnvalue.substring(0, 100),
						error: error instanceof Error ? error.message : String(error)
					});
					result = returnvalue;
				}
			} else {
				result = returnvalue;
			}

			if (correlationId) {
				this.complete(queueName, correlationId, result);
			} else {
				// Race condition: job completed before mapJobId was called
				// Store the result to be delivered when mapJobId is called
				this.storeEarlyResult(queueName, jobId, { result, isFailure: false });
			}
		});

		// Listen for job failures
		events.on('failed', (...eventArgs: unknown[]) => {
			const args = eventArgs[0] as { jobId: string; failedReason: string };
			const { jobId, failedReason } = args;
			const correlationId = this.getCorrelationId(queueName, jobId);
			const error = new Error(failedReason);
			if (correlationId) {
				this.fail(queueName, correlationId, error);
			} else {
				// Race condition: job failed before mapJobId was called
				// Store the error to be delivered when mapJobId is called
				this.storeEarlyResult(queueName, jobId, { result: undefined, isFailure: true, error });
			}
		});

		this.queueEvents.set(queueName, events);
		return events;
	}

	/**
	 * Gets or creates a nested map for a queue.
	 */
	private getOrCreatePendingMap(queueName: string): Map<string, PendingCompletion> {
		let queuePending = this.pending.get(queueName);
		if (!queuePending) {
			queuePending = new Map();
			this.pending.set(queueName, queuePending);
		}
		return queuePending;
	}

	/**
	 * Gets or creates a job ID to correlation ID map for a queue.
	 */
	private getOrCreateJobIdMap(queueName: string): Map<string, string> {
		let jobIdMap = this.jobIdToCorrelationId.get(queueName);
		if (!jobIdMap) {
			jobIdMap = new Map();
			this.jobIdToCorrelationId.set(queueName, jobIdMap);
		}
		return jobIdMap;
	}

	/**
	 * Gets or creates an early results map for a queue.
	 */
	private getOrCreateEarlyResultsMap(queueName: string): Map<string, EarlyResult> {
		let earlyResultsMap = this.earlyResults.get(queueName);
		if (!earlyResultsMap) {
			earlyResultsMap = new Map();
			this.earlyResults.set(queueName, earlyResultsMap);
		}
		return earlyResultsMap;
	}

	/**
	 * Registers a callback for a correlation ID.
	 *
	 * @param queueName - The queue name
	 * @param correlationId - Unique correlation ID for this request
	 * @param onSuccess - Callback for successful completion
	 * @param onError - Optional callback for failures
	 * @param options - Optional registration options (timeout)
	 */
	public register<TResult = unknown>(
		queueName: string,
		correlationId: string,
		onSuccess: CompletionCallback<TResult>,
		onError?: ErrorCallback,
		options?: RegisterOptions
	): void {
		// Ensure QueueEvents is created for this queue
		this.getQueueEvents(queueName);

		const queuePending = this.getOrCreatePendingMap(queueName);

		// Use explicit timeout, fall back to instance default (0 = no timeout)
		const timeout = options?.timeout ?? this.defaultTimeout;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		if (timeout > 0) {
			timeoutHandle = setTimeout(() => {
				const error = new Error(`Request timeout after ${timeout}ms`);
				this.fail(queueName, correlationId, error);
			}, timeout);
		}

		queuePending.set(correlationId, {
			onSuccess: onSuccess as CompletionCallback,
			onError,
			timeoutHandle
		});
	}

	/**
	 * Maps a job ID to its correlation ID.
	 *
	 * Called after job is added to queue, so we can look up
	 * correlation ID when QueueEvents fires.
	 *
	 * Handles race condition: if the job already completed before this
	 * mapping was established, delivers the early result immediately.
	 */
	public mapJobId(queueName: string, jobId: string, correlationId: string): void {
		const jobIdMap = this.getOrCreateJobIdMap(queueName);
		jobIdMap.set(jobId, correlationId);

		// Check for early result (race condition handling)
		const earlyResult = this.getAndRemoveEarlyResult(queueName, jobId);
		if (earlyResult) {
			if (earlyResult.isFailure && earlyResult.error) {
				this.fail(queueName, correlationId, earlyResult.error);
			} else {
				this.complete(queueName, correlationId, earlyResult.result);
			}
		}
	}

	/**
	 * Gets the correlation ID for a job ID.
	 */
	public getCorrelationId(queueName: string, jobId: string): string | undefined {
		return this.jobIdToCorrelationId.get(queueName)?.get(jobId);
	}

	/**
	 * Checks if there's a pending completion for a correlation ID.
	 */
	public hasPending(queueName: string, correlationId: string): boolean {
		return this.pending.get(queueName)?.has(correlationId) ?? false;
	}

	/**
	 * Completes a pending registration with a result.
	 */
	public complete(queueName: string, correlationId: string, result: unknown): void {
		const queuePending = this.pending.get(queueName);
		if (!queuePending) {
			return;
		}

		const completion = queuePending.get(correlationId);
		if (!completion) {
			return;
		}

		// Clear timeout if set
		if (completion.timeoutHandle) {
			clearTimeout(completion.timeoutHandle);
		}

		// Remove from pending
		queuePending.delete(correlationId);

		// Clean up job ID mapping
		this.cleanupJobIdMapping(queueName, correlationId);

		// Call success callback
		completion.onSuccess(result);
	}

	/**
	 * Fails a pending registration with an error.
	 */
	public fail(queueName: string, correlationId: string, error: Error): void {
		const queuePending = this.pending.get(queueName);
		if (!queuePending) {
			return;
		}

		const completion = queuePending.get(correlationId);
		if (!completion) {
			return;
		}

		// Clear timeout if set
		if (completion.timeoutHandle) {
			clearTimeout(completion.timeoutHandle);
		}

		// Remove from pending
		queuePending.delete(correlationId);

		// Clean up job ID mapping
		this.cleanupJobIdMapping(queueName, correlationId);

		// Call error callback if provided
		if (completion.onError) {
			completion.onError(error);
		}
	}

	/**
	 * Cleans up job ID mapping for a correlation ID.
	 */
	private cleanupJobIdMapping(queueName: string, correlationId: string): void {
		const jobIdMap = this.jobIdToCorrelationId.get(queueName);
		if (jobIdMap) {
			// Find and remove the job ID entry
			for (const [jobId, corrId] of jobIdMap.entries()) {
				if (corrId === correlationId) {
					jobIdMap.delete(jobId);
					break;
				}
			}
		}
	}

	/**
	 * Stores an early result for a job that completed before mapJobId was called.
	 */
	private storeEarlyResult(queueName: string, jobId: string, earlyResult: EarlyResult): void {
		const earlyResultsMap = this.getOrCreateEarlyResultsMap(queueName);
		earlyResultsMap.set(jobId, earlyResult);
	}

	/**
	 * Gets and removes an early result for a job.
	 */
	private getAndRemoveEarlyResult(queueName: string, jobId: string): EarlyResult | undefined {
		const queueEarlyResults = this.earlyResults.get(queueName);
		if (!queueEarlyResults) {
			return undefined;
		}
		const earlyResult = queueEarlyResults.get(jobId);
		if (earlyResult) {
			queueEarlyResults.delete(jobId);
		}
		return earlyResult;
	}

	/**
	 * Stops and cleans up all resources.
	 *
	 * BUG WORKAROUND: BullMQ's RedisConnection.close() removes error handlers in its
	 * finally block BEFORE all async operations complete. This causes ioredis errors
	 * (especially "Connection is closed") to become unhandled. We add our own error
	 * handlers to the internal ioredis clients that persist through close().
	 */
	public async stop(): Promise<void> {
		// Reject all pending completions with shutdown error and clear timeouts
		const shutdownError = new Error('CompletionTracker shutting down');
		for (const [_queueName, queuePending] of this.pending.entries()) {
			for (const [_correlationId, completion] of queuePending.entries()) {
				if (completion.timeoutHandle) {
					clearTimeout(completion.timeoutHandle);
				}
				// Call error callback to properly reject any waiting promises
				if (completion.onError) {
					try {
						completion.onError(shutdownError);
					} catch {
						// Ignore errors in callback
					}
				}
			}
		}
		this.pending.clear();
		this.jobIdToCorrelationId.clear();
		this.earlyResults.clear();

		// Error handler for expected connection close errors during shutdown
		const connectionErrorHandler = (err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			// Expected during graceful shutdown - blocking commands get rejected
			if (message.includes('Connection is closed')) {
				return; // Silently ignore expected shutdown errors
			}
			this.logger.error('Redis connection error during shutdown', { error: message });
		};

		// Close all QueueEvents instances
		for (const events of this.queueEvents.values()) {
			// Add persistent error handler before close
			events.connection._client.on('error', connectionErrorHandler);
			await events.close();
		}
		this.queueEvents.clear();
	}
}
