/**
 * Unit tests for SocketCoordinator
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SocketCoordinator } from '../src/socket-coordinator.js';
import { InProcWsProvider } from '../src/in-proc-provider.js';
import type { WebSocketProvider } from '../src/types.js';
import { createMockWebSocket } from './helpers/mock-websocket.js';

/** Valid UUID v4 socket IDs for testing */
const SOCKET_1 = '550e8400-e29b-41d4-a716-446655440001';
const SOCKET_2 = '550e8400-e29b-41d4-a716-446655440002';
const SOCKET_3 = '550e8400-e29b-41d4-a716-446655440003';

describe('SocketCoordinator', () => {
	let coordinator: SocketCoordinator;
	let provider: WebSocketProvider;

	beforeEach(() => {
		provider = new InProcWsProvider();
		coordinator = new SocketCoordinator({ provider });
	});

	describe('constructor', () => {
		it('should create coordinator with provider', () => {
			expect(coordinator).toBeInstanceOf(SocketCoordinator);
		});

		it('should accept custom logger', () => {
			const customLogger = {
				info: mock(() => {}),
				warn: mock(() => {}),
				error: mock(() => {}),
				debug: mock(() => {})
			};
			const c = new SocketCoordinator({
				provider,
				logger: customLogger as never
			});
			expect(c).toBeInstanceOf(SocketCoordinator);
		});
	});

	describe('addConnection', () => {
		it('should increment connection count when addConnection is called with valid socket', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);
			expect(coordinator.getConnectionCount()).toBe(1);
		});

		it('should allow retrieving added connection', () => {
			const ws = createMockWebSocket(SOCKET_1, { userId: 'user-123' });
			coordinator.addConnection(ws);

			const retrieved = coordinator.getConnection<{ userId: string }>(SOCKET_1);
			expect(retrieved).toBeDefined();
			expect(retrieved?.data.data.userId).toBe('user-123');
		});
	});

	describe('removeConnection', () => {
		it('should remove a connection when removeConnection is called with existing socket ID', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);
			expect(coordinator.getConnectionCount()).toBe(1);

			coordinator.removeConnection(SOCKET_1);
			expect(coordinator.getConnectionCount()).toBe(0);
		});

		it('should clean up subscriptions when removing connection', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_1, 'topic-2');

			// Verify subscriptions exist
			expect(coordinator.getTopicSubscribers('topic-1').length).toBe(1);
			expect(coordinator.getTopicSubscribers('topic-2').length).toBe(1);

			// Remove connection
			coordinator.removeConnection(SOCKET_1);

			// Subscriptions should be cleaned up
			expect(coordinator.getTopicSubscribers('topic-1').length).toBe(0);
			expect(coordinator.getTopicSubscribers('topic-2').length).toBe(0);
		});

		it('should not throw when removing non-existent connection', () => {
			expect(() => coordinator.removeConnection(SOCKET_1)).not.toThrow();
		});

		it('should unsubscribe from Bun topics when removing', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			coordinator.removeConnection(SOCKET_1);

			expect(ws.unsubscribe).toHaveBeenCalledWith('topic-1');
		});
	});

	describe('subscribeToTopic', () => {
		it('should add socket to topic subscribers when subscribeToTopic is called', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			expect(coordinator.getTopicSubscribers('topic-1')).toHaveLength(1);
		});

		it('should call ws.subscribe for Bun native pub/sub', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			expect(ws.subscribe).toHaveBeenCalledWith('topic-1');
		});

		it('should delegate to provider for cross-instance subscriptions', () => {
			const subscribeMock = mock(() => {});
			const mockProvider = {
				subscribe: subscribeMock,
				unsubscribe: mock(() => {})
			} as unknown as WebSocketProvider;

			const c = new SocketCoordinator({ provider: mockProvider });
			const ws = createMockWebSocket(SOCKET_1);
			c.addConnection(ws);
			c.subscribeToTopic(SOCKET_1, 'topic-1');

			expect(subscribeMock).toHaveBeenCalledWith(SOCKET_1, 'topic-1');
		});

		it('should be idempotent for same subscription', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);

			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			expect(coordinator.getTopicSubscribers('topic-1')).toHaveLength(1);
		});

		it('should warn when subscribing unknown socket', () => {
			const warnMock = mock(() => {});
			const c = new SocketCoordinator({
				provider,
				logger: {
					info: mock(() => {}),
					warn: warnMock,
					error: mock(() => {}),
					debug: mock(() => {})
				} as never
			});

			c.subscribeToTopic(SOCKET_1, 'topic-1');
			expect(warnMock).toHaveBeenCalled();
		});
	});

	describe('unsubscribeFromTopic', () => {
		it('should remove socket from topic subscribers when unsubscribeFromTopic is called', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			expect(coordinator.getTopicSubscribers('topic-1')).toHaveLength(1);

			coordinator.unsubscribeFromTopic(SOCKET_1, 'topic-1');
			expect(coordinator.getTopicSubscribers('topic-1')).toHaveLength(0);
		});

		it('should call ws.unsubscribe for Bun native pub/sub', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);
			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');

			coordinator.unsubscribeFromTopic(SOCKET_1, 'topic-1');

			expect(ws.unsubscribe).toHaveBeenCalledWith('topic-1');
		});

		it('should delegate to provider for cross-instance unsubscriptions', () => {
			const unsubscribeMock = mock(() => {});
			const mockProvider = {
				subscribe: mock(() => {}),
				unsubscribe: unsubscribeMock
			} as unknown as WebSocketProvider;

			const c = new SocketCoordinator({ provider: mockProvider });
			const ws = createMockWebSocket(SOCKET_1);
			c.addConnection(ws);
			c.subscribeToTopic(SOCKET_1, 'topic-1');

			c.unsubscribeFromTopic(SOCKET_1, 'topic-1');

			expect(unsubscribeMock).toHaveBeenCalledWith(SOCKET_1, 'topic-1');
		});

		it('should handle unsubscribing unknown socket', () => {
			expect(() => coordinator.unsubscribeFromTopic(SOCKET_1, 'topic')).not.toThrow();
		});
	});

	describe('getConnection', () => {
		it('should return connection when getConnection is called with existing socket ID', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);

			const retrieved = coordinator.getConnection(SOCKET_1);
			expect(retrieved).toBeDefined();
			expect(retrieved?.data.socketId).toBe(SOCKET_1);
		});

		it('should return undefined for unknown socket', () => {
			const retrieved = coordinator.getConnection(SOCKET_1);
			expect(retrieved).toBeUndefined();
		});

		it('should support typed data retrieval', () => {
			interface UserData {
				userId: string;
				role: string;
			}
			const ws = createMockWebSocket<UserData>(SOCKET_1, {
				userId: 'user-123',
				role: 'admin'
			});
			coordinator.addConnection(ws);

			const retrieved = coordinator.getConnection<UserData>(SOCKET_1);
			expect(retrieved?.data.data.userId).toBe('user-123');
			expect(retrieved?.data.data.role).toBe('admin');
		});
	});

	describe('getAllConnections', () => {
		it('should return empty array when no connections', () => {
			expect(coordinator.getAllConnections()).toEqual([]);
		});

		it('should return all active connections', () => {
			const ws1 = createMockWebSocket(SOCKET_1);
			const ws2 = createMockWebSocket(SOCKET_2);
			const ws3 = createMockWebSocket(SOCKET_3);

			coordinator.addConnection(ws1);
			coordinator.addConnection(ws2);
			coordinator.addConnection(ws3);

			const connections = coordinator.getAllConnections();
			expect(connections).toHaveLength(3);

			const socketIds = connections.map((c) => c.data.socketId);
			expect(socketIds).toContain(SOCKET_1);
			expect(socketIds).toContain(SOCKET_2);
			expect(socketIds).toContain(SOCKET_3);
		});

		it('should not include removed connections', () => {
			const ws1 = createMockWebSocket(SOCKET_1);
			const ws2 = createMockWebSocket(SOCKET_2);

			coordinator.addConnection(ws1);
			coordinator.addConnection(ws2);
			coordinator.removeConnection(SOCKET_1);

			const connections = coordinator.getAllConnections();
			expect(connections).toHaveLength(1);
			expect(connections[0]?.data.socketId).toBe(SOCKET_2);
		});
	});

	describe('getTopicSubscribers', () => {
		it('should return empty array for unknown topic', () => {
			expect(coordinator.getTopicSubscribers('unknown')).toEqual([]);
		});

		it('should return all subscribers for topic', () => {
			const firstTopicSubscriber = createMockWebSocket(SOCKET_1);
			const secondTopicSubscriber = createMockWebSocket(SOCKET_2);
			const differentTopicSubscriber = createMockWebSocket(SOCKET_3);

			coordinator.addConnection(firstTopicSubscriber);
			coordinator.addConnection(secondTopicSubscriber);
			coordinator.addConnection(differentTopicSubscriber);

			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_2, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_3, 'topic-2');

			const topic1Subscribers = coordinator.getTopicSubscribers('topic-1');
			expect(topic1Subscribers).toHaveLength(2);

			const topic2Subscribers = coordinator.getTopicSubscribers('topic-2');
			expect(topic2Subscribers).toHaveLength(1);
		});

		it('should only return connected sockets', () => {
			const socketToRemove = createMockWebSocket(SOCKET_1);
			const socketToKeep = createMockWebSocket(SOCKET_2);

			coordinator.addConnection(socketToRemove);
			coordinator.addConnection(socketToKeep);

			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_2, 'topic-1');

			// Remove one connection
			coordinator.removeConnection(SOCKET_1);

			const subscribers = coordinator.getTopicSubscribers('topic-1');
			expect(subscribers).toHaveLength(1);
			const remainingSubscriber = subscribers[0];
			expect(remainingSubscriber).toBeDefined();
			expect(remainingSubscriber!.data.socketId).toBe(SOCKET_2);
		});
	});

	describe('getConnectionCount', () => {
		it('should return 0 initially', () => {
			expect(coordinator.getConnectionCount()).toBe(0);
		});

		it('should return correct count', () => {
			const firstSocket = createMockWebSocket(SOCKET_1);
			const secondSocket = createMockWebSocket(SOCKET_2);

			coordinator.addConnection(firstSocket);
			expect(coordinator.getConnectionCount()).toBe(1);

			coordinator.addConnection(secondSocket);
			expect(coordinator.getConnectionCount()).toBe(2);

			coordinator.removeConnection(SOCKET_1);
			expect(coordinator.getConnectionCount()).toBe(1);
		});
	});

	describe('getProvider', () => {
		it('should return the provider', () => {
			expect(coordinator.getProvider()).toBe(provider);
		});
	});

	describe('topic tracking', () => {
		it('should track topics on socket data', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);

			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			coordinator.subscribeToTopic(SOCKET_1, 'topic-2');

			expect(ws.data.topics.has('topic-1')).toBe(true);
			expect(ws.data.topics.has('topic-2')).toBe(true);
		});

		it('should remove topic from socket data on unsubscribe', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);

			coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
			expect(ws.data.topics.has('topic-1')).toBe(true);

			coordinator.unsubscribeFromTopic(SOCKET_1, 'topic-1');
			expect(ws.data.topics.has('topic-1')).toBe(false);
		});
	});

	describe('edge cases', () => {
		it('should skip duplicate connection when same socket ID added twice (idempotent)', () => {
			const originalSocket = createMockWebSocket(SOCKET_1, { version: 1 });
			const duplicateSocket = createMockWebSocket(SOCKET_1, { version: 2 });

			coordinator.addConnection(originalSocket);
			coordinator.addConnection(duplicateSocket);

			// Should only have one connection
			expect(coordinator.getConnectionCount()).toBe(1);

			// Should keep the original (idempotent - skips duplicates)
			const connection = coordinator.getConnection<{ version: number }>(SOCKET_1);
			expect(connection?.data.data.version).toBe(1);
		});

		it('should handle rapid subscribe/unsubscribe cycles', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);

			// Rapid cycles
			for (let i = 0; i < 10; i++) {
				coordinator.subscribeToTopic(SOCKET_1, 'topic-1');
				coordinator.unsubscribeFromTopic(SOCKET_1, 'topic-1');
			}

			// Should end with no subscription
			expect(ws.data.topics.has('topic-1')).toBe(false);
			expect(coordinator.getTopicSubscribers('topic-1')).toHaveLength(0);
		});

		it('should handle removing connection while subscribed to multiple topics', () => {
			const ws = createMockWebSocket(SOCKET_1);
			coordinator.addConnection(ws);

			// Subscribe to many topics
			for (let i = 0; i < 5; i++) {
				coordinator.subscribeToTopic(SOCKET_1, `topic-${i}`);
			}

			expect(ws.data.topics.size).toBe(5);

			// Remove connection - should clean up all subscriptions
			coordinator.removeConnection(SOCKET_1);

			// All topics should be empty
			for (let i = 0; i < 5; i++) {
				expect(coordinator.getTopicSubscribers(`topic-${i}`)).toHaveLength(0);
			}
		});

		it('should handle operations on non-existent socket gracefully', () => {
			expect(() => coordinator.subscribeToTopic(SOCKET_1, 'topic')).not.toThrow();
			expect(() => coordinator.unsubscribeFromTopic(SOCKET_1, 'topic')).not.toThrow();
			expect(() => coordinator.removeConnection(SOCKET_1)).not.toThrow();
			expect(coordinator.getConnection(SOCKET_1)).toBeUndefined();
		});
	});
});
