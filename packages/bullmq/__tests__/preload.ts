/**
 * Bun test preload for ori-bullmq integration tests.
 *
 * Sets up Redis testcontainer for BullMQ queue tests using @orijs/test-utils.
 * Provides utilities for test isolation:
 * - Unique event names per test file to prevent parallel test interference
 * - Unique queue prefixes per test to prevent parallel test file interference
 */

import { createBunTestPreload, createRedisTestHelper } from '@orijs/test-utils';
import { WorkflowStepError } from '@orijs/workflows';

const PACKAGE_NAME = '@orijs/bullmq';

// Handle expected test rejections.
// WorkflowStepError is deliberately thrown by error handling tests and caught by our code,
// but Bun's test runner may report it as unhandled due to how BullMQ processes jobs async.
const isExpectedTestError = (reason: unknown): boolean => {
	if (reason instanceof WorkflowStepError) return true;
	// Error handling tests intentionally trigger job failures
	if (reason instanceof Error && reason.message.includes('Handler failed')) return true;
	// Expected during graceful shutdown - blocking commands get rejected when connection closes
	if (reason instanceof Error && reason.message.includes('Connection is closed')) return true;
	return false;
};

process.on('unhandledRejection', (reason: unknown) => {
	if (isExpectedTestError(reason)) {
		return; // Silently ignore expected test errors
	}
	console.error('[ori-bullmq] Unexpected unhandled rejection:', reason);
});

// Also handle uncaught exceptions (ioredis may emit errors on 'error' event that become uncaught)
process.on('uncaughtException', (err: Error) => {
	// Expected during graceful shutdown
	if (err.message.includes('Connection is closed')) {
		return; // Silently ignore expected shutdown errors
	}
	console.error('[ori-bullmq] Uncaught exception:', err);
});

// Redis test helper for getting connection options
const redisHelper = createRedisTestHelper(PACKAGE_NAME);

/**
 * Get Redis connection options for BullMQ.
 * Throws if container not started.
 */
export function getRedisConnectionOptions(): { host: string; port: number } {
	if (!redisHelper.isReady()) {
		throw new Error('Redis container not started. Run preload first.');
	}
	return redisHelper.getConnectionConfig();
}

/**
 * Check if Redis container is ready.
 */
export function isRedisReady(): boolean {
	return redisHelper.isReady();
}

/**
 * Creates a unique event name factory for a test file.
 * Prevents queue name collisions when test files run in parallel.
 *
 * @param testFileId - Unique identifier for the test file (e.g., 'integration', 'scenario')
 * @returns Function that creates unique event names
 *
 * @example
 * ```ts
 * const eventName = createEventName('integration');
 * const queueName = eventName('test.event'); // Returns 'integration-abc123.test.event'
 * ```
 */
export function createEventName(testFileId: string): (baseName: string) => string {
	// Generate unique suffix per test file instance
	const suffix = Math.random().toString(36).substring(2, 8);
	const prefix = `${testFileId}-${suffix}`;

	return (baseName: string) => `${prefix}.${baseName}`;
}

/**
 * Polls until a condition is met or timeout is reached.
 * Much faster than fixed setTimeout waits.
 *
 * @param condition - Function that returns true when condition is met
 * @param timeoutMs - Maximum wait time (default: 2000ms)
 * @param pollIntervalMs - Time between polls (default: 10ms)
 * @returns Promise that resolves when condition is met
 * @throws Error if timeout is reached
 *
 * @example
 * ```ts
 * const received: number[] = [];
 * provider.emit('test', { value: 1 });
 * await waitFor(() => received.length === 1);
 * expect(received[0]).toBe(1);
 * ```
 */
export async function waitFor(
	condition: () => boolean,
	timeoutMs = 2000,
	pollIntervalMs = 10
): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor timeout after ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
}

// Start Redis container using standard test-utils pattern
const preload = createBunTestPreload({
	packageName: PACKAGE_NAME,
	dependencies: ['redis']
});

await preload();
