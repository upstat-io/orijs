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
	EventSubscription
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
	private started = false;

	/**
	 * Creates a new BullMQEventProvider.
	 *
	 * @param options - Configuration including Redis connection
	 */
	public constructor(options: BullMQEventProviderOptions) {
		this.connection = options.connection;
		this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT_MS;

		// Use injected dependencies or create defaults
		this.queueManager =
			options.queueManager ??
			new QueueManager({
				connection: this.connection,
				defaultJobOptions: options.defaultJobOptions,
				defaultWorkerOptions: options.defaultWorkerOptions
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
			causationId: options?.causationId,
			timestamp: Date.now()
		};

		// Build job options
		// - delay: for delayed event delivery
		// - jobId: for idempotency (BullMQ ignores duplicate jobIds)
		const jobOptions = {
			...(options?.delay && { delay: options.delay }),
			...(options?.idempotencyKey && { jobId: options.idempotencyKey })
		};

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

		// Add job to queue
		this.queueManager
			.addJob(eventName, jobData, jobOptions)
			.then((job) => {
				// Map job ID for completion tracking
				this.completionTracker.mapJobId(queueName, job.id, subscription.correlationId);
			})
			.catch((error) => {
				// Handle job creation failure by properly cleaning up the completion tracker
				// This clears the pending entry, cancels any timeout, and triggers the error callback
				this.completionTracker.fail(queueName, subscription.correlationId, error);
			});

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
				causationId: job.data.causationId,
				timestamp: job.data.timestamp
			};

			return handler(message);
		};

		// Await worker registration to ensure it's ready before returning
		await this.queueManager.registerWorker(eventName, workerHandler);
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
	 * Starts the provider.
	 */
	public async start(): Promise<void> {
		this.started = true;
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
		this.started = false;

		// 1. Stop workers first (wait for jobs to complete), then queues
		await this.queueManager.stop();
		// 2. Stop listening for completions (workers already done)
		await this.completionTracker.stop();
		// 3. Stop scheduled event queues
		await this.scheduledEventManager.stop();
	}

	/**
	 * Returns whether the provider has been started.
	 */
	public isStarted(): boolean {
		return this.started;
	}
}
