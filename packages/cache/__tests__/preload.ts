/**
 * Bun test preload for @orijs/cache package.
 *
 * Starts Redis testcontainer for CacheService functional tests.
 * Sets TEST_PACKAGE_NAME so tests know which container name to use.
 */

import { createBunTestPreload } from '@orijs/test-utils';

// Set package name env var for standalone testing
process.env.TEST_PACKAGE_NAME = 'orijs-cache';

const preload = createBunTestPreload({
	packageName: 'orijs-cache',
	dependencies: ['redis']
});

await preload();
