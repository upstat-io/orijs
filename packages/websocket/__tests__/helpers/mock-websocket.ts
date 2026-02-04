/**
 * Shared test helper for creating mock WebSocket connections.
 */

import { mock } from 'bun:test';
import type { WebSocketConnection } from '../../src/types.js';

/**
 * Creates a mock WebSocket connection for testing.
 *
 * @param socketId - Unique identifier for the socket
 * @param data - Optional application-specific data to attach
 * @returns A mock WebSocketConnection with all methods stubbed
 */
export function createMockWebSocket<TData = unknown>(
	socketId: string,
	data: TData = {} as TData
): WebSocketConnection<TData> {
	return {
		data: {
			socketId,
			data,
			topics: new Set<string>()
		},
		subscribe: mock(() => {}),
		unsubscribe: mock(() => {}),
		send: mock(() => 0),
		close: mock(() => {}),
		publish: mock(() => 0),
		ping: mock(() => {}),
		pong: mock(() => {}),
		cork: mock(() => {}),
		isSubscribed: mock(() => false),
		remoteAddress: '127.0.0.1',
		readyState: 1,
		binaryType: 'arraybuffer'
	} as unknown as WebSocketConnection<TData>;
}
