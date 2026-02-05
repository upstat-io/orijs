/**
 * Queue Manager - Manages BullMQ queues for per-event-type routing.
 *
 * Creates separate queues for each event type following BullMQ best practices:
 * - event.monitor.check
 * - event.alert.triggered
 * - workflow:MonitorAlertWorkflow
 *
 * Uses composition pattern for testability (injectable Queue/Worker classes).
 *
 * @module events/queue-manager
 */

import {
	Queue,
	Worker,
	type Job,
	type JobsOptions,
	type WorkerOptions,
	type ConnectionOptions
} from 'bullmq';
import type { Logger } from '@orijs/logging';

/**
 * Full passthrough to BullMQ's JobsOptions.
 * Allows configuration of retries, backoff, keepJobs, removeOnComplete, etc.
 */
export type { JobsOptions as BullMQJobOptions } from 'bullmq';

/**
 * Full passthrough to BullMQ's WorkerOptions.
 * Allows configuration of concurrency, limiter, stalledInterval, etc.
 */
export type { WorkerOptions as BullMQWorkerOptions } from 'bullmq';

/**
 * Job handler function type.
 */
export type JobHandler<TResult = unknown> = (job: Job) => Promise<TResult>;

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
 * Interface for queue operations (for testing).
 */
export interface IQueueLike {
	add(name: string, data: unknown, opts?: JobsOptions): Promise<{ id: string }>;
	on(event: string, callback: (...args: unknown[]) => void): void;
	close(): Promise<void>;
	/** Main ioredis connection - exposed for adding error handlers that persist through close() */
	connection: IRedisConnection;
}

/**
 * Interface for worker operations (for testing).
 */
export interface IWorkerLike {
	on(event: string, callback: (...args: unknown[]) => void): void;
	close(): Promise<void>;
	/** Wait until worker is connected and ready to process jobs */
	waitUntilReady(): Promise<unknown>;
	/** Main ioredis connection - exposed for adding error handlers that persist through close() */
	connection: IRedisConnection;
	/** Blocking ioredis connection - exposed for adding error handlers that persist through close() */
	blockingConnection: IRedisConnection;
}

/**
 * Default queue name prefix for event queues.
 */
const DEFAULT_QUEUE_PREFIX = 'event';

/**
 * Metrics hooks for queue observability.
 *
 * @example
 * ```ts
 * const metrics: QueueMetrics = {
 *   onJobAdded: (eventName, jobId) => prometheus.jobsCreated.inc({ event: eventName }),
 *   onJobCompleted: (eventName, jobId, duration) => prometheus.jobDuration.observe({ event: eventName }, duration),
 *   onJobFailed: (eventName, jobId, error) => prometheus.jobsFailed.inc({ event: eventName }),
 * };
 * ```
 */
export interface QueueMetrics {
	/** Called when a job is added to a queue */
	onJobAdded?(eventName: string, jobId: string): void;
	/** Called when a job completes successfully */
	onJobCompleted?(eventName: string, jobId: string, durationMs: number): void;
	/** Called when a job fails */
	onJobFailed?(eventName: string, jobId: string, error: Error): void;
}

/**
 * Default retry configuration for failed jobs.
 */
export interface RetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	readonly attempts?: number;
	/** Backoff strategy: 'exponential' or 'fixed' (default: 'exponential') */
	readonly backoffType?: 'exponential' | 'fixed';
	/** Initial delay in milliseconds for backoff (default: 1000) */
	readonly backoffDelay?: number;
}

/**
 * Queue manager configuration options.
 */
export interface QueueManagerOptions {
	/** Redis connection options */
	readonly connection: ConnectionOptions;
	/** Queue name prefix (default: 'event') */
	readonly queuePrefix?: string;
	/** Optional metrics hooks for observability */
	readonly metrics?: QueueMetrics;
	/** Default retry configuration for failed jobs (simplified interface) */
	readonly defaultRetry?: RetryOptions;
	/**
	 * Full BullMQ job options passthrough.
	 * These are merged with defaultRetry (this takes precedence).
	 *
	 * Common options:
	 * - attempts: Max retry attempts
	 * - backoff: Retry strategy { type: 'exponential' | 'fixed', delay: number }
	 * - removeOnComplete: true | number (keep N jobs) | { age, count }
	 * - removeOnFail: true | number | { age, count }
	 *
	 * @example
	 * ```ts
	 * defaultJobOptions: {
	 *   attempts: 5,
	 *   backoff: { type: 'exponential', delay: 2000 },
	 *   removeOnComplete: { age: 3600 }, // Keep for 1 hour
	 *   removeOnFail: false, // Keep failed jobs for inspection
	 * }
	 * ```
	 */
	readonly defaultJobOptions?: Partial<JobsOptions>;
	/**
	 * Full BullMQ worker options passthrough.
	 *
	 * Common options:
	 * - concurrency: Number of jobs to process in parallel
	 * - limiter: Rate limiting { max, duration }
	 * - stalledInterval: How often to check for stalled jobs
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
	/** Optional queue class override (for testing) */
	readonly QueueClass?: new (name: string, options: { connection: ConnectionOptions }) => IQueueLike;
	/** Optional worker class override (for testing) */
	readonly WorkerClass?: new (
		name: string,
		processor: (job: Job) => Promise<unknown>,
		options: { connection: ConnectionOptions }
	) => IWorkerLike;
	/** Optional logger for error reporting */
	readonly logger?: Logger;
}

