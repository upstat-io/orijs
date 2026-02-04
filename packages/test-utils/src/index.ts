/**
 * @orijs/test-utils - Test infrastructure for OriJS framework
 *
 * Provides Redis testcontainer helpers for testing cache and event systems.
 *
 * @example
 * // In your preload.ts
 * import { createBunTestPreload } from '@orijs/test-utils';
 *
 * const preload = createBunTestPreload({
 *   packageName: 'my-package',
 *   dependencies: ['redis'],
 * });
 *
 * await preload();
 *
 * @example
 * // In your test file
 * import { createRedisTestHelper } from '@orijs/test-utils';
 *
 * const redisHelper = createRedisTestHelper('my-package');
 * const redis = redisHelper.createRedisClient();
 */

// Bun test setup
export { createBunTestPreload, teardownBunTest } from './factories/bun-test-setup-factory';

// Redis test helper
export {
	createRedisTestHelper,
	startRedisTestContainer,
	stopRedisTestContainer,
	stopAllRedisTestContainers
} from './factories/redis-test-helper-factory';

// Async test helpers
export { waitFor, waitForAsync, withTimeout, delay } from './helpers/async-test-helpers';
export type { WaitForOptions } from './helpers/async-test-helpers';

// Types
export type { RedisTestHelper } from './types/test-helper.types';
export type { RedisContainerConfig, BunTestSetupOptions } from './types/container-config.types';
