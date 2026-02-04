/**
 * Functional tests for RedisWsProvider
 * Tests real Redis operations using testcontainers
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach, mock } from 'bun:test';
import { createRedisTestHelper, waitFor, delay, type RedisTestHelper } from '@orijs/test-utils';
import { RedisWsProvider } from '../src/redis-websocket-provider';
import type { BunServer } from '@orijs/websocket';
import type { Logger } from '@orijs/logging';

/** Valid UUID v4 socket IDs for testing */
const SOCKET_1 = '550e8400-e29b-41d4-a716-446655440001';
const SOCKET_2 = '550e8400-e29b-41d4-a716-446655440002';
const SOCKET_3 = '550e8400-e29b-41d4-a716-446655440003';
const SOCKET_A = '550e8400-e29b-41d4-a716-446655440004';
const SOCKET_B = '550e8400-e29b-41d4-a716-446655440005';

/**
 * Creates a mock Bun server that tracks published messages.
 * Used to verify that Redis messages are forwarded correctly.
 */
function createMockServer(): BunServer & { publishedMessages: Array<{ topic: string; message: unknown }> } {
	const publishedMessages: Array<{ topic: string; message: unknown }> = [];
	return {
		publishedMessages,
		publish(topic: string, message: unknown): void {
			publishedMessages.push({ topic, message });
		}
	} as BunServer & { publishedMessages: Array<{ topic: string; message: unknown }> };
}

