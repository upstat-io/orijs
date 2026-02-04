/**
 * Unit tests for InProcWsProvider
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { InProcWsProvider, createInProcWsProvider } from '../src/in-proc-provider.js';

/** Mock server type for testing */
type MockServer = ReturnType<typeof Bun.serve>;

/** Valid UUID v4 socket IDs for testing */
const SOCKET_1 = '550e8400-e29b-41d4-a716-446655440001';
const SOCKET_2 = '550e8400-e29b-41d4-a716-446655440002';
const SOCKET_3 = '550e8400-e29b-41d4-a716-446655440003';

describe('InProcWsProvider', () => {
	let provider: InProcWsProvider;

	beforeEach(() => {
		provider = new InProcWsProvider();
	});

	describe('constructor', () => {
		it('should create provider with default options', () => {
			const p = new InProcWsProvider();
			expect(p).toBeInstanceOf(InProcWsProvider);
		});

		it('should create provider with custom logger', () => {
			const customLogger = {
				info: mock(() => {}),
				warn: mock(() => {}),
				error: mock(() => {}),
				debug: mock(() => {})
			};
			const p = new InProcWsProvider({ logger: customLogger as never });
			expect(p).toBeInstanceOf(InProcWsProvider);
		});
	});

	describe('factory function', () => {
		it('should create provider via createInProcWsProvider', () => {
			const p = createInProcWsProvider();
			expect(p).toBeInstanceOf(InProcWsProvider);
		});

		it('should pass options to constructor', () => {
			const customLogger = {
				info: mock(() => {}),
				warn: mock(() => {}),
				error: mock(() => {}),
				debug: mock(() => {})
			};
			const p = createInProcWsProvider({ logger: customLogger as never });
			expect(p).toBeInstanceOf(InProcWsProvider);
		});
	});

	describe('lifecycle management (start/stop)', () => {
		it('should resolve without error when start is called', async () => {
			await expect(provider.start()).resolves.toBeUndefined();
		});

		it('should resolve without error when stop is called after start', async () => {
			await provider.start();
			await expect(provider.stop()).resolves.toBeUndefined();
		});

		it('should be idempotent for multiple starts', async () => {
			await provider.start();
			await expect(provider.start()).resolves.toBeUndefined();
		});

		it('should be idempotent for multiple stops', async () => {
			await provider.start();
			await provider.stop();
			await expect(provider.stop()).resolves.toBeUndefined();
		});

		it('should allow stopping without starting', async () => {
			await expect(provider.stop()).resolves.toBeUndefined();
		});
	});

	describe('setServer configuration', () => {
		it('should not throw when setServer receives a valid server', () => {
			const mockServer = {
				publish: mock(() => 0)
			} as unknown as MockServer;

			expect(() => provider.setServer(mockServer)).not.toThrow();
		});
	});

	describe('publish to topics', () => {
		it('should log error and reject when server not set', async () => {
			const errorMock = mock(() => {});
			const loggerProvider = new InProcWsProvider({
				logger: {
					info: mock(() => {}),
					warn: mock(() => {}),
					error: errorMock,
					debug: mock(() => {})
				} as never
			});

			await expect(loggerProvider.publish('topic', 'message')).rejects.toThrow('Provider not ready');
			expect(errorMock).toHaveBeenCalled();
		});

		it('should call server.publish when server is set', () => {
			const publishMock = mock(() => 0);
			const mockServer = {
				publish: publishMock
			} as unknown as MockServer;

			provider.setServer(mockServer);
			provider.publish('my-topic', 'my-message');

			expect(publishMock).toHaveBeenCalledWith('my-topic', 'my-message');
		});

		it('should accept ArrayBuffer as message parameter when publishing', () => {
			const publishMock = mock(() => 0);
			const mockServer = {
				publish: publishMock
			} as unknown as MockServer;

			provider.setServer(mockServer);
			const buffer = new ArrayBuffer(8);
			provider.publish('my-topic', buffer);

			expect(publishMock).toHaveBeenCalledWith('my-topic', buffer);
		});
	});

	describe('broadcast to all connections', () => {
		it('should publish to __broadcast__ topic when broadcast is called', () => {
			const publishMock = mock(() => 0);
			const mockServer = {
				publish: publishMock
			} as unknown as MockServer;

			provider.setServer(mockServer);
			provider.broadcast('broadcast-message');

			expect(publishMock).toHaveBeenCalledWith('__broadcast__', 'broadcast-message');
		});
	});

	describe('send', () => {
		const validSocketId = '550e8400-e29b-41d4-a716-446655440000';

		it('should publish to socket-specific channel and return true', () => {
			const publishMock = mock(() => 0);
			const mockServer = {
				publish: publishMock
			} as unknown as MockServer;

			provider.setServer(mockServer);
			provider.send(validSocketId, 'direct-message');

			expect(publishMock).toHaveBeenCalledWith(`__socket__:${validSocketId}`, 'direct-message');
		});

		it('should throw on invalid socket ID format', () => {
			expect(() => provider.send('socket-123', 'message')).toThrow('Invalid socket ID format');
			expect(() => provider.send('not-a-uuid', 'message')).toThrow('Invalid socket ID format');
		});

		it('should throw on empty socket ID', () => {
			expect(() => provider.send('', 'message')).toThrow('Socket ID cannot be empty');
		});
	});

	describe('subscribe', () => {
		it('should track socket subscriptions when subscribe is called', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);
		});

		it('should track multiple subscriptions to same topic', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_2, 'topic-1');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(2);
		});

		it('should track subscriptions to different topics', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_1, 'topic-2');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(1);
		});

		it('should mark socket as connected when subscribed', () => {
			expect(provider.isConnected(SOCKET_1)).toBe(false);
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.isConnected(SOCKET_1)).toBe(true);
		});

		it('should throw on invalid socket ID format', () => {
			expect(() => provider.subscribe('invalid-socket', 'topic-1')).toThrow('Invalid socket ID format');
		});

		it('should throw on empty socket ID', () => {
			expect(() => provider.subscribe('', 'topic-1')).toThrow('Socket ID cannot be empty');
		});
	});

	describe('disconnect', () => {
		it('should disconnect socket and remove from all topics', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_1, 'topic-2');
			expect(provider.isConnected(SOCKET_1)).toBe(true);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(1);

			provider.disconnect(SOCKET_1);

			expect(provider.isConnected(SOCKET_1)).toBe(false);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(0);
		});

		it('should throw on invalid socket ID format', () => {
			expect(() => provider.disconnect('invalid-socket')).toThrow('Invalid socket ID format');
		});

		it('should throw on empty socket ID', () => {
			expect(() => provider.disconnect('')).toThrow('Socket ID cannot be empty');
		});
	});

	describe('unsubscribe', () => {
		it('should remove subscription', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(1);

			provider.unsubscribe(SOCKET_1, 'topic-1');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);
		});

		it('should throw on invalid socket ID format', () => {
			expect(() => provider.unsubscribe('invalid-socket', 'topic')).toThrow('Invalid socket ID format');
		});

		it('should handle unsubscribe for non-existent topic', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(() => provider.unsubscribe(SOCKET_1, 'unknown-topic')).not.toThrow();
		});

		it('should clean up empty topic sets', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.unsubscribe(SOCKET_1, 'topic-1');
			// Topic should be removed from map (getTopicSubscriberCount returns 0)
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);
		});
	});

	describe('isConnected', () => {
		it('should return false for unknown socket', () => {
			expect(provider.isConnected(SOCKET_1)).toBe(false);
		});

		it('should return true for subscribed socket', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.isConnected(SOCKET_1)).toBe(true);
		});
	});

	describe('getConnectionCount', () => {
		it('should return 0 initially', () => {
			expect(provider.getConnectionCount()).toBe(0);
		});

		it('should count unique connected sockets', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_2, 'topic-1');
			expect(provider.getConnectionCount()).toBe(2);
		});

		it('should not double count same socket subscribed to multiple topics', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_1, 'topic-2');
			expect(provider.getConnectionCount()).toBe(1);
		});
	});

	describe('getTopicSubscriberCount', () => {
		it('should return 0 for unknown topic', () => {
			expect(provider.getTopicSubscriberCount('unknown')).toBe(0);
		});

		it('should return correct count', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_2, 'topic-1');
			provider.subscribe(SOCKET_3, 'topic-2');
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(2);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(1);
		});
	});

	describe('automatic disconnection on unsubscribe', () => {
		it('should mark socket as disconnected when last subscription is removed', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			expect(provider.isConnected(SOCKET_1)).toBe(true);

			provider.unsubscribe(SOCKET_1, 'topic-1');
			expect(provider.isConnected(SOCKET_1)).toBe(false);
		});

		it('should keep socket connected while subscriptions remain', () => {
			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_1, 'topic-2');
			expect(provider.isConnected(SOCKET_1)).toBe(true);

			provider.unsubscribe(SOCKET_1, 'topic-1');
			expect(provider.isConnected(SOCKET_1)).toBe(true);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(1);

			provider.unsubscribe(SOCKET_1, 'topic-2');
			expect(provider.isConnected(SOCKET_1)).toBe(false);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(0);
		});

		it('should throw on invalid socket ID', () => {
			expect(() => provider.unsubscribe('invalid-socket', 'topic-1')).toThrow('Invalid socket ID format');
		});
	});

	describe('stop cleanup', () => {
		it('should clear all subscriptions on stop', async () => {
			await provider.start();

			provider.subscribe(SOCKET_1, 'topic-1');
			provider.subscribe(SOCKET_2, 'topic-2');
			expect(provider.getConnectionCount()).toBe(2);

			await provider.stop();

			expect(provider.getConnectionCount()).toBe(0);
			expect(provider.getTopicSubscriberCount('topic-1')).toBe(0);
			expect(provider.getTopicSubscriberCount('topic-2')).toBe(0);
		});

		it('should clear server reference on stop', async () => {
			const errorMock = mock(() => {});
			const publishMock = mock(() => 0);
			const mockServer = {
				publish: publishMock
			} as unknown as MockServer;

			// Create provider with logger to capture errors
			const testProvider = new InProcWsProvider({
				logger: {
					info: mock(() => {}),
					warn: mock(() => {}),
					error: errorMock,
					debug: mock(() => {})
				} as never
			});

			await testProvider.start();
			testProvider.setServer(mockServer);
			await testProvider.publish('topic', 'before-stop');
			expect(publishMock).toHaveBeenCalledWith('topic', 'before-stop');
			expect(errorMock).not.toHaveBeenCalled();

			await testProvider.stop();

			// After stop, server reference should be cleared
			// Publishing should now reject (same provider instance)
			await expect(testProvider.publish('topic', 'after-stop')).rejects.toThrow('Provider not ready');
			expect(errorMock).toHaveBeenCalled();
			// Server's publish should NOT have been called again
			expect(publishMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('topic validation', () => {
		it('should throw on empty topic for subscribe', () => {
			expect(() => provider.subscribe(SOCKET_1, '')).toThrow('Topic cannot be empty');
		});

		it('should throw on empty topic for unsubscribe', () => {
			expect(() => provider.unsubscribe(SOCKET_1, '')).toThrow('Topic cannot be empty');
		});

		it('should throw on empty topic for publish', () => {
			expect(() => provider.publish('', 'message')).toThrow('Topic cannot be empty');
		});

		it('should throw on topic with invalid characters', () => {
			// Control characters
			expect(() => provider.subscribe(SOCKET_1, 'topic\x00name')).toThrow(
				'Topic contains invalid characters'
			);
			// Special characters not in allowlist
			expect(() => provider.subscribe(SOCKET_1, 'topic*name')).toThrow('Topic contains invalid characters');
			expect(() => provider.subscribe(SOCKET_1, 'topic?name')).toThrow('Topic contains invalid characters');
			expect(() => provider.subscribe(SOCKET_1, 'topic[name]')).toThrow('Topic contains invalid characters');
		});

		it('should throw on topic exceeding max length', () => {
			const longTopic = 'a'.repeat(257);
			expect(() => provider.subscribe(SOCKET_1, longTopic)).toThrow('Topic name too long');
		});

		it('should accept valid topic names', () => {
			expect(() => provider.subscribe(SOCKET_1, 'valid:topic:name')).not.toThrow();
			expect(() => provider.subscribe(SOCKET_1, 'topic-with-dashes')).not.toThrow();
			expect(() => provider.subscribe(SOCKET_1, 'topic_with_underscores')).not.toThrow();
		});
	});
});
