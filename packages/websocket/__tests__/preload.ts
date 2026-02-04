/**
 * Bun test preload for @orijs/websocket package.
 *
 * Sets TEST_PACKAGE_NAME for test environment identification.
 * This package does not require Redis or other testcontainers.
 */

import { createBunTestPreload } from '@orijs/test-utils';

// Set package name env var for standalone testing
process.env.TEST_PACKAGE_NAME = 'orijs-websocket';

const preload = createBunTestPreload({
	packageName: 'orijs-websocket',
	dependencies: []
});

await preload();
