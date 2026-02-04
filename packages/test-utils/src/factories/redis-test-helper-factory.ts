/**
 * Redis test helper factory
 * Creates package-isolated Redis test helpers
 */

import { RedisContainerManager } from '../core/redis-container-manager';
import type { RedisTestHelper } from '../types/test-helper.types';

// Extend global type to include our custom properties
declare global {
	// eslint-disable-next-line no-var
	var __REDIS_MANAGERS__: Map<string, RedisContainerManager> | undefined;
}

// Global container managers by package name
const globalRedisManagers = new Map<string, RedisContainerManager>();

/**
 * Create a Redis test helper for a specific package
 * Follows the factory pattern used by integration-shared
 */
export function createRedisTestHelper(packageName: string): RedisTestHelper {
	// Get or create the container manager for this package
	let manager = globalRedisManagers.get(packageName);
	if (!manager && typeof global !== 'undefined' && global.__REDIS_MANAGERS__) {
		// Try to get from global Jest setup
		manager = global.__REDIS_MANAGERS__.get(packageName);
		if (manager) {
			globalRedisManagers.set(packageName, manager);
		}
	}
	if (!manager) {
		manager = new RedisContainerManager(packageName);
		globalRedisManagers.set(packageName, manager);
	}

	return {
		isReady(): boolean {
			return manager!.isReady();
		},

		async healthCheck(): Promise<boolean> {
			return manager!.healthCheck();
		},

		getConnectionConfig() {
			return manager!.getConnectionConfig();
		},

		createRedisClient() {
			return manager!.createRedisClient();
		},

		setupNestJSEnvironment() {
			return manager!.setupNestJSEnvironment();
		},

		async flushAll(): Promise<void> {
			return manager!.flushAll();
		},

		createQueue(queueName: string) {
			return manager!.createQueue(queueName);
		},

		async waitForJobCompletion(queueName: string, timeout?: number): Promise<any> {
			return manager!.waitForJobCompletion(queueName, timeout);
		},

		async waitForEvent(channel: string, timeout?: number): Promise<string> {
			return manager!.waitForEvent(channel, timeout);
		},

		getPackageName(): string {
			return packageName;
		}
	};
}

/**
 * Start Redis container for a package (used by Jest global setup)
 */
export async function startRedisTestContainer(packageName: string): Promise<void> {
	let manager = globalRedisManagers.get(packageName);
	if (!manager) {
		manager = new RedisContainerManager(packageName);
		globalRedisManagers.set(packageName, manager);
	}

	await manager.start();

	// Store global reference for Jest tests to access
	if (typeof global !== 'undefined') {
		global.__REDIS_MANAGERS__ = globalRedisManagers;
	}
}

/**
 * Stop Redis container for a package (used by Jest global teardown)
 */
export async function stopRedisTestContainer(packageName: string): Promise<void> {
	const manager = globalRedisManagers.get(packageName);
	if (manager) {
		await manager.stop();
		globalRedisManagers.delete(packageName);
	}
}

/**
 * Stop all Redis containers (emergency cleanup)
 */
export async function stopAllRedisTestContainers(): Promise<void> {
	const stopPromises = Array.from(globalRedisManagers.values()).map((manager) =>
		manager.stop().catch((error) => console.warn('Failed to stop Redis container:', error))
	);

	await Promise.allSettled(stopPromises);
	globalRedisManagers.clear();
}

// Process cleanup handlers
process.on('exit', () => {
	const managers = Array.from(globalRedisManagers.values());
	for (const manager of managers) {
		try {
			manager.forceStop();
		} catch {
			// Ignore cleanup errors during exit
		}
	}
});

process.on('SIGINT', async () => {
	await stopAllRedisTestContainers();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await stopAllRedisTestContainers();
	process.exit(0);
});
