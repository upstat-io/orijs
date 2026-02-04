/**
 * Test helper interfaces for factory pattern
 * @orijs/test-utils - Minimal test infrastructure for OriJS framework
 */

import type Redis from 'ioredis';
import type { Queue, Job } from 'bullmq';
import type { RedisContainerConfig } from './container-config.types';

export interface RedisTestHelper {
	/**
	 * Check if Redis container is ready for operations
	 */
	isReady(): boolean;

	/**
	 * Perform health check on Redis service
	 */
	healthCheck(): Promise<boolean>;

	/**
	 * Get Redis connection configuration
	 */
	getConnectionConfig(): RedisContainerConfig;

	/**
	 * Create an ioredis client (auto-connects, matches Postgres createSqlClient pattern)
	 */
	createRedisClient(): Redis;

	/**
	 * Set up environment variables for NestJS Redis module integration
	 * Sets SECRET_REDIS_HOST and SECRET_REDIS_PORT
	 * Matches Postgres setupNestJSEnvironment() pattern
	 */
	setupNestJSEnvironment(): { host: string; port: number };

	/**
	 * Flush all Redis data
	 */
	flushAll(): Promise<void>;

	/**
	 * Create a BullMQ queue with package isolation
	 */
	createQueue(queueName: string): Queue;

	/**
	 * Wait for queue job completion
	 */
	waitForJobCompletion(queueName: string, timeout?: number): Promise<Job>;

	/**
	 * Wait for Redis pub/sub event
	 */
	waitForEvent(channel: string, timeout?: number): Promise<string>;

	/**
	 * Get package name for this test helper
	 */
	getPackageName(): string;
}
