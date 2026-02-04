/**
 * Bun test preload for @orijs/websocket-redis package.
 *
 * Starts Redis testcontainer for RedisWsProvider functional tests.
 * Sets TEST_PACKAGE_NAME so tests know which container name to use.
 */

import { createBunTestPreload } from '@orijs/test-utils';

// Set package name env var for standalone testing
process.env.TEST_PACKAGE_NAME = 'orijs-websocket-redis';

const preload = createBunTestPreload({
	packageName: 'orijs-websocket-redis',
	dependencies: ['redis']
});

await preload();
