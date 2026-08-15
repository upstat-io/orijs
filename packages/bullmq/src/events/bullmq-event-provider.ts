/**
 * BullMQ Event Provider - Production-ready distributed event delivery.
 *
 * Implements EventProvider interface using BullMQ for distributed event
 * delivery across multiple instances.
 *
 * Uses composition pattern for better testability:
 * - QueueManager: manages per-event-type queues
 * - CompletionTracker: handles request-response via QueueEvents
 * - ScheduledEventManager: manages scheduled/cron events
 *
 * @module events/bullmq-event-provider
 */

import type {
	EventProvider,
	EventHandlerFn,
	EmitOptions,
	EventMessage,
	EventSubscription,
	PerEventConfig
} from '@orijs/events';
import type { PropagationMeta } from '@orijs/logging';
import { createSubscription, EVENT_MESSAGE_VERSION } from '@orijs/events';
import type { ConnectionOptions, JobsOptions, WorkerOptions } from 'bullmq';
import { QueueManager, type IQueueManager } from './queue-manager';
import { CompletionTracker, type ICompletionTracker } from './completion-tracker';
import {
	ScheduledEventManager,
	type IScheduledEventManager,
	type ScheduleOptions
} from './scheduled-event-manager';
import { DEFAULT_TIMEOUT_MS } from '../constants.ts';

/**
 * Full passthrough to BullMQ's JobsOptions for event provider.
 * Re-exported for convenience.
 */
export type { JobsOptions as BullMQEventJobOptions } from 'bullmq';

/**
 * Full passthrough to BullMQ's WorkerOptions for event provider.
 * Re-exported for convenience.
 */
export type { WorkerOptions as BullMQEventWorkerOptions } from 'bullmq';

/**
 * BullMQ Event Provider configuration.
 */
export interface BullMQEventProviderOptions {
	/**
	 * Redis connection options.
	 *
	 * Supports all ioredis connection options including:
	 * - host, port, password, db for basic connection
	 * - maxRetriesPerRequest, connectTimeout for resilience
	 * - tls for secure connections
	 *
	 * @example
	 * ```ts
	 * const provider = new BullMQEventProvider({
	 *   connection: {
	 *     host: 'redis',
	 *     port: 6379,
	 *     // Pool/connection options
	 *     maxRetriesPerRequest: 3,
	 *     enableReadyCheck: true,
	 *     connectTimeout: 10000,
	 *     // TLS options
	 *     tls: { rejectUnauthorized: true },
	 *   }
	 * });
	 * ```
	 */
	readonly connection: ConnectionOptions;
	/** Default timeout in milliseconds for request-response pattern (default: 30000) */
	readonly defaultTimeout?: number;
	/**
	 * Full BullMQ job options passthrough.
	 *
	 * Common options:
	 * - attempts: Max retry attempts (default: 3)
	 * - backoff: Retry strategy { type: 'exponential' | 'fixed', delay: number }
	 * - removeOnComplete: true | number (keep N jobs) | { age, count }
	 * - removeOnFail: false to keep failed jobs for DLQ inspection
	 *
	 * @example
	 * ```ts
	 * defaultJobOptions: {
	 *   attempts: 5,
	 *   backoff: { type: 'exponential', delay: 2000 },
	 *   removeOnComplete: { age: 3600 }, // Keep for 1 hour
	 *   removeOnFail: false, // Keep failed jobs (DLQ behavior)
	 * }
	 * ```
	 */
	readonly defaultJobOptions?: Partial<JobsOptions>;
	/**
	 * Full BullMQ worker options passthrough.
	 *
	 * Common options:
	 * - concurrency: Number of jobs to process in parallel (default: 1)
	 * - limiter: Rate limiting { max, duration }
	 * - stalledInterval: How often to check for stalled jobs (ms)
	 *
	 * @example
	 * ```ts
	 * defaultWorkerOptions: {
	 *   concurrency: 10,
	 *   limiter: { max: 100, duration: 1000 }, // 100 jobs per second
	 * }
	 * ```
	 */
	readonly defaultWorkerOptions?: Partial<WorkerOptions>;
	/** Interval in milliseconds between TTL sweep runs (default: 60000) */
	readonly sweepIntervalMs?: number;
	/** Maximum number of jobs to clean per sweep per event (default: 1000) */
	readonly sweepBatchLimit?: number;
	/** Optional QueueManager override (for testing) */
	readonly queueManager?: IQueueManager;
	/** Optional CompletionTracker override (for testing) */
	readonly completionTracker?: ICompletionTracker;
	/** Optional ScheduledEventManager override (for testing) */
	readonly scheduledEventManager?: IScheduledEventManager;
}