/**
 * Queue Manager interface for dependency injection.
 */
export interface IQueueManager {
	/** Convert event name to queue name */
	getQueueName(eventName: string): string;
	/** Get or create a queue for an event type */
	getQueue(eventName: string): IQueueLike;
	/** Add a job to an event queue */
	addJob<TData = unknown>(eventName: string, data: TData, options?: JobsOptions): Promise<{ id: string }>;
	/** Register a worker for an event type */
	registerWorker<TResult = unknown>(eventName: string, handler: JobHandler<TResult>): Promise<void>;
	/** Stop all queues and workers */
	stop(): Promise<void>;
}

/**
 * Manages BullMQ queues with per-event-type routing.
 *
 * Each event type gets its own queue, allowing:
 * - Independent scaling (more workers for busy events)
 * - Isolation (one event type's issues don't block others)
 * - Clear monitoring (see queue depth per event type)
 *
 * @example
 * ```ts
 * const manager = new QueueManager({
 *   connection: { host: 'localhost', port: 6379 }
 * });
 *
 * // Register a worker for an event type
 * manager.registerWorker('monitor.check', async (job) => {
 *   const { payload, meta } = job.data;
 *   // Process event...
 *   return { processed: true };
 * });
 *
 * // Add a job (emit an event)
 * await manager.addJob('monitor.check', {
 *   payload: { monitorId: '123' },
 *   meta: { request_id: 'req-1' }
 * });
 * ```
 */
export class QueueManager implements IQueueManager {
	private readonly connection: ConnectionOptions;
	private readonly queuePrefix: string;
	private readonly metrics?: QueueMetrics;
	private readonly logger?: Logger;
	private readonly defaultRetry: Required<RetryOptions>;
	private readonly defaultJobOptions: Partial<JobsOptions>;
	private readonly defaultWorkerOptions: Partial<WorkerOptions>;
	private readonly queues = new Map<string, IQueueLike>();
	private readonly workers = new Map<string, IWorkerLike>();
	private readonly QueueClass: new (name: string, options: { connection: ConnectionOptions }) => IQueueLike;
	private readonly WorkerClass: new (
		name: string,
		processor: (job: Job) => Promise<unknown>,
		options: { connection: ConnectionOptions }
	) => IWorkerLike;

	/**
	 * Creates a new QueueManager.
	 *
	 * @param options - Configuration including Redis connection
	 */
	public constructor(options: QueueManagerOptions) {
		this.connection = options.connection;
		this.queuePrefix = options.queuePrefix ?? DEFAULT_QUEUE_PREFIX;
		this.metrics = options.metrics;
		this.logger = options.logger;
		this.defaultRetry = {
			attempts: options.defaultRetry?.attempts ?? 3,
			backoffType: options.defaultRetry?.backoffType ?? 'exponential',
			backoffDelay: options.defaultRetry?.backoffDelay ?? 1000
		};
		this.defaultJobOptions = options.defaultJobOptions ?? {};
		// Default concurrency of 10 for I/O-bound event handlers
		this.defaultWorkerOptions = {
			concurrency: 10,
			...options.defaultWorkerOptions
		};
		this.QueueClass = options.QueueClass ?? (Queue as unknown as typeof this.QueueClass);
		this.WorkerClass = options.WorkerClass ?? (Worker as unknown as typeof this.WorkerClass);
	}

	/**
	 * Converts event name to queue name.
	 *
	 * @param eventName - The event name (e.g., 'monitor.check')
	 * @returns Queue name (e.g., 'event.monitor.check')
	 */
	public getQueueName(eventName: string): string {
		return `${this.queuePrefix}.${eventName}`;
	}

	/**
	 * Gets or creates a queue for an event type.
	 *
	 * @param eventName - The event name
	 * @returns The queue instance
	 */
	public getQueue(eventName: string): IQueueLike {
		const queueName = this.getQueueName(eventName);

		const existingQueue = this.queues.get(queueName);
		if (existingQueue) {
			return existingQueue;
		}

		const queue = new this.QueueClass(queueName, {
			connection: this.connection
		});

		// Handle queue errors per BullMQ docs
		queue.on('error', (err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			this.logger?.error('Queue error', { eventName, error: message });
		});

		this.queues.set(queueName, queue);
		return queue;
	}

