/**
 * Mock socket emitter factory for tests.
 *
 * Provides reusable mock SocketEmitter implementations
 * to avoid repetition in test files.
 */

import { mock } from 'bun:test';
import type { SocketEmitter } from '../../src/types/emitter';

/**
 * Creates a mock SocketEmitter with all methods mocked.
 *
 * @returns A SocketEmitter with mock implementations
 *
 * @example
 * ```typescript
 * const emitter = createMockSocketEmitter();
 * appContext.setSocketEmitterGetter(() => emitter);
 *
 * // Access mock functions for assertions
 * expect(emitter.publish).toHaveBeenCalledWith('topic', 'message');
 * ```
 */
export function createMockSocketEmitter(): SocketEmitter & {
	publish: ReturnType<typeof mock>;
	send: ReturnType<typeof mock>;
	broadcast: ReturnType<typeof mock>;
	emit: ReturnType<typeof mock>;
} {
	return {
		publish: mock(() => Promise.resolve()),
		send: mock(() => true),
		broadcast: mock(() => {}),
		emit: mock(() => Promise.resolve())
	};
}

/**
 * Creates a plain SocketEmitter object (non-mock) for type compatibility tests.
 *
 * @returns A SocketEmitter with simple implementations
 */
export function createSimpleSocketEmitter(): SocketEmitter {
	return {
		publish: () => Promise.resolve(),
		send: () => true,
		broadcast: () => {},
		emit: () => Promise.resolve()
	};
}
