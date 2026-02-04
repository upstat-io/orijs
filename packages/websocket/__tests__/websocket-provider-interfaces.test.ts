/**
 * Tests for WebSocket Provider Interface Segregation (ISP)
 *
 * Verifies that the interface hierarchy follows ISP correctly:
 * - SocketEmitter: Consumer-facing (publish, send, broadcast)
 * - SocketLifecycle: Framework-facing (start + stop only)
 * - WebSocketProvider: Full implementation (extends both)
 */

import { describe, it, expect } from 'bun:test';
import { InProcWsProvider } from '../src/in-proc-provider.js';
import type { SocketEmitter, SocketLifecycle, WebSocketProvider } from '../src/types.js';

/** Valid UUID v4 socket IDs for testing */
const SOCKET_1 = '550e8400-e29b-41d4-a716-446655440001';
const SOCKET_2 = '550e8400-e29b-41d4-a716-446655440002';

// Helper functions for testing interface compatibility
function useEmitter(emitter: SocketEmitter): Promise<void> {
	return emitter.publish('topic', 'message');
}

function useLifecycle(lifecycle: SocketLifecycle): Promise<void> {
	return lifecycle.start();
}

function useProvider(provider: WebSocketProvider): void {
	provider.subscribe(SOCKET_1, 'topic');
}

describe('WebSocket Provider Interface Segregation', () => {
	// Note: Interface compliance (method existence) is verified by TypeScript at compile time.
	// These tests focus on runtime behavior when using narrowed interface types.

	describe('SocketEmitter interface', () => {
		it('should be callable via SocketEmitter interface', async () => {
			const provider = new InProcWsProvider();
			const emitter: SocketEmitter = provider;

			// publish() rejects when no server is set (logs error)
			await expect(emitter.publish('topic', 'message')).rejects.toThrow('Provider not ready');

			// broadcast() catches the rejection internally - should not throw
			expect(() => emitter.broadcast('message')).not.toThrow();

			// send() catches the rejection internally (fire-and-forget)
			expect(() => emitter.send('550e8400-e29b-41d4-a716-446655440000', 'message')).not.toThrow();
		});
	});

	describe('SocketLifecycle interface', () => {
		it('should start and stop via SocketLifecycle interface', async () => {
			const provider = new InProcWsProvider();
			const lifecycle: SocketLifecycle = provider;

			// Start
			await lifecycle.start();

			// Stop
			await lifecycle.stop();
		});

		it('should be idempotent for multiple start/stop calls', async () => {
			const provider = new InProcWsProvider();
			const lifecycle: SocketLifecycle = provider;

			// Multiple starts should not throw
			await lifecycle.start();
			await lifecycle.start();

			// Multiple stops should not throw
			await lifecycle.stop();
			await lifecycle.stop();
		});
	});

	describe('WebSocketProvider interface', () => {
		it('should track subscriptions correctly', async () => {
			const provider: WebSocketProvider = new InProcWsProvider();
			await provider.start();

			// Initially no subscribers
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);

			// Subscribe
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);

			// Subscribe same socket again (idempotent)
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);

			// Subscribe different socket
			provider.subscribe(SOCKET_2, 'topic-1');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(2);

			// Unsubscribe
			provider.unsubscribe(SOCKET_1, 'topic-1');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);

			await provider.stop();
		});

		it('should track connection status', async () => {
			const provider: WebSocketProvider = new InProcWsProvider();
			await provider.start();

			// Initially not connected
			expect(provider.isConnected(SOCKET_1)).toBe(false);
			expect(provider.getConnectionCount()).toBe(0);

			// Subscribe adds to connected sockets
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.isConnected(SOCKET_1)).toBe(true);
			expect(provider.getConnectionCount()).toBe(1);

			await provider.stop();
		});

		it('should disconnect socket from all subscriptions', async () => {
			const provider: WebSocketProvider = new InProcWsProvider();
			await provider.start();

			// Subscribe to multiple topics
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_1, 'topic-2');
			provider.subscribe(SOCKET_2, 'topic-1');

			expect(provider.getConnectionCount()).toBe(2);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(2);

			// Disconnect SOCKET_1
			provider.disconnect(SOCKET_1);

			expect(provider.isConnected(SOCKET_1)).toBe(false);
			expect(provider.isConnected(SOCKET_2)).toBe(true);
			expect(provider.getConnectionCount()).toBe(1);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(0);

			await provider.stop();
		});
	});

	describe('Interface compatibility in function signatures', () => {
		it('should accept InProcWsProvider for SocketEmitter parameter', async () => {
			const provider = new InProcWsProvider();
			// Calling useEmitter returns a Promise that rejects (no server)
			await expect(useEmitter(provider)).rejects.toThrow('Provider not ready');
		});

		it('should accept InProcWsProvider for SocketLifecycle parameter', async () => {
			const provider = new InProcWsProvider();
			await expect(useLifecycle(provider)).resolves.toBeUndefined();
			await provider.stop();
		});

		it('should accept InProcWsProvider for WebSocketProvider parameter', () => {
			const provider = new InProcWsProvider();
			expect(() => useProvider(provider)).not.toThrow();
		});
	});

	describe('Edge cases', () => {
		it('should reject publish when server not set', async () => {
			const provider = new InProcWsProvider();
			// No server set - logs error and rejects
			await expect(provider.publish('topic', 'message')).rejects.toThrow('Provider not ready');
		});

		it('should return 0 for unknown topic subscriber count', () => {
			const provider = new InProcWsProvider();
			expect(provider.getTopicSubscriberCount('unknown-topic')).toBe(0);
		});

		it('should throw for invalid socket ID on unsubscribe', () => {
			const provider = new InProcWsProvider();
			// Should throw for invalid socket ID
			expect(() => provider.unsubscribe('unknown-socket', 'unknown-topic')).toThrow(
				'Invalid socket ID format'
			);
		});

		it('should clear state after stop', async () => {
			const provider = new InProcWsProvider();
			await provider.start();

			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.getConnectionCount()).toBe(1);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);

			await provider.stop();

			expect(provider.getConnectionCount()).toBe(0);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);
		});
	});
});