/**
 * BullMQ-based event provider for distributed event delivery.
 *
 * Features:
 * - Per-event-type queues for isolation and scaling
 * - Request-response pattern via QueueEvents
 * - Scheduled/cron events via repeatable jobs
 * - Context propagation (requestId, traceId, etc.)
 *
 * @example
 * ```ts
 * const provider = new BullMQEventProvider({
 *   connection: { host: 'redis', port: 6379 }
 * });
 *
 * // Subscribe to events
 * provider.subscribe('monitor.check', async (msg) => {
 *   console.log('Checking monitor:', msg.payload.monitorId);
 *   return { checked: true };
 * });
 *
 * // Emit event with request-response
 * provider.emit<{ checked: boolean }>('monitor.check', { monitorId: '123' }, {})
 *   .subscribe((result) => console.log('Result:', result));
 *
 * // Schedule recurring event
 * await provider.scheduleEvent('cleanup.run', {
 *   scheduleId: 'daily-cleanup',
 *   cron: '0 0 * * *',
 *   payload: {}
 * });
 *
 * await provider.start();
 * ```
 */
export class BullMQEventProvider implements EventProvider {
	private readonly connection: ConnectionOptions;
	private readonly defaultTimeout: number;
	private readonly queueManager: IQueueManager;
	private readonly completionTracker: ICompletionTracker;
	private readonly scheduledEventManager: IScheduledEventManager;
	private readonly eventTtls = new Map<string, number>();
	private readonly sweepIntervalMs: number;
	private readonly sweepBatchLimit: number;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	private stopping = false;
	private lifecycleController = new AbortController();
	private readonly enqueueTasks = new Set<Promise<void>>();

	/**
	 * Creates a new BullMQEventProvider.
	 *
	 * @param options - Configuration including Redis connection
	 */
	public constructor(options: BullMQEventProviderOptions) {
		this.connection = options.connection;
		this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT_MS;
		this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
		this.sweepBatchLimit = options.sweepBatchLimit ?? 1000;

		// Use injected dependencies or create defaults
		this.queueManager =
			options.queueManager ??
			new QueueManager({
				connection: this.connection,
				...(options.defaultJobOptions === undefined
					? {}
					: { defaultJobOptions: options.defaultJobOptions }),
				...(options.defaultWorkerOptions === undefined
					? {}
					: { defaultWorkerOptions: options.defaultWorkerOptions })
			});
		this.completionTracker =
			options.completionTracker ?? new CompletionTracker({ connection: this.connection });
		this.scheduledEventManager =
			options.scheduledEventManager ??
			new ScheduledEventManager({
				connection: this.connection,
				queueManager: this.queueManager
			});
	}

	/**
	 * Configures per-event settings (e.g., TTL).
	 * Called by the coordinator after provider is resolved.
	 */
	public configureEvent(eventName: string, config: PerEventConfig): void {
		if (config.ttl !== undefined) {
			this.eventTtls.set(eventName, config.ttl);
		}
	}

