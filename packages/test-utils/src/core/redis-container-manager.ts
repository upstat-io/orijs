/**
 * Redis container manager with robust lifecycle management
 */

import type { StartedRedisContainer } from '@testcontainers/redis';
import { RedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { Queue, QueueEvents, type Job } from 'bullmq';
import { BaseContainerManager } from './base-container-manager';
import type { RedisContainerConfig } from '../types/container-config.types';

export class RedisContainerManager extends BaseContainerManager {
	private redisContainer: StartedRedisContainer | null = null;
	private redisClient: Redis | null = null;
	private queues: Map<string, Queue> = new Map();

	protected async createContainer(): Promise<StartedRedisContainer> {
		console.log(`Starting Redis container for ${this.packageName}...`);

		// Enable container reuse for local development (not in CI)
		// This dramatically speeds up subsequent test runs by keeping containers alive
		const enableReuse = !process.env.CI && process.env.TESTCONTAINERS_REUSE !== 'false';

		const container = new RedisContainer('redis:7.2')
			.withCommand(['redis-server', '--maxmemory-policy', 'noeviction', '--save', '', '--appendonly', 'no'])
			.withStartupTimeout(60_000);

		// Apply reuse if enabled (containers persist between test runs)
		if (enableReuse) {
			console.log(
				`Container reuse ENABLED for ${this.packageName} (set TESTCONTAINERS_REUSE=false to disable)`
			);
			this.redisContainer = await container.withReuse().start();
		} else {
			this.redisContainer = await container.start();
		}

		// Create Redis client
		this.redisClient = new Redis({
			host: this.redisContainer.getHost(),
			port: this.redisContainer.getPort(),
			maxRetriesPerRequest: 3,
			lazyConnect: true,
			keepAlive: 30000
		});

		this.redisClient.on('error', (err: Error) => {
			console.error(`Redis client error for ${this.packageName}:`, err);
		});

		await this.redisClient.connect();

		// NOTE: We intentionally do NOT set process.env here.
		// Setting global env vars causes race conditions when running tests in parallel.
		// Tests that need NestJS integration should call setupNestJSEnvironment() explicitly.

		console.log(`Redis container ready for ${this.packageName} on port ${this.redisContainer.getPort()}`);
		return this.redisContainer;
	}

	protected async performHealthCheck(): Promise<boolean> {
		if (!this.redisContainer || !this.redisClient) {
			return false;
		}

		try {
			const result = await this.redisClient.ping();
			return result === 'PONG';
		} catch (error) {
			console.warn(`Redis health check failed for ${this.packageName}:`, error);
			return false;
		}
	}

	protected getContainerImage(): string {
		return 'redis:7.2';
	}

	protected getContainerType(): string {
		return 'redis';
	}

	/**
	 * Get connection configuration
	 */
	getConnectionConfig(): RedisContainerConfig {
		if (!this.redisContainer) {
			throw new Error(`Redis container not started for ${this.packageName}`);
		}

		const host = this.redisContainer.getHost();
		const port = this.redisContainer.getPort();

		return {
			host,
			port,
			connectionString: `redis://${host}:${port}`
		};
	}

	/**
	 * Create ioredis client (auto-connects, matches Postgres createSqlClient pattern)
	 */
	createRedisClient(): Redis {
		const config = this.getConnectionConfig();

		const client = new Redis({
			host: config.host,
			port: config.port,
			maxRetriesPerRequest: 3,
			keepAlive: 30000
		});

		// Handle connection errors to prevent unhandled error events
		client.on('error', (err: Error) => {
			console.debug(`Redis client error for ${this.packageName}:`, err.message);
		});

		return client;
	}

	/**
	 * Set up environment variables for NestJS Redis module integration
	 * Matches Postgres setupNestJSEnvironment() pattern
	 */
	setupNestJSEnvironment(): { host: string; port: number } {
		const config = this.getConnectionConfig();
		process.env.SECRET_REDIS_HOST = config.host;
		process.env.SECRET_REDIS_PORT = String(config.port);
		return { host: config.host, port: config.port };
	}

	/**
	 * Get the main Redis client for this container
	 */
	getRedisClient(): Redis {
		if (!this.redisClient) {
			throw new Error(`Redis client not available for ${this.packageName} - container not started`);
		}
		return this.redisClient;
	}

	/**
	 * Flush all Redis data
	 */
	async flushAll(): Promise<void> {
		if (!this.redisClient) {
			return;
		}

		try {
			if (this.redisClient.status === 'ready') {
				await this.redisClient.flushall();
			}
		} catch (error) {
			console.warn(`Redis flush failed for ${this.packageName}:`, error);
		}
	}

	/**
	 * Create BullMQ queue with package isolation
	 */
	createQueue(queueName: string): Queue {
		if (!this.redisContainer) {
			throw new Error(`Redis container not started for ${this.packageName}`);
		}

		// Add package prefix to avoid conflicts
		const packageQueueName = `${this.packageName}-${queueName}`;

		if (this.queues.has(packageQueueName)) {
			return this.queues.get(packageQueueName)!;
		}

		const queue = new Queue(packageQueueName, {
			connection: this.getConnectionConfig(),
			defaultJobOptions: {
				removeOnComplete: 10,
				removeOnFail: 10
			}
		});

		this.queues.set(packageQueueName, queue);
		return queue;
	}

	/**
	 * Wait for queue job completion
	 */
	async waitForJobCompletion(queueName: string, timeout: number = 5000): Promise<Job> {
		const packageQueueName = `${this.packageName}-${queueName}`;
		const queue = this.queues.get(packageQueueName);

		if (!queue) {
			throw new Error(`Queue ${packageQueueName} not found`);
		}

		const queueEvents = new QueueEvents(packageQueueName, {
			connection: this.getConnectionConfig()
		});

		return new Promise((resolve, reject) => {
			const timer = setTimeout(async () => {
				await queueEvents.close();
				reject(new Error(`Job completion timeout after ${timeout}ms`));
			}, timeout);

			const completedHandler = async ({ jobId }: { jobId: string }) => {
				clearTimeout(timer);
				queueEvents.off('completed', completedHandler);
				queueEvents.off('failed', failedHandler);
				await queueEvents.close();
				const job = await queue.getJob(jobId);
				if (job) {
					resolve(job);
				} else {
					reject(new Error(`Job ${jobId} not found after completion`));
				}
			};

			const failedHandler = async ({ jobId, failedReason }: { jobId: string; failedReason: string }) => {
				clearTimeout(timer);
				queueEvents.off('completed', completedHandler);
				queueEvents.off('failed', failedHandler);
				await queueEvents.close();
				reject(new Error(`Job ${jobId} failed: ${failedReason}`));
			};

			queueEvents.on('completed', completedHandler);
			queueEvents.on('failed', failedHandler);
		});
	}

	/**
	 * Wait for Redis pub/sub event with package isolation
	 */
	async waitForEvent(channel: string, timeout: number = 5000): Promise<string> {
		if (!this.redisClient || this.redisClient.status !== 'ready') {
			throw new Error(`Redis client not available for ${this.packageName}`);
		}

		// Add package prefix to avoid conflicts
		const packageChannel = `${this.packageName}-${channel}`;

		// Capture reference to satisfy TypeScript null check in closure
		const client = this.redisClient;

		return new Promise((resolve, reject) => {
			const subscriber = client.duplicate();
			let isResolved = false;

			const cleanup = () => {
				if (!isResolved) {
					isResolved = true;
					try {
						subscriber.disconnect();
					} catch {
						// Ignore disconnect errors
					}
				}
			};

			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Event timeout after ${timeout}ms`));
			}, timeout);

			subscriber.on('message', (receivedChannel: string, message: string) => {
				if (receivedChannel === packageChannel && !isResolved) {
					isResolved = true;
					clearTimeout(timer);
					cleanup();
					resolve(message);
				}
			});

			subscriber.on('error', (error: Error) => {
				if (!isResolved) {
					isResolved = true;
					clearTimeout(timer);
					cleanup();
					reject(error);
				}
			});

			subscriber.subscribe(packageChannel).catch((error: Error) => {
				if (!isResolved) {
					isResolved = true;
					clearTimeout(timer);
					cleanup();
					reject(error);
				}
			});
		});
	}

	/**
	 * Cleanup queues and connections
	 */
	async cleanup(): Promise<void> {
		try {
			// Clean up queues
			const cleanupPromises = Array.from(this.queues.values()).map(async (queue) => {
				try {
					await queue.obliterate({ force: true });
					await queue.close();
				} catch (error) {
					console.debug(`Queue cleanup warning for ${this.packageName}:`, error);
				}
			});

			await Promise.allSettled(cleanupPromises);
			this.queues.clear();

			// Flush Redis data
			await this.flushAll();
		} catch (error) {
			console.debug(`Redis cleanup warning for ${this.packageName}:`, error);
		}
	}

	/**
	 * Override stop to include cleanup with timeout protection
	 */
	override async stop(): Promise<void> {
		try {
			// Add timeout to prevent hanging during cleanup
			await Promise.race([
				this.cleanup(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('Redis cleanup timeout')), 3000))
			]);

			if (this.redisClient) {
				try {
					// Quick disconnect with timeout
					await Promise.race([
						this.redisClient.quit(),
						new Promise((_, reject) => setTimeout(() => reject(new Error('Redis quit timeout')), 2000))
					]);
				} catch {
					// Force disconnect if quit times out
					this.redisClient.disconnect();
				}
				this.redisClient = null;
			}
		} catch (error) {
			console.debug(`Redis stop warning for ${this.packageName}:`, error);
			// Force disconnect on any error
			if (this.redisClient) {
				try {
					this.redisClient.disconnect();
				} catch {
					// Ignore disconnect errors
				}
				this.redisClient = null;
			}
		} finally {
			await super.stop();
		}
	}
}
