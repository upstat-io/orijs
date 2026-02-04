/**
 * Scheduled Event Manager - Manages scheduled/recurring events.
 *
 * Uses BullMQ's repeatable jobs feature to schedule events that fire
 * on a cron pattern or at fixed intervals.
 *
 * Per user decision (Q1): Separate scheduleEvent() method rather than
 * emit() with options.
 *
 * @module events/scheduled-event-manager
 */

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { Logger } from '@orijs/logging';

/**
 * Default queue name prefix for scheduled events.
 */
const DEFAULT_SCHEDULED_PREFIX = 'scheduled';

/**
 * Schedule configuration using cron pattern.
 */
export interface CronSchedule {
	/** Unique schedule ID */
	readonly scheduleId: string;
	/** Cron pattern (e.g., '0 * * * *' for hourly) */
	readonly cron: string;
	/** Event payload */
	readonly payload: unknown;
	/** Optional event metadata */
	readonly meta?: Record<string, unknown>;
}

/**
 * Schedule configuration using fixed interval.
 */
export interface IntervalSchedule {
	/** Unique schedule ID */
	readonly scheduleId: string;
	/** Interval in milliseconds */
	readonly every: number;
	/** Event payload */
	readonly payload: unknown;
	/** Optional event metadata */
	readonly meta?: Record<string, unknown>;
}

/**
 * Combined schedule options.
 */
export type ScheduleOptions = CronSchedule | IntervalSchedule;

/**
 * Stored schedule information.
 */
export interface ScheduleInfo {
	readonly scheduleId: string;
	readonly eventName: string;
	readonly cron?: string;
	readonly every?: number;
	readonly payload: unknown;
	readonly repeatJobKey: string;
}

/**
 * Internal ioredis client interface.
 */
interface IScheduleRedisClient {
	on(event: string, handler: (...args: unknown[]) => void): this;
}

/**
 * BullMQ's RedisConnection exposes _client for accessing the underlying ioredis client.
 */
interface IScheduleRedisConnection {
	_client: IScheduleRedisClient;
}

/**
 * Interface for queue operations (for testing).
 */
export interface IScheduleQueueLike {
	add(name: string, data: unknown, opts?: JobsOptions): Promise<{ id: string; repeatJobKey?: string }>;
	removeRepeatableByKey(key: string): Promise<boolean>;
	on(event: string, callback: (...args: unknown[]) => void): void;
	close(): Promise<void>;
	/**
	 * Main ioredis connection.
	 * Exposed for adding error handlers that persist through close().
	 */
	connection: IScheduleRedisConnection;
}

/**
 * Scheduled event manager configuration.
 */
export interface ScheduledEventManagerOptions {
	/** Redis connection options */
	readonly connection: ConnectionOptions;
	/** Queue name prefix (default: 'scheduled') */
	readonly queuePrefix?: string;
	/** Optional queue class override (for testing) */
	readonly QueueClass?: new (name: string, options: { connection: ConnectionOptions }) => IScheduleQueueLike;
	/** Optional logger for error reporting */
	readonly logger?: Logger;
}

/**
 * Interface for scheduled event management.
 */
export interface IScheduledEventManager {
	/** Schedule a recurring event */
	schedule(eventName: string, options: ScheduleOptions): Promise<void>;
	/** Remove a scheduled event */
	unschedule(eventName: string, scheduleId: string): Promise<void>;
	/** Get all schedules for an event type */
	getSchedules(eventName: string): ScheduleInfo[];
	/** Stop and clean up */
	stop(): Promise<void>;
}

/**
 * Manages scheduled/recurring events using BullMQ repeatable jobs.
 *
 * @example
 * ```ts
 * const manager = new ScheduledEventManager({
 *   connection: { host: 'localhost', port: 6379 }
 * });
 *
 * // Schedule event with cron pattern
 * await manager.schedule('monitor.check', {
 *   scheduleId: 'hourly-monitors',
 *   cron: '0 * * * *', // Every hour
 *   payload: { checkAll: true }
 * });
 *
 * // Schedule event with fixed interval
 * await manager.schedule('health.ping', {
 *   scheduleId: 'health-check',
 *   every: 30000, // Every 30 seconds
 *   payload: {}
 * });
 *
 * // Remove a schedule
 * await manager.unschedule('monitor.check', 'hourly-monitors');
 * ```
 */
export class ScheduledEventManager implements IScheduledEventManager {
	private readonly connection: ConnectionOptions;
	private readonly queuePrefix: string;
	private readonly logger?: Logger;
	private readonly queues = new Map<string, IScheduleQueueLike>();
	private readonly schedules = new Map<string, Map<string, ScheduleInfo>>();
	private readonly QueueClass: new (
		name: string,
		options: { connection: ConnectionOptions }
	) => IScheduleQueueLike;

	/**
	 * Creates a new ScheduledEventManager.
	 *
	 * @param options - Configuration including Redis connection
	 */
	public constructor(options: ScheduledEventManagerOptions) {
		this.connection = options.connection;
		this.queuePrefix = options.queuePrefix ?? DEFAULT_SCHEDULED_PREFIX;
		this.logger = options.logger;
		this.QueueClass = options.QueueClass ?? (Queue as unknown as typeof this.QueueClass);
	}