	/**
	 * Emits an event to subscribers.
	 *
	 * The event is added to a BullMQ queue and processed by workers.
	 * For request-response, subscribe to the returned EventSubscription.
	 *
	 * @template TReturn - Expected return type from handler
	 * @param eventName - The event name
	 * @param payload - The event payload
	 * @param meta - Propagation metadata
	 * @param options - Emit options (delay, causationId)
	 * @returns EventSubscription for tracking result/errors
	 */
	public emit<TReturn = void>(
		eventName: string,
		payload: unknown,
		meta: PropagationMeta,
		options?: EmitOptions
	): EventSubscription<TReturn> {
		const subscription = createSubscription<TReturn>();
		const queueName = this.queueManager.getQueueName(eventName);

		// Create job data
		const jobData: EventMessage = {
			version: EVENT_MESSAGE_VERSION,
			eventId: crypto.randomUUID(),
			eventName,
			payload,
			meta,
			correlationId: subscription.correlationId,
			...(options?.causationId === undefined ? {} : { causationId: options.causationId }),
			timestamp: Date.now(),
			...(options?.expectsResult === false && options.idempotencyKey
				? { idempotencyKey: options.idempotencyKey }
				: {})
		};

		// Build job options
		// - delay: for delayed event delivery
		// - jobId: for idempotency (BullMQ ignores duplicate jobIds)
		// - removeOnFail: auto-expire failed jobs for TTL events
		const ttl = this.eventTtls.get(eventName);
		const jobOptions = {
			...(options?.delay && { delay: options.delay }),
			jobId: options?.idempotencyKey ?? jobData.eventId,
			...(ttl !== undefined && { removeOnFail: { age: Math.ceil(ttl / 1000) } })
		};

		// A fire-and-forget emission settles on the enqueue outcome alone. Tracking
		// completion for it would couple the caller to consumer availability and to
		// the tracker's timeout, which is what `expectsResult: false` exists to avoid.
		if (options?.expectsResult === false) {
			const enqueue = async () => {
				if (
					options.idempotencyKey &&
					(await this.queueManager.hasCompletionReceipt?.(eventName, options.idempotencyKey))
				) {
					return;
				}
				await this.queueManager.addJob(eventName, jobData, jobOptions);
			};
			enqueue()
				.then(() => {
					subscription._resolve(undefined as TReturn);
				})
				.catch((error) => {
					// No tracker entry exists to fail, so reject the subscription directly.
					subscription._reject(error);
				});

			return subscription;
		}

		// Determine timeout: explicit option > default > 0 means no timeout
		const timeout = options?.timeout ?? this.defaultTimeout;

		// Register with completion tracker immediately (not on subscribe)
		// This avoids mutating the subscription object and eliminates timing dependencies
		this.completionTracker.register(
			queueName,
			subscription.correlationId,
			(result) => {
				subscription._resolve(result as TReturn);
			},
			(error) => {
				subscription._reject(error);
			},
			{ timeout }
		);

		// QueueEvents must own the completion stream before a fast worker can
		// finish; otherwise the completed event can be published before listening.
		const enqueue = async () => {
			if (this.completionTracker.waitUntilReady) {
				await this.waitForCompletionOwnership(queueName);
			} else if (this.stopping) {
				throw new Error('BullMQEventProvider is stopping');
			}
			this.completionTracker.mapJobId(queueName, jobOptions.jobId, subscription.correlationId);
			const job = await this.queueManager.addJob(eventName, jobData, jobOptions);
			const state = await job.getState?.();
			if (state === 'completed') {
				const retainedJob = (await this.queueManager.getJob?.(eventName, job.id)) ?? job;
				this.completionTracker.completeJob(queueName, job.id, retainedJob.returnvalue);
			} else if (state === 'failed') {
				this.completionTracker.failJob(
					queueName,
					job.id,
					new Error(job.failedReason ?? 'Event job failed')
				);
			}
			return;
		};
		const enqueueTask = enqueue()
			.catch((error) => {
				// Handle job creation failure by properly cleaning up the completion tracker
				// This clears the pending entry, cancels any timeout, and triggers the error callback
				this.completionTracker.fail(queueName, subscription.correlationId, error);
			})
			.finally(() => this.enqueueTasks.delete(enqueueTask));
		this.enqueueTasks.add(enqueueTask);

		return subscription;
	}

	/**
	 * Subscribes a handler to an event.
	 *
	 * Creates a BullMQ worker that processes jobs from the event's queue.
	 * Await this method to ensure the worker is ready before emitting events.
	 *
	 * @template TPayload - Expected payload type
	 * @template TReturn - Handler return type
	 * @param eventName - The event name to subscribe to
	 * @param handler - Handler function
	 */
	public async subscribe<TPayload = unknown, TReturn = void>(
		eventName: string,
		handler: EventHandlerFn<TPayload, TReturn>
	): Promise<void> {
		// Wrap handler to extract EventMessage from job data
		const workerHandler = async (job: { data: EventMessage }): Promise<TReturn> => {
			const message: EventMessage<TPayload> = {
				version: job.data.version,
				eventId: job.data.eventId,
				eventName: job.data.eventName,
				payload: job.data.payload as TPayload,
				meta: job.data.meta,
				correlationId: job.data.correlationId,
				...(job.data.causationId === undefined
					? {}
					: { causationId: job.data.causationId }),
				timestamp: job.data.timestamp
			};

			const result = await handler(message);
			if (job.data.idempotencyKey) {
				await this.queueManager.recordCompletionReceipt?.(eventName, job.data.idempotencyKey);
			}
			return result;
		};

		// Await worker registration to ensure it's ready before returning
		await this.queueManager.registerWorker(eventName, workerHandler, (jobId, result) => {
			this.completionTracker.completeJob(
				this.queueManager.getQueueName(eventName),
				jobId,
				result
			);
		});
	}

	/**
	 * Schedules a recurring event.
	 *
	 * Per user decision (Q1): Separate method rather than emit() with options.
	 *
	 * @param eventName - The event name
	 * @param options - Schedule configuration (cron or interval)
	 */
	public async scheduleEvent(eventName: string, options: ScheduleOptions): Promise<void> {
		await this.scheduledEventManager.schedule(eventName, options);
	}

	/**
	 * Removes a scheduled event.
	 *
	 * @param eventName - The event name
	 * @param scheduleId - The schedule ID to remove
	 */
	public async unscheduleEvent(eventName: string, scheduleId: string): Promise<void> {
		await this.scheduledEventManager.unschedule(eventName, scheduleId);
	}