	/**
	 * Adds a job to an event queue.
	 *
	 * @param eventName - The event name
	 * @param data - Job data (typically { payload, meta, correlationId })
	 * @param options - Optional job options (delay, attempts, etc.)
	 * @returns The created job reference
	 */
	public async addJob<TData = unknown>(
		eventName: string,
		data: TData,
		options?: JobsOptions
	): Promise<{ id: string }> {
		const queue = this.getQueue(eventName);

		// Merge options: defaultRetry (base) -> defaultJobOptions -> caller options (highest precedence)
		const jobOptions: JobsOptions = {
			attempts: this.defaultRetry.attempts,
			backoff: {
				type: this.defaultRetry.backoffType,
				delay: this.defaultRetry.backoffDelay
			},
			...this.defaultJobOptions,
			...options // Allow caller to override all defaults
		};

		const job = await queue.add('event', data, jobOptions);

		// Call metrics hook if configured
		this.metrics?.onJobAdded?.(eventName, job.id);

		return { id: job.id };
	}

	/**
	 * Registers a worker for an event type.
	 *
	 * The worker will process jobs from the event's queue.
	 * Job data contains { payload, meta, correlationId }.
	 *
	 * @param eventName - The event name to handle
	 * @param handler - Handler function for processing jobs
	 */
	public async registerWorker<TResult = unknown>(
		eventName: string,
		handler: JobHandler<TResult>
	): Promise<void> {
		const queueName = this.getQueueName(eventName);

		// Track job start times for duration metrics
		const jobStartTimes = new Map<string, number>();

		const worker = new this.WorkerClass(
			queueName,
			async (job: Job): Promise<TResult> => {
				jobStartTimes.set(job.id!, Date.now());
				return handler(job);
			},
			{
				connection: this.connection,
				...this.defaultWorkerOptions
			}
		);

		// Handle worker errors
		worker.on('error', (err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			this.logger?.error('Worker error', { eventName, error: message });
		});

		// Add metrics event listeners if configured
		if (this.metrics) {
			worker.on('completed', (...args: unknown[]) => {
				const arg = args[0] as { id?: string };
				const jobId = arg?.id ?? 'unknown';
				const startTime = jobStartTimes.get(jobId);
				const duration = startTime ? Date.now() - startTime : 0;
				jobStartTimes.delete(jobId);
				this.metrics?.onJobCompleted?.(eventName, jobId, duration);
			});

			worker.on('failed', (...args: unknown[]) => {
				const arg = args[0] as { id?: string };
				const err = args[1] as Error | undefined;
				const jobId = arg?.id ?? 'unknown';
				jobStartTimes.delete(jobId);
				this.metrics?.onJobFailed?.(eventName, jobId, err ?? new Error('Unknown error'));
			});
		}

		// CRITICAL: Wait for worker to be connected and ready to process jobs.
		// Without this, jobs added immediately after registration may complete
		// before the worker is connected, causing race conditions.
		await worker.waitUntilReady();

		// Store worker for cleanup
		this.workers.set(queueName, worker);

		this.logger?.info(`Event Worker Created -> [${queueName}]`, {
			concurrency: this.defaultWorkerOptions.concurrency ?? 1
		});
	}

	/**
	 * Stops all queues and workers gracefully.
	 *
	 * Shutdown order per BullMQ best practices:
	 * 1. Workers first (stop processing, wait for current jobs to finish)
	 * 2. Then queues (close producer connections)
	 *
	 * Worker.close() without force parameter waits for current jobs to finalize.
	 *
	 * BUG WORKAROUND: BullMQ's RedisConnection.close() removes error handlers in its
	 * finally block BEFORE all async operations complete. This causes ioredis errors
	 * (especially "Connection is closed" from blocking commands like BRPOPLPUSH) to
	 * become unhandled. We add our own error handlers to the internal ioredis clients
	 * that persist through close().
	 */
	public async stop(): Promise<void> {
		// Error handler for expected connection close errors during shutdown
		const connectionErrorHandler = (err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			// Expected during graceful shutdown - blocking commands get rejected
			if (message.includes('Connection is closed')) {
				return; // Silently ignore expected shutdown errors
			}
			this.logger?.error('Redis connection error during shutdown', { error: message });
		};

		// Close workers first (stop processing, wait for jobs to finish)
		for (const worker of this.workers.values()) {
			// Add persistent error handlers before close
			worker.connection._client.on('error', connectionErrorHandler);
			worker.blockingConnection._client.on('error', connectionErrorHandler);
			// close() without force=true waits for current jobs to complete
			await worker.close();
		}
		this.workers.clear();

		// Then close queues
		for (const queue of this.queues.values()) {
			// Add persistent error handler before close
			queue.connection._client.on('error', connectionErrorHandler);
			await queue.close();
		}
		this.queues.clear();
	}
}
