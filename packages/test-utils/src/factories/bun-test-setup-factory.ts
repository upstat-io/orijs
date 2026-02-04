/**
 * Bun test setup factory functions
 * Creates setup/teardown functions for bun test preload scripts
 *
 * @orijs/test-utils - Minimal test infrastructure for OriJS framework
 * This is a standalone version of the test utilities for framework testing.
 */

import type { BunTestSetupOptions } from '../types/container-config.types';
import { startRedisTestContainer, stopRedisTestContainer } from './redis-test-helper-factory';

/**
 * Create Bun test preload setup function for a package
 * Usage: Export this from your preload.ts file
 *
 * Example preload.ts:
 * ```
 * import { createBunTestPreload } from '@orijs/test-utils';
 * export default createBunTestPreload({
 *   packageName: 'my-package',
 *   dependencies: ['redis'],
 * });
 * ```
 */
export function createBunTestPreload(options: BunTestSetupOptions) {
	return async function preload() {
		console.log(`Starting test environment for ${options.packageName}...`);
		const startTime = Date.now();

		try {
			// Start containers in parallel
			const containerPromises: Promise<void>[] = [];

			if (options.dependencies.includes('redis')) {
				containerPromises.push(startRedisTestContainer(options.packageName));
			}

			await Promise.all(containerPromises);

			const duration = Date.now() - startTime;
			console.log(`Test environment ready for ${options.packageName} in ${duration}ms`);
		} catch (error) {
			console.error(`Failed to start test environment for ${options.packageName}:`, error);
			throw error;
		}
	};
}

/**
 * Create Bun test teardown function for a package
 * Call this in afterAll() to clean up containers
 */
export async function teardownBunTest(packageName: string): Promise<void> {
	console.log(`Stopping test environment for ${packageName}...`);

	try {
		await Promise.allSettled([stopRedisTestContainer(packageName)]);
		console.log(`Test environment stopped for ${packageName}`);
	} catch (error) {
		console.warn(`Teardown failed for ${packageName}:`, error);
	}
}