	/**
	 * Cancels a pending delayed event by its key.
	 *
	 * Removes the job from the BullMQ queue by its jobId (which is the
	 * idempotency key or derived key from the event definition).
	 *
	 * @param eventName - The event name
	 * @param key - The key identifying the pending event (BullMQ jobId)
	 * @returns true if the event was found and cancelled, false otherwise
	 */
	public async cancel(eventName: string, key: string): Promise<boolean> {
		return this.queueManager.removeJob(eventName, key);
	}

	public async prepareIdempotencyKeyRetirement(eventName: string, key: string): Promise<void> {
		await this.queueManager.prepareCompletionReceiptRetirement?.(eventName, key);
	}

	public async finalizeIdempotencyKeyRetirement(eventName: string, key: string): Promise<void> {
		await this.queueManager.finalizeCompletionReceiptRetirement?.(eventName, key);
	}

	public async hasSuccessfulIdempotencyKeyCompletionReceipt(eventName: string, key: string): Promise<boolean> {
		return (await this.queueManager.hasSuccessfulCompletionReceipt?.(eventName, key)) ?? false;
	}

	public async hasRetainedEvent(eventName: string, eventId: string): Promise<boolean> {
		return (await this.queueManager.hasJob?.(eventName, eventId)) ?? true;
	}

	public async isRetainedEventRetryable(eventName: string, eventId: string): Promise<boolean> {
		return (await this.queueManager.isJobRetryable?.(eventName, eventId)) ?? true;
	}

	/**
	 * Starts the provider.
	 * If TTL events are configured, starts a periodic sweep to clean stale jobs.
	 */
	public async start(): Promise<void> {
		this.stopping = false;
		if (this.lifecycleController.signal.aborted) {
			this.lifecycleController = new AbortController();
		}
		this.completionTracker.start?.();
		this.started = true;

		// Start sweep interval if any events have TTL configured
		if (this.eventTtls.size > 0) {
			this.sweepTimer = setInterval(() => {
				this.sweepStaleJobs();
			}, this.sweepIntervalMs);
			this.sweepTimer.unref();
		}
	}

	/**
	 * Stops the provider gracefully.
	 *
	 * Shutdown order per BullMQ best practices:
	 * 1. QueueManager - Workers first (wait for current jobs), then Queues
	 * 2. CompletionTracker - QueueEvents (safe now since workers finished)
	 * 3. ScheduledEventManager - Scheduled queues last
	 *
	 * This order ensures:
	 * - Workers finish processing before QueueEvents closes
	 * - QueueEvents receives all completion events before closing
	 * - No pending completion callbacks get lost
	 */
	public async stop(): Promise<void> {
		// Idempotency guard - prevent double stop issues
		if (!this.started) {
			return;
		}
		this.stopping = true;
		this.lifecycleController.abort();
		this.started = false;

		// 0. Clear sweep interval before shutting down queues
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}

		// Settle enqueue ownership before closing the queues they target.
		await Promise.allSettled([...this.enqueueTasks]);
		// 1. Stop workers first (wait for jobs to complete), then queues
		await this.queueManager.stop();
		// 2. Stop listening for completions (workers already done)
		await this.completionTracker.stop();
		// 3. Stop scheduled event queues
		await this.scheduledEventManager.stop();
	}

	private async waitForCompletionOwnership(queueName: string): Promise<void> {
		if (!this.completionTracker.waitUntilReady) {
			if (this.stopping) throw new Error('BullMQEventProvider is stopping');
			return;
		}
		const signal = this.lifecycleController.signal;
		if (signal.aborted || this.stopping) throw new Error('BullMQEventProvider is stopping');
		let rejectStop!: (error: Error) => void;
		const stopped = new Promise<never>((_resolve, reject) => {
			rejectStop = reject;
		});
		const onStop = () => rejectStop(new Error('BullMQEventProvider is stopping'));
		signal.addEventListener('abort', onStop, { once: true });
		try {
			await Promise.race([this.completionTracker.waitUntilReady(queueName), stopped]);
		} finally {
			signal.removeEventListener('abort', onStop);
		}
		if (this.stopping) throw new Error('BullMQEventProvider is stopping');
	}

	/**
	 * Sweeps stale waiting and failed jobs for all events with TTL configured.
	 * Best-effort: errors are caught silently to avoid crashing the sweep loop.
	 */
	private sweepStaleJobs(): void {
		for (const [eventName, ttl] of this.eventTtls) {
			this.queueManager.cleanJobs(eventName, ttl, this.sweepBatchLimit, 'wait').catch(() => {});
			this.queueManager.cleanJobs(eventName, ttl, this.sweepBatchLimit, 'failed').catch(() => {});
		}
	}

	/**
	 * Returns whether the provider has been started.
	 */
	public isStarted(): boolean {
		return this.started;
	}
}
