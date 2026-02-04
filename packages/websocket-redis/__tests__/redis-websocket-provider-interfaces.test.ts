/**
 * Tests for RedisWsProvider Interface Segregation (ISP)
 *
 * Verifies that RedisWsProvider correctly implements the interface hierarchy:
 * - SocketEmitter: Consumer-facing (publish, send, broadcast)
 * - SocketLifecycle: Framework-facing (start + stop only)
 * - WebSocketProvider: Full implementation (extends both)
 *
 * These tests mirror the InProcWsProvider interface tests in @orijs/websocket
 * to ensure both providers are interchangeable via their shared interfaces.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { createRedisTestHelper, type RedisTestHelper } from '@orijs/test-utils';
import { RedisWsProvider } from '../src/redis-websocket-provider';
import type { SocketEmitter, SocketLifecycle, WebSocketProvider } from '@orijs/websocket';

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

describe('RedisWsProvider Interface Segregation', () => {
	let redisHelper: RedisTestHelper;
	let provider: RedisWsProvider;

	beforeAll(() => {
		redisHelper = createRedisTestHelper('orijs-websocket-redis');
		if (!redisHelper.isReady()) {
			redisHelper = createRedisTestHelper('orijs');
		}
		if (!redisHelper.isReady()) {
			throw new Error('Redis container not ready - check Bun test preload');
		}
	});

	beforeEach(async () => {
		await redisHelper.flushAll();
		const config = redisHelper.getConnectionConfig();
		provider = new RedisWsProvider({
			connection: { host: config.host, port: config.port }
		});
	});

	afterEach(async () => {
		if (provider) {
			await provider.stop();
		}
	});

	describe('SocketEmitter interface', () => {
		it('should be usable via SocketEmitter interface', async () => {
			await provider.start();
			const emitter: SocketEmitter = provider;

			// publish() returns a Promise (fire-and-forget, but can await)
			await expect(emitter.publish('topic', 'message')).resolves.toBeUndefined();

			// broadcast() should not throw
			expect(() => emitter.broadcast('message')).not.toThrow();

			// send() is fire-and-forget (requires valid UUID v4)
			expect(() => emitter.send('550e8400-e29b-41d4-a716-446655440000', 'message')).not.toThrow();
		});

		it('should reject publish when provider not started', async () => {
			const emitter: SocketEmitter = provider;

			// publish() rejects when provider not started
			await expect(emitter.publish('topic', 'message')).rejects.toThrow('Provider not ready');
		});
	});

	describe('SocketLifecycle interface', () => {
		it('should start and stop via SocketLifecycle interface', async () => {
			const lifecycle: SocketLifecycle = provider;

			// Start
			await lifecycle.start();

			// Stop
			await lifecycle.stop();
		});

		it('should be idempotent for multiple start/stop calls', async () => {
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
			const wsProvider: WebSocketProvider = provider;
			await wsProvider.start();

			// Initially no subscribers
			expect(wsProvider.getTopicSubscriberCount('topic-1')).toBe(0);

			// Subscribe
			wsProvider.subscribe(SOCKET_1, 'topic-1');
			expect(wsProvider.getTopicSubscriberCount('topic-1')).toBe(1);

			// Subscribe same socket again (idempotent)
			wsProvider.subscribe(SOCKET_1, 'topic-1');
			expect(wsProvider.getTopicSubscriberCount('topic-1')).toBe(1);

			// Subscribe different socket
			wsProvider.subscribe(SOCKET_2, 'topic-1');
			expect(wsProvider.getTopicSubscriberCount('topic-1')).toBe(2);

			// Unsubscribe
			wsProvider.unsubscribe(SOCKET_1, 'topic-1');
			expect(wsProvider.getTopicSubscriberCount('topic-1')).toBe(1);
		});

		it('should track connection status', async () => {
			const wsProvider: WebSocketProvider = provider;
			await wsProvider.start();

			// Initially not connected
			expect(wsProvider.isConnected(SOCKET_1)).toBe(false);
			expect(wsProvider.getConnectionCount()).toBe(0);

			// Subscribe adds to connected sockets
			wsProvider.subscribe(SOCKET_1, 'topic-1');
			expect(wsProvider.isConnected(SOCKET_1)).toBe(true);
			expect(wsProvider.getConnectionCount()).toBe(1);
		});

		it('should disconnect socket from all subscriptions', async () => {
			const wsProvider: WebSocketProvider = provider;
			await wsProvider.start();

			// Subscribe to multiple topics
			wsProvider.subscribe(SOCKET_1, 'topic-1');
			wsProvider.subscribe(SOCKET_1, 'topic-2');
			wsProvider.subscribe(SOCKET_2, 'topic-1');

			expect(wsProvider.getConnectionCount()).toBe(2);
			expect(wsProvider.getTopicSubscriberCount('topic-1')).toBe(2);

			// Disconnect SOCKET_1
			wsProvider.disconnect(SOCKET_1);

			expect(wsProvider.isConnected(SOCKET_1)).toBe(false);
			expect(wsProvider.isConnected(SOCKET_2)).toBe(true);
			expect(wsProvider.getConnectionCount()).toBe(1);
			expect(wsProvider.getTopicSubscriberCount('topic-1')).toBe(1);
			expect(wsProvider.getTopicSubscriberCount('topic-2')).toBe(0);
		});
	});

	describe('Interface compatibility in function signatures', () => {
		it('should accept RedisWsProvider for SocketEmitter parameter', async () => {
			// useEmitter rejects because provider not started
			await expect(useEmitter(provider)).rejects.toThrow('Provider not ready');
		});

		it('should accept RedisWsProvider for SocketLifecycle parameter', async () => {
			await expect(useLifecycle(provider)).resolves.toBeUndefined();
		});

		it('should accept RedisWsProvider for WebSocketProvider parameter', async () => {
			await provider.start();
			expect(() => useProvider(provider)).not.toThrow();
		});
	});

	describe('Edge cases', () => {
		it('should return 0 for unknown topic subscriber count', async () => {
			await provider.start();
			expect(provider.getTopicSubscriberCount('unknown-topic')).toBe(0);
		});

		it('should throw for invalid socket ID on unsubscribe', async () => {
			await provider.start();
			// Should throw for invalid socket ID
			expect(() => provider.unsubscribe('unknown-socket', 'unknown-topic')).toThrow(
				'Invalid socket ID format'
			);
		});

		it('should clear state after stop', async () => {
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
