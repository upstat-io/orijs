/**
 * Functional tests for SocketCoordinator + InProcWsProvider integration.
 *
 * Verifies the complete interaction chain works correctly without mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SocketCoordinator } from '../src/socket-coordinator.js';
import { InProcWsProvider } from '../src/in-proc-provider.js';
import { createMockWebSocket } from './helpers/mock-websocket.js';

/** Valid UUID v4 socket IDs for testing */
const SOCKET_1 = '550e8400-e29b-41d4-a716-446655440001';
const SOCKET_2 = '550e8400-e29b-41d4-a716-446655440002';

describe('SocketCoordinator + InProcWsProvider Integration', () => {
	let provider: InProcWsProvider;
	let coordinator: SocketCoordinator;

	beforeEach(async () => {
		provider = new InProcWsProvider();
		coordinator = new SocketCoordinator({ provider });
		await provider.start();
	});

	afterEach(async () => {
		await provider.stop();
	});

	describe('connection lifecycle', () => {
		it('should track connection in both coordinator and provider when subscribed', () => {
			const ws = createMockWebSocket(SOCKET_1);

			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			// Coordinator tracks connection
			expect(coordinator.getConnectionCount()).toBe(1);
			expect(coordinator.getConnection(SOCKET_1)).toBeDefined();

			// Provider tracks subscription
			expect(provider.isConnected(SOCKET_1)).toBe(true);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);
		});

		it('should clean up both coordinator and provider state when connection removed', () => {
			const ws = createMockWebSocket(SOCKET_1);

			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_1, 'topic-2');

			// Verify initial state
			expect(coordinator.getConnectionCount()).toBe(1);
			expect(provider.isConnected(SOCKET_1)).toBe(true);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(1);

			// Remove connection
			coordinator.removeConnection(SOCKET_1);

			// Coordinator cleaned up
			expect(coordinator.getConnectionCount()).toBe(0);
			expect(coordinator.getConnection(SOCKET_1)).toBeUndefined();

			// Provider cleaned up (via unsubscribe calls triggering markDisconnected)
			expect(provider.isConnected(SOCKET_1)).toBe(false);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(0);
		});
	});

	describe('subscription flow', () => {
		it('should synchronize subscription state between coordinator and provider', () => {
			const ws1 = createMockWebSocket(SOCKET_1);
			const ws2 = createMockWebSocket(SOCKET_2);

			coordinator.addConnection(ws1);
			coordinator.addConnection(ws2);

			// Subscribe both to same topic
			coordinator.subscribeToTopic(SOCKET_1, 'shared-topic');
			coordinator.subscribeToTopic(SOCKET_2, 'shared-topic');

			// Coordinator tracks subscribers
			const subscribers = coordinator.getTopicSubscribers('shared-topic');
			expect(subscribers).toHaveLength(2);

			// Provider tracks subscribers
			expect(provider.getTopicSubscriberCount('shared-topic')).toBe(2);

			// Unsubscribe one
			coordinator.unsubscribeFromTopic(SOCKET_1, 'shared-topic');

			// Both should reflect the change
			expect(coordinator.getTopicSubscribers('shared-topic')).toHaveLength(1);
			expect(provider.getTopicSubscriberCount('shared-topic')).toBe(1);
		});

		it('should handle multiple topics per socket correctly', () => {
			const ws = createMockWebSocket(SOCKET_1);

			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-a');
			coordinator.subscribeToTopic(SOCKET_1, 'topic-b');
			coordinator.subscribeToTopic(SOCKET_1, 'topic-c');

			// All topics tracked
			expect(provider.getTopicSubscriberCount('topic-a')).toBe(1);
			expect(provider.getTopicSubscriberCount('topic-b')).toBe(1);
			expect(provider.getTopicSubscriberCount('topic-c')).toBe(1);

			// Socket still connected after partial unsubscribe
			coordinator.unsubscribeFromTopic(SOCKET_1, 'topic-a');
			expect(provider.isConnected(SOCKET_1)).toBe(true);

			coordinator.unsubscribeFromTopic(SOCKET_1, 'topic-b');
			expect(provider.isConnected(SOCKET_1)).toBe(true);

			// Socket disconnected after last unsubscribe
			coordinator.unsubscribeFromTopic(SOCKET_1, 'topic-c');
			expect(provider.isConnected(SOCKET_1)).toBe(false);
		});
	});

	describe('idempotency', () => {
		it('should handle duplicate subscriptions idempotently', () => {
			const ws = createMockWebSocket(SOCKET_1);

			coordinator.addConnection(ws);

			// Subscribe multiple times
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			// Should only count once
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);
			expect(coordinator.getTopicSubscribers('topic-1')).toHaveLength(1);
		});

		it('should handle unsubscribe from non-subscribed topic gracefully', () => {
			const ws = createMockWebSocket(SOCKET_1);

			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			// Unsubscribe from topic never subscribed to
			expect(() => {
				coordinator.unsubscribeFromTopic(SOCKET_1, 'never-subscribed');
			}).not.toThrow();

			// Original subscription intact
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);
		});
	});

	describe('provider stop cleanup', () => {
		it('should clear all provider state on stop while coordinator retains connections', async () => {
			const ws = createMockWebSocket(SOCKET_1);

			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			// Provider has state
			expect(provider.isConnected(SOCKET_1)).toBe(true);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);

			// Stop provider
			await provider.stop();

			// Provider state cleared
			expect(provider.isConnected(SOCKET_1)).toBe(false);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);
			expect(provider.getConnectionCount()).toBe(0);

			// Coordinator still has connection reference (for reconnection scenarios)
			expect(coordinator.getConnectionCount()).toBe(1);
			expect(coordinator.getConnection(SOCKET_1)).toBeDefined();
		});
	});
});
