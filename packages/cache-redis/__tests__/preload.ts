/**
 * Bun test preload for @orijs/cache-redis package.
 *
 * Starts Redis testcontainer for RedisCacheProvider functional tests.
 * Sets TEST_PACKAGE_NAME so tests know which container name to use.
 */

import { createBunTestPreload } from '@orijs/test-utils';

// Set package name env var for standalone testing
process.env.TEST_PACKAGE_NAME = 'orijs-cache-redis';

const preload = createBunTestPreload({
	packageName: 'orijs-cache-redis',
	dependencies: ['redis']
});

await preload();
