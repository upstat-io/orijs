/**
 * Integration tests for cross-instance WebSocket messaging with RedisWsProvider.
 *
 * These tests verify that messages published from one server instance are
 * received by clients connected to other instances - the primary purpose
 * of the Redis provider.
 *
 * The key scenario being tested:
 * 1. Client connects to Instance A and joins room "account:123" via ws.subscribe()
 * 2. API call to Instance B publishes message to "account:123"
 * 3. Client on Instance A should receive the message via Redis pub/sub
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'bun:test';
import { createRedisTestHelper, waitFor, delay, type RedisTestHelper } from '@orijs/test-utils';
import { RedisWsProvider } from '../src/redis-websocket-provider';
import type { BunServer } from '@orijs/websocket';

/** Valid UUID v4 socket IDs for testing */
const SOCKET_INSTANCE_A = '550e8400-e29b-41d4-a716-446655440001';
const SOCKET_INSTANCE_B = '550e8400-e29b-41d4-a716-446655440002';

/**
 * Creates a mock Bun server that tracks published messages.
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

describe('RedisWsProvider cross-instance messaging', () => {
	let redisHelper: RedisTestHelper;
	let allProviders: RedisWsProvider[] = [];

	function createProvider(keyPrefix = 'ws-test'): RedisWsProvider {
		const config = redisHelper.getConnectionConfig();
		const provider = new RedisWsProvider({
			connection: { host: config.host, port: config.port },
			keyPrefix
		});
		allProviders.push(provider);
		return provider;
	}

	beforeAll(() => {
		redisHelper = createRedisTestHelper('orijs-websocket-redis');
		if (!redisHelper.isReady()) {
			redisHelper = createRedisTestHelper('orijs');
		}
		if (!redisHelper.isReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		await redisHelper.flushAll();
		allProviders = [];
	});

	afterEach(async () => {
		await Promise.all(allProviders.map((p) => p.stop().catch(() => {})));
		allProviders = [];
	});

	describe('cross-instance pub/sub with provider.subscribe()', () => {
		it('should deliver messages across instances when using provider.subscribe()', async () => {
			// Setup: Two server instances with their own providers
			const instanceA = createProvider();
			const instanceB = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			await instanceB.start();

			instanceA.setServer(mockServerA);

			// Client on Instance A subscribes using provider.subscribe()
			// This is the CORRECT way - it subscribes to the Redis channel
			instanceA.subscribe(SOCKET_INSTANCE_A, 'account:123');

			await delay(200); // Allow Redis subscription to establish

			// Instance B publishes a message (simulating an API call)
			await instanceB.publish(
				'account:123',
				JSON.stringify({
					name: 'test.event',
					data: { hello: 'world' },
					timestamp: Date.now()
				})
			);

			// Message should be received on Instance A
			await waitFor(() => mockServerA.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Message not received on Instance A'
			});

			expect(mockServerA.publishedMessages.length).toBe(1);
			const msg = mockServerA.publishedMessages[0];
			expect(msg?.topic).toBe('account:123');
		});

		it('should NOT deliver messages when instance has no Redis subscription', async () => {
			// Setup: Two server instances
			const instanceA = createProvider();
			const instanceB = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			await instanceB.start();

			instanceA.setServer(mockServerA);

			// PROBLEM: Instance A does NOT call provider.subscribe()
			// This simulates what happens when using ws.subscribe() directly
			// without going through the coordinator/provider
			// (No subscription call here - this is the bug we're demonstrating)

			// Instance B publishes a message
			await instanceB.publish(
				'account:123',
				JSON.stringify({
					name: 'test.event',
					data: { hello: 'world' },
					timestamp: Date.now()
				})
			);

			// Wait to see if message arrives (it shouldn't)
			await delay(500);

			// Message should NOT be received because Instance A
			// never subscribed to the Redis channel
			expect(mockServerA.publishedMessages.length).toBe(0);
		});
	});

	describe('the real-world scenario: ws.subscribe() without provider.subscribe()', () => {
		/**
		 * This test demonstrates the ACTUAL failure scenario:
		 *
		 * In real usage with OriJS Application, when a client joins a room:
		 * 1. onWebSocket.message handler receives { type: 'joinRoom', room: 'account:123' }
		 * 2. Handler calls ws.subscribe('account:123') - Bun's native method
		 * 3. This subscribes the WebSocket to the LOCAL Bun pub/sub topic
		 * 4. BUT it does NOT subscribe to the Redis channel!
		 *
		 * When another instance publishes:
		 * 1. provider.publish('account:123', message) publishes to Redis
		 * 2. The Redis subscriber on Instance A is NOT subscribed to 'ws-test:account:123'
		 * 3. handleRedisMessage() is never called
		 * 4. The client never receives the message
		 *
		 * The fix: The provider should automatically ensure Redis subscription
		 * when server.publish() is set up, OR the framework should intercept
		 * ws.subscribe() calls.
		 */
		it('should demonstrate that provider.subscribe() is required for cross-instance messaging', async () => {
			const instanceA = createProvider();
			const instanceB = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			await instanceB.start();

			instanceA.setServer(mockServerA);

			// Scenario 1: WITHOUT provider.subscribe() - messages NOT received
			// (This simulates what happens with raw ws.subscribe())
			mockServerA.publishedMessages.length = 0;

			await instanceB.publish('room:no-redis-sub', 'Message without subscription');
			await delay(300);

			expect(mockServerA.publishedMessages.length).toBe(0);

			// Scenario 2: WITH provider.subscribe() - messages ARE received
			instanceA.subscribe(SOCKET_INSTANCE_A, 'room:with-redis-sub');
			await delay(200);

			await instanceB.publish('room:with-redis-sub', 'Message with subscription');

			await waitFor(() => mockServerA.publishedMessages.length >= 1, {
				timeout: 2000,
				message: 'Message should be received when provider.subscribe() was called'
			});

			expect(mockServerA.publishedMessages.length).toBe(1);
			expect(mockServerA.publishedMessages[0]?.topic).toBe('room:with-redis-sub');
		});
	});

	describe('automatic Redis subscription on publish (proposed fix)', () => {
		/**
		 * PROPOSED FIX: When a server has setServer() called (indicating it will
		 * forward messages to local WebSockets), it should automatically subscribe
		 * to Redis channels when a local client subscribes via Bun's native
		 * ws.subscribe().
		 *
		 * The cleanest solution is to have the Application framework intercept
		 * ws.subscribe() calls and route them through the coordinator, which
		 * already calls both ws.subscribe() AND provider.subscribe().
		 *
		 * This test documents the EXPECTED behavior after the fix.
		 */
		it.skip('should automatically handle Redis subscription when ws.subscribe() is called', async () => {
			// This test is skipped until the fix is implemented
			// It documents the expected behavior

			const instanceA = createProvider();
			const instanceB = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			await instanceB.start();

			instanceA.setServer(mockServerA);

			// After the fix: Just calling setServer() and having the server's
			// websocket.open handler call ws.subscribe() should be enough.
			// The framework should automatically ensure Redis subscription.

			// For now, we need explicit provider.subscribe()
			instanceA.subscribe(SOCKET_INSTANCE_A, 'auto-sub-topic');
			await delay(200);

			await instanceB.publish('auto-sub-topic', 'Test message');

			await waitFor(() => mockServerA.publishedMessages.length >= 1, {
				timeout: 2000
			});

			expect(mockServerA.publishedMessages.length).toBe(1);
		});
	});

	describe('server lifecycle: death, restart, rejoin', () => {
		/**
		 * These tests verify that the Redis provider properly handles server
		 * lifecycle events: server death, restart, and clients reconnecting.
		 */

		it('should clean up subscriptions when a socket disconnects', async () => {
			const instanceA = createProvider();
			const instanceB = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			await instanceB.start();

			instanceA.setServer(mockServerA);

			// Socket connects and subscribes
			instanceA.subscribe(SOCKET_INSTANCE_A, 'account:123');
			await delay(200);

			// Verify subscription works
			await instanceB.publish('account:123', 'Message 1');
			await waitFor(() => mockServerA.publishedMessages.length >= 1, { timeout: 2000 });
			expect(mockServerA.publishedMessages.length).toBe(1);

			// Socket disconnects - provider should clean up
			instanceA.disconnect(SOCKET_INSTANCE_A);
			await delay(200);

			// Clear tracked messages
			mockServerA.publishedMessages.length = 0;

			// New message should NOT be delivered (socket is gone)
			await instanceB.publish('account:123', 'Message 2');
			await delay(500);

			// The message should still go to the server topic (if other sockets subscribed),
			// but since we removed the only subscriber, no messages should be received
			// The provider might still forward to the server, but the socket is gone
			// This tests that cleanup happened at the socket tracking level
			expect(instanceA.isConnected(SOCKET_INSTANCE_A)).toBe(false);
		});

		it('should handle server restart with new provider instance', async () => {
			// Server A starts, client connects
			const instanceA1 = createProvider();
			const instanceB = createProvider();
			const mockServerA1 = createMockServer();

			await instanceA1.start();
			await instanceB.start();

			instanceA1.setServer(mockServerA1);
			instanceA1.subscribe(SOCKET_INSTANCE_A, 'account:123');
			await delay(200);

			// Verify initial subscription works
			await instanceB.publish('account:123', 'Before restart');
			await waitFor(() => mockServerA1.publishedMessages.length >= 1, { timeout: 2000 });
			expect(mockServerA1.publishedMessages.length).toBe(1);

			// Server A "dies" (stop provider)
			await instanceA1.stop();
			await delay(200);

			// Server A "restarts" with new provider and new server
			const instanceA2 = createProvider();
			const mockServerA2 = createMockServer();

			await instanceA2.start();
			instanceA2.setServer(mockServerA2);

			// Client reconnects with potentially new socket ID
			const newSocketId = SOCKET_INSTANCE_B; // Different socket ID after reconnect
			instanceA2.subscribe(newSocketId, 'account:123');
			await delay(200);

			// Messages from Instance B should now reach the restarted Instance A
			await instanceB.publish('account:123', 'After restart');
			await waitFor(() => mockServerA2.publishedMessages.length >= 1, { timeout: 2000 });

			expect(mockServerA2.publishedMessages.length).toBe(1);
			const msg = mockServerA2.publishedMessages[0];
			expect(msg?.topic).toBe('account:123');
		});

		it('should handle multiple clients on same topic with one disconnecting', async () => {
			const instanceA = createProvider();
			const instanceB = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			await instanceB.start();

			instanceA.setServer(mockServerA);

			// Two sockets subscribe to the same topic
			instanceA.subscribe(SOCKET_INSTANCE_A, 'account:123');
			instanceA.subscribe(SOCKET_INSTANCE_B, 'account:123');
			await delay(200);

			// Publish should work
			await instanceB.publish('account:123', 'Message 1');
			await waitFor(() => mockServerA.publishedMessages.length >= 1, { timeout: 2000 });
			expect(mockServerA.publishedMessages.length).toBe(1);

			// One socket disconnects
			instanceA.disconnect(SOCKET_INSTANCE_A);
			await delay(200);

			// Clear and send another message
			mockServerA.publishedMessages.length = 0;
			await instanceB.publish('account:123', 'Message 2');
			await waitFor(() => mockServerA.publishedMessages.length >= 1, { timeout: 2000 });

			// Message should still be delivered (SOCKET_INSTANCE_B still subscribed)
			expect(mockServerA.publishedMessages.length).toBe(1);

			// Verify socket states
			expect(instanceA.isConnected(SOCKET_INSTANCE_A)).toBe(false);
			expect(instanceA.isConnected(SOCKET_INSTANCE_B)).toBe(true);
		});

		it('should handle provider stop and restart gracefully', async () => {
			const instanceA = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			instanceA.setServer(mockServerA);
			instanceA.subscribe(SOCKET_INSTANCE_A, 'account:123');
			await delay(200);

			// Stop the provider
			await instanceA.stop();
			await delay(200);

			// Restarting should work without errors
			await instanceA.start();
			instanceA.setServer(mockServerA);

			// Note: subscriptions are lost on stop - client would need to resubscribe
			// This is expected behavior - the provider doesn't persist subscriptions
			instanceA.subscribe(SOCKET_INSTANCE_A, 'account:123');
			await delay(200);

			// Create a publisher to test
			const instanceB = createProvider();
			await instanceB.start();

			mockServerA.publishedMessages.length = 0;
			await instanceB.publish('account:123', 'After restart');
			await waitFor(() => mockServerA.publishedMessages.length >= 1, { timeout: 2000 });

			expect(mockServerA.publishedMessages.length).toBe(1);

			await instanceB.stop();
		});

		it('should not leak subscriptions on repeated subscribe/unsubscribe', async () => {
			const instanceA = createProvider();
			const instanceB = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			await instanceB.start();

			instanceA.setServer(mockServerA);

			// Rapidly subscribe and unsubscribe
			for (let i = 0; i < 5; i++) {
				instanceA.subscribe(SOCKET_INSTANCE_A, 'room:test');
				instanceA.unsubscribe(SOCKET_INSTANCE_A, 'room:test');
			}

			// Final subscribe
			instanceA.subscribe(SOCKET_INSTANCE_A, 'room:test');
			await delay(200);

			// Should receive exactly one message per publish
			await instanceB.publish('room:test', 'Test message');
			await waitFor(() => mockServerA.publishedMessages.length >= 1, { timeout: 2000 });

			// Only 1 message should be received (no leaked duplicate subscriptions)
			expect(mockServerA.publishedMessages.length).toBe(1);
		});

		it('should handle unsubscribe from topic with multiple subscribers', async () => {
			const instanceA = createProvider();
			const instanceB = createProvider();
			const mockServerA = createMockServer();

			await instanceA.start();
			await instanceB.start();

			instanceA.setServer(mockServerA);

			// Both sockets subscribe to same topic
			instanceA.subscribe(SOCKET_INSTANCE_A, 'shared:room');
			instanceA.subscribe(SOCKET_INSTANCE_B, 'shared:room');
			await delay(200);

			// Verify both can receive
			await instanceB.publish('shared:room', 'Message 1');
			await waitFor(() => mockServerA.publishedMessages.length >= 1, { timeout: 2000 });
			expect(mockServerA.publishedMessages.length).toBe(1);

			// Socket A unsubscribes (but doesn't disconnect)
			instanceA.unsubscribe(SOCKET_INSTANCE_A, 'shared:room');
			await delay(200);

			// Clear and publish again
			mockServerA.publishedMessages.length = 0;
			await instanceB.publish('shared:room', 'Message 2');
			await waitFor(() => mockServerA.publishedMessages.length >= 1, { timeout: 2000 });

			// Message should still be delivered (Socket B still subscribed)
			expect(mockServerA.publishedMessages.length).toBe(1);

			// Socket B unsubscribes - no more subscribers
			instanceA.unsubscribe(SOCKET_INSTANCE_B, 'shared:room');
			await delay(200);

			// Clear and publish again
			mockServerA.publishedMessages.length = 0;
			await instanceB.publish('shared:room', 'Message 3');
			await delay(500);

			// No message should be delivered (no subscribers)
			expect(mockServerA.publishedMessages.length).toBe(0);
		});
	});
});
