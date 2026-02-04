import { createBunTestPreload } from '@orijs/test-utils';
import { Logger } from '@orijs/logging';
import { afterAll } from 'bun:test';

// Enable debug mode for tests so framework errors throw instead of exit
process.env.ORIJS_DEBUG = 'true';

// Handle expected test rejections from BullMQ shutdown.
// When BullMQ connections close during test cleanup, ioredis emits "Connection is closed"
// errors that appear as unhandled rejections. These are expected during graceful shutdown.
const isExpectedShutdownError = (reason: unknown): boolean => {
	if (reason instanceof Error && reason.message.includes('Connection is closed')) return true;
	return false;
};

process.on('unhandledRejection', (reason: unknown) => {
	if (isExpectedShutdownError(reason)) {
		return; // Silently ignore expected shutdown errors
	}
	// Let other unhandled rejections propagate normally
});

process.on('uncaughtException', (err: Error) => {
	if (err.message.includes('Connection is closed')) {
		return; // Silently ignore expected shutdown errors
	}
	// Re-throw other exceptions to preserve normal behavior
	throw err;
});

const preload = createBunTestPreload({
	packageName: 'orijs',
	dependencies: ['redis'],
	runMigrations: false
});

// Run the preload function
await preload();

// Ensure Logger timer is cleaned up after each test file
afterAll(async () => {
	await Logger.shutdown();
});