	/**
	 * Gets queue name for scheduled events.
	 * Uses separate prefix from regular events.
	 */
	private getQueueName(eventName: string): string {
		return `${this.queuePrefix}.${eventName}`;
	}

	/**
	 * Gets or creates a queue for scheduled events.
	 */
	private getQueue(eventName: string): IScheduleQueueLike {
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
			this.logger?.error('Scheduled queue error', { eventName, error: message });
		});

		this.queues.set(queueName, queue);
		return queue;
	}

	/**
	 * Type guard for cron schedule.
	 */
	private isCronSchedule(options: ScheduleOptions): options is CronSchedule {
		return 'cron' in options && options.cron !== undefined;
	}

	/**
	 * Type guard for interval schedule.
	 */
	private isIntervalSchedule(options: ScheduleOptions): options is IntervalSchedule {
		return 'every' in options && options.every !== undefined;
	}

	/**
	 * Validates a cron pattern.
	 * Checks for basic format: 5 or 6 space-separated fields.
	 */
	private validateCronPattern(pattern: string): void {
		const parts = pattern.trim().split(/\s+/);
		// Standard cron has 5 fields, some implementations support 6 (with seconds)
		if (parts.length < 5 || parts.length > 6) {
			throw new Error(
				`Invalid cron pattern "${pattern}": expected 5-6 space-separated fields, got ${parts.length}`
			);
		}
	}

	/**
	 * Validates an interval value.
	 * Must be a positive integer in milliseconds.
	 */
	private validateInterval(interval: number): void {
		if (!Number.isInteger(interval)) {
			throw new Error(`Invalid interval: must be an integer, got ${interval}`);
		}
		if (interval <= 0) {
			throw new Error(`Invalid interval: must be positive, got ${interval}`);
		}
	}

	/**
	 * Schedules a recurring event.
	 *
	 * @param eventName - The event name
	 * @param options - Schedule configuration (cron or interval)
	 */
	public async schedule(eventName: string, options: ScheduleOptions): Promise<void> {
		// Validate options
		const hasCron = this.isCronSchedule(options);
		const hasEvery = this.isIntervalSchedule(options);

		if (!hasCron && !hasEvery) {
			throw new Error('Either cron or every must be specified');
		}

		if (hasCron && hasEvery) {
			throw new Error('Cannot specify both cron and every');
		}

		// Validate cron pattern (basic format check)
		if (hasCron) {
			this.validateCronPattern(options.cron);
		}

		// Validate interval (must be positive)
		if (hasEvery) {
			this.validateInterval(options.every);
		}

		const queue = this.getQueue(eventName);

		// Build repeat options
		const repeatOptions: { pattern?: string; every?: number } = {};
		if (hasCron) {
			repeatOptions.pattern = options.cron;
		} else if (hasEvery) {
			repeatOptions.every = options.every;
		}

		// Add job data
		const jobData = {
			payload: options.payload,
			meta: options.meta ?? {},
			scheduledAt: Date.now()
		};

		// Add repeatable job
		const job = await queue.add('event', jobData, {
			repeat: repeatOptions,
			jobId: options.scheduleId
		});

		// Store schedule info
		let eventSchedules = this.schedules.get(eventName);
		if (!eventSchedules) {
			eventSchedules = new Map();
			this.schedules.set(eventName, eventSchedules);
		}

		const scheduleInfo: ScheduleInfo = {
			scheduleId: options.scheduleId,
			eventName,
			cron: hasCron ? options.cron : undefined,
			every: hasEvery ? options.every : undefined,
			payload: options.payload,
			repeatJobKey: job.repeatJobKey ?? ''
		};

		eventSchedules.set(options.scheduleId, scheduleInfo);
	}

	/**
	 * Removes a scheduled event.
	 *
	 * @param eventName - The event name
	 * @param scheduleId - The schedule ID to remove
	 */
	public async unschedule(eventName: string, scheduleId: string): Promise<void> {
		const eventSchedules = this.schedules.get(eventName);
		if (!eventSchedules) {
			// No schedules for this event, nothing to do
			return;
		}

		const scheduleInfo = eventSchedules.get(scheduleId);
		if (!scheduleInfo) {
			// Schedule doesn't exist, nothing to do
			return;
		}

		// Remove from BullMQ
		const queue = this.getQueue(eventName);
		await queue.removeRepeatableByKey(scheduleInfo.repeatJobKey);

		// Remove from local tracking
		eventSchedules.delete(scheduleId);
	}

	/**
	 * Gets all schedules for an event type.
	 *
	 * @param eventName - The event name
	 * @returns Array of schedule info
	 */
	public getSchedules(eventName: string): ScheduleInfo[] {
		const eventSchedules = this.schedules.get(eventName);
		if (!eventSchedules) {
			return [];
		}
		return Array.from(eventSchedules.values());
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
		// Error handler for expected connection close errors during shutdown
		const connectionErrorHandler = (err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			// Expected during graceful shutdown - blocking commands get rejected
			if (message.includes('Connection is closed')) {
				return; // Silently ignore expected shutdown errors
			}
			this.logger?.error('Redis connection error during shutdown', { error: message });
		};

		for (const queue of this.queues.values()) {
			// Add persistent error handler before close
			queue.connection._client.on('error', connectionErrorHandler);
			await queue.close();
		}
		this.queues.clear();
		this.schedules.clear();
	}
}