describe('RedisWsProvider (functional)', () => {
	let redisHelper: RedisTestHelper;
	let provider: RedisWsProvider;
	/** Tracks all providers created during a test for cleanup */
	let allProviders: RedisWsProvider[] = [];

	/**
	 * Creates a tracked provider that will be cleaned up in afterEach.
	 * Use this instead of `new RedisWsProvider()` in tests to prevent leaks.
	 */
	function createTrackedProvider(
		options?: Partial<{ keyPrefix: string; connectTimeout: number; logger: Logger }>
	): RedisWsProvider {
		const config = redisHelper.getConnectionConfig();
		const trackedProvider = new RedisWsProvider({
			connection: { host: config.host, port: config.port },
			...options
		});
		allProviders.push(trackedProvider);
		return trackedProvider;
	}

	beforeAll(() => {
		// Try package-specific name first, fall back to root 'orijs' when running from monorepo root
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
		allProviders = [];
		provider = createTrackedProvider();
	});

	afterEach(async () => {
		// Clean up all tracked providers (including main provider)
		await Promise.all(
			allProviders.map((p) =>
				p.stop().catch((e) => {
					// Log cleanup errors for debugging (visible with DEBUG=1 or similar)
					console.debug('Test cleanup error:', e instanceof Error ? e.message : 'Unknown error');
				})
			)
		);
		allProviders = [];
	});

	describe('lifecycle', () => {
		it('should start and stop without errors', async () => {
			await provider.start();

			expect(provider.getConnectionCount()).toBe(0);

			await provider.stop();
		});

		it('should be idempotent on start', async () => {
			await provider.start();
			await provider.start(); // Second call should not throw

			expect(provider.getConnectionCount()).toBe(0);
		});

		it('should be idempotent on stop', async () => {
			await provider.start();
			await provider.stop();
			await provider.stop(); // Second call should not throw
		});

		it('should not throw when stop called without start', async () => {
			await provider.stop(); // Should not throw
		});
	});

	describe('subscription tracking', () => {
		it('should track local subscriptions', async () => {
			await provider.start();

			provider.subscribe(SOCKET_1, 'room:123');
			provider.subscribe(SOCKET_2, 'room:123');

			expect(provider.getTopicSubscriberCount('room:123')).toBe(2);
			expect(provider.isConnected(SOCKET_1)).toBe(true);
			expect(provider.isConnected(SOCKET_2)).toBe(true);
		});

		it('should track unsubscriptions', async () => {
			await provider.start();

			provider.subscribe(SOCKET_1, 'room:123');
			provider.subscribe(SOCKET_2, 'room:123');
			provider.unsubscribe(SOCKET_1, 'room:123');

			expect(provider.getTopicSubscriberCount('room:123')).toBe(1);
			expect(provider.isConnected(SOCKET_1)).toBe(false);
			expect(provider.isConnected(SOCKET_2)).toBe(true);
		});

		it('should track connection count when multiple sockets subscribe to different topics', async () => {
			await provider.start();

			provider.subscribe(SOCKET_1, 'room:a');
			provider.subscribe(SOCKET_2, 'room:b');
			provider.subscribe(SOCKET_3, 'room:a');

			expect(provider.getConnectionCount()).toBe(3);
		});

		it('should handle multiple topics per socket', async () => {
			await provider.start();

			provider.subscribe(SOCKET_1, 'room:a');
			provider.subscribe(SOCKET_1, 'room:b');

			expect(provider.getTopicSubscriberCount('room:a')).toBe(1);
			expect(provider.getTopicSubscriberCount('room:b')).toBe(1);
			expect(provider.isConnected(SOCKET_1)).toBe(true);

			// Unsubscribe from one topic - socket should still be connected
			provider.unsubscribe(SOCKET_1, 'room:a');
			expect(provider.isConnected(SOCKET_1)).toBe(true);

			// Unsubscribe from last topic - socket should be disconnected
			provider.unsubscribe(SOCKET_1, 'room:b');
			expect(provider.isConnected(SOCKET_1)).toBe(false);
		});

		it('should return 0 for non-existent topic', async () => {
			await provider.start();

			expect(provider.getTopicSubscriberCount('non-existent')).toBe(0);
		});

		it('should unsubscribe from Redis when disconnect() removes last subscriber', async () => {
			// Two providers to verify cross-instance messaging stops after disconnect
			const provider1 = createTrackedProvider();
			const provider2 = createTrackedProvider();
			const mockServer = createMockServer();

			await provider1.start();
			await provider2.start();

			provider2.setServer(mockServer);
			provider2.subscribe(SOCKET_1, 'disconnect-test');

			// Allow Redis subscription to establish
			await delay(200);

			// Verify messages are received before disconnect
			provider1.publish('disconnect-test', 'before-disconnect');
			await waitFor(() => mockServer.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Message not received before disconnect'
			});
			expect(mockServer.publishedMessages.length).toBe(1);

			// Disconnect the socket (should trigger Redis unsubscribe)
			provider2.disconnect(SOCKET_1);

			// Allow Redis unsubscribe to complete
			await delay(200);

			// Clear received messages
			mockServer.publishedMessages.length = 0;

			// Publish after disconnect - should NOT be received
			provider1.publish('disconnect-test', 'after-disconnect');

			// Wait a bit to ensure message would have been received if still subscribed
			await delay(200);

			// No messages should have been received
			expect(mockServer.publishedMessages.length).toBe(0);
		});
	});

	describe('pub/sub bridging', () => {
		it('should publish messages to Redis and receive via subscription', async () => {
			// Create two providers to simulate cross-instance messaging
			const provider1 = createTrackedProvider();
			const provider2 = createTrackedProvider();

			const mockServer = createMockServer();

			await provider1.start();
			await provider2.start();

			provider2.setServer(mockServer);
			provider2.subscribe(SOCKET_1, 'room:123');

			// Allow Redis subscription to establish
			await delay(200);

			// Publish from provider1
			provider1.publish('room:123', 'Hello from provider1');

			// Wait for message to be received via Redis
			await waitFor(() => mockServer.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Message not received from Redis pub/sub'
			});

			// Verify message was forwarded to mock server
			expect(mockServer.publishedMessages.length).toBe(1);
			const msg = mockServer.publishedMessages[0];
			if (!msg) throw new Error('Expected message to exist');
			expect(msg.topic).toBe('room:123');
			expect(msg.message).toBe('Hello from provider1');
		});

		it('should handle binary messages via base64 encoding', async () => {
			const provider1 = createTrackedProvider();
			const provider2 = createTrackedProvider();

			const mockServer = createMockServer();

			await provider1.start();
			await provider2.start();

			provider2.setServer(mockServer);
			provider2.subscribe(SOCKET_1, 'binary-topic');

			await delay(200);

			// Send binary message
			const binaryData = new Uint8Array([1, 2, 3, 4, 5]).buffer;
			provider1.publish('binary-topic', binaryData);

			// Wait for message to be received via Redis
			await waitFor(() => mockServer.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Binary message not received from Redis pub/sub'
			});

			// Verify message was received and decoded
			expect(mockServer.publishedMessages.length).toBe(1);
			const binaryMsg = mockServer.publishedMessages[0];
			if (!binaryMsg) throw new Error('Expected binary message to exist');
			expect(binaryMsg.topic).toBe('binary-topic');
			// Binary data should be decoded from base64 back to Buffer
			const receivedBuffer = binaryMsg.message as Buffer;
			expect(Buffer.isBuffer(receivedBuffer)).toBe(true);
			expect(Array.from(receivedBuffer)).toEqual([1, 2, 3, 4, 5]);
		});

		it('should broadcast to all via __broadcast__ topic', async () => {
			const mockServer = createMockServer();

			await provider.start();
			provider.setServer(mockServer);
			provider.subscribe(SOCKET_1, '__broadcast__');

			await delay(200);

			provider.broadcast('Global announcement');

			await waitFor(() => mockServer.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Broadcast message not received'
			});

			expect(mockServer.publishedMessages.length).toBe(1);
			const broadcastMsg = mockServer.publishedMessages[0];
			if (!broadcastMsg) throw new Error('Expected broadcast message to exist');
			expect(broadcastMsg.topic).toBe('__broadcast__');
		});

		it('should send directly to socket via __socket__:{id} channel', async () => {
			const mockServer = createMockServer();
			const socketId = '550e8400-e29b-41d4-a716-446655440000';

			await provider.start();
			provider.setServer(mockServer);
			provider.subscribe(socketId, `__socket__:${socketId}`);

			await delay(200);

			provider.send(socketId, 'Direct message');

			await waitFor(() => mockServer.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Direct message not received'
			});

			expect(mockServer.publishedMessages.length).toBe(1);
			const directMsg = mockServer.publishedMessages[0];
			if (!directMsg) throw new Error('Expected direct message to exist');
			expect(directMsg.topic).toBe(`__socket__:${socketId}`);
		});
	});

	describe('error handling', () => {
		it('should reject with error when publishing without start', async () => {
			// Provider not started, should reject
			await expect(provider.publish('room:123', 'Message')).rejects.toThrow(
				'Cannot publish to topic "room:123": Provider not ready'
			);
		});

		it('should log warning when server not set for received message', async () => {
			// Create a mock logger to capture warnings
			const warnMock = mock(() => {});
			const mockLogger: Logger = {
				info: mock(() => {}),
				warn: warnMock,
				error: mock(() => {}),
				debug: mock(() => {}),
				child: () => mockLogger
			} as unknown as Logger;

			// Create receiver provider with mock logger (no server set)
			const receiverProvider = createTrackedProvider({ logger: mockLogger });

			// Create sender provider
			const senderProvider = createTrackedProvider();

			await receiverProvider.start();
			await senderProvider.start();

			// Subscribe without setting server - will log warning when message received
			receiverProvider.subscribe(SOCKET_1, 'room:123');
			await delay(200);

			// Send message from sender
			senderProvider.publish('room:123', 'Test message');

			// Wait for warning to be logged
			await waitFor(() => warnMock.mock.calls.length > 0, {
				timeout: 2000,
				message: 'Warning not logged when server not set'
			});

			// Verify warning was logged with correct message
			expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('Server not set'));
		});
	});

	describe('connection failure behavior', () => {
		it('should fail fast when Redis connection is invalid', async () => {
			// Note: This provider uses an invalid connection intentionally,
			// so we create it directly and handle cleanup manually
			const badProvider = new RedisWsProvider({
				connection: { host: 'localhost', port: 59999 },
				connectTimeout: 500 // 500ms for test speed
			});

			try {
				// start() itself doesn't throw - it just creates connections
				// The error occurs on first operation
				await badProvider.start();

				// Try to subscribe - this should trigger connection error
				badProvider.subscribe(SOCKET_1, 'room:123');

				// Wait for connection attempt to fail - use reasonable timeout for CI load
				// Under heavy CI load, connection timeouts can be delayed
				await delay(2000);

				// The key assertion is that the test completes (doesn't hang)
				// and the provider can be stopped cleanly - if we get here without
				// hanging, the error was handled properly via internal logging
			} finally {
				await badProvider.stop().catch(() => {});
			}
		}, 10000); // 10 second timeout for CI environments
	});

	describe('key prefix', () => {
		it('should isolate channels by key prefix', async () => {
			// Create two providers with different prefixes
			const prefixAProvider = createTrackedProvider({ keyPrefix: 'prefix-a' });
			const prefixBProvider = createTrackedProvider({ keyPrefix: 'prefix-b' });

			const mockServerA = createMockServer();
			const mockServerB = createMockServer();

			await prefixAProvider.start();
			await prefixBProvider.start();

			prefixAProvider.setServer(mockServerA);
			prefixBProvider.setServer(mockServerB);

			// Both subscribe to same topic name but different Redis channels
			prefixAProvider.subscribe(SOCKET_A, 'room:123');
			prefixBProvider.subscribe(SOCKET_B, 'room:123');

			await delay(200);

			// Publish from prefix-a provider
			prefixAProvider.publish('room:123', 'Message from A');

			// Wait for message on prefix-a
			await waitFor(() => mockServerA.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Message not received on prefix-a provider'
			});

			// Verify prefix-a received the message
			expect(mockServerA.publishedMessages.length).toBe(1);
			const msgA = mockServerA.publishedMessages[0];
			if (!msgA) throw new Error('Expected message from A to exist');
			expect(msgA.message).toBe('Message from A');

			// Verify prefix-b did NOT receive the message (different Redis channel)
			// Give a small window for any potential cross-talk
			await delay(200);
			expect(mockServerB.publishedMessages.length).toBe(0);

			// Now publish from prefix-b and verify isolation in other direction
			prefixBProvider.publish('room:123', 'Message from B');

			await waitFor(() => mockServerB.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Message not received on prefix-b provider'
			});

			// Verify prefix-b received its message
			expect(mockServerB.publishedMessages.length).toBe(1);
			const msgB = mockServerB.publishedMessages[0];
			if (!msgB) throw new Error('Expected message from B to exist');
			expect(msgB.message).toBe('Message from B');

			// Verify prefix-a still only has its original message
			expect(mockServerA.publishedMessages.length).toBe(1);
		});
	});

	describe('reconnection handling', () => {
		it('should resubscribe to channels when ready event fires (reconnection scenario)', async () => {
			const provider1 = createTrackedProvider();
			const provider2 = createTrackedProvider();

			const mockServer = createMockServer();

			await provider1.start();
			await provider2.start();

			provider2.setServer(mockServer);
			provider2.subscribe(SOCKET_1, 'room:123');

			// Allow subscription to establish
			await delay(200);

			// Verify messages work initially
			provider1.publish('room:123', 'Initial message');
			await waitFor(() => mockServer.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Initial message not received'
			});
			expect(mockServer.publishedMessages.length).toBe(1);

			// Clear messages for next test
			mockServer.publishedMessages.length = 0;

			// Simulate what happens during reconnection:
			// 1. Access private subscriber
			// 2. Manually emit 'ready' event (simulates reconnection)
			// This tests that our resubscribeAll() handler works correctly
			const subscriber = (
				provider2 as unknown as {
					subscriber: { emit: (event: string) => void; subscribe: (...args: string[]) => Promise<void> };
				}
			).subscriber;

			// Emit 'ready' to trigger resubscribeAll()
			subscriber.emit('ready');

			// Allow resubscription to complete
			await delay(200);

			// Verify messages still work after resubscription
			provider1.publish('room:123', 'After resubscribe');
			await waitFor(() => mockServer.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Message not received after resubscription - resubscribeAll may have failed'
			});

			expect(mockServer.publishedMessages.length).toBe(1);
			const resubMsg = mockServer.publishedMessages[0];
			if (!resubMsg) throw new Error('Expected message after resubscribe to exist');
			expect(resubMsg.message).toBe('After resubscribe');
		});
	});

	describe('cleanup on stop', () => {
		it('should clear all subscriptions on stop', async () => {
			await provider.start();

			provider.subscribe(SOCKET_1, 'room:a');
			provider.subscribe(SOCKET_2, 'room:b');

			expect(provider.getConnectionCount()).toBe(2);

			await provider.stop();

			// After stop, all tracking should be cleared
			expect(provider.getConnectionCount()).toBe(0);
			expect(provider.getTopicSubscriberCount('room:a')).toBe(0);
			expect(provider.isConnected(SOCKET_1)).toBe(false);
		});

		it('should unsubscribe from Redis channels on stop', async () => {
			const provider1 = createTrackedProvider();
			const provider2 = createTrackedProvider();

			const mockServer = createMockServer();

			await provider1.start();
			await provider2.start();

			provider2.setServer(mockServer);
			provider2.subscribe(SOCKET_1, 'room:123');

			await delay(200);

			// Stop provider2 - should unsubscribe from Redis
			await provider2.stop();

			// Publish from provider1 - should not be received by stopped provider2
			provider1.publish('room:123', 'After stop');

			// Give time for any potential message delivery (should NOT arrive)
			await delay(200);

			// No messages should be received after stop
			expect(mockServer.publishedMessages.length).toBe(0);
		});
	});
});
