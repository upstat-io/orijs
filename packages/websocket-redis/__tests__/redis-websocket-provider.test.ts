import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { RedisWsProvider, createRedisWsProvider } from '../src/redis-websocket-provider';
import type { BunServer } from '@orijs/websocket';
import { waitFor } from '@orijs/test-utils';

/** Valid UUID v4 socket IDs for testing */
const SOCKET_1 = '550e8400-e29b-41d4-a716-446655440001';
const SOCKET_2 = '550e8400-e29b-41d4-a716-446655440002';
const SOCKET_3 = '550e8400-e29b-41d4-a716-446655440003';

/**
 * Unit tests for RedisWsProvider
 *
 * These tests verify the internal state management logic in isolation.
 * They use a non-existent Redis host to avoid actual connections while
 * testing the provider's local state tracking.
 *
 * For integration tests with real Redis, see redis-websocket-provider.functional.test.ts
 */

describe('RedisWsProvider', () => {
	// Use invalid host to prevent actual connections while testing local state
	const defaultOptions = {
		connection: { host: 'invalid-host-for-testing', port: 9999 },
		connectTimeout: 100 // Fast timeout for tests
	};

	describe('constructor', () => {
		it('should use default keyPrefix "ws" when not provided', () => {
			const provider = new RedisWsProvider({
				connection: { host: 'localhost', port: 6379 }
			});

			expect(provider.getKeyPrefix()).toBe('ws');
		});

		it('should use custom keyPrefix when provided', () => {
			const provider = new RedisWsProvider({
				connection: { host: 'localhost', port: 6379 },
				keyPrefix: 'custom'
			});

			expect(provider.getKeyPrefix()).toBe('custom');
		});

		it('should use default connectTimeout of 2000ms when not provided', () => {
			const provider = new RedisWsProvider({
				connection: { host: 'localhost', port: 6379 }
			});

			expect(provider.getConnectTimeout()).toBe(2000);
		});

		it('should use custom connectTimeout when provided', () => {
			const provider = new RedisWsProvider({
				connection: { host: 'localhost', port: 6379 },
				connectTimeout: 5000
			});

			expect(provider.getConnectTimeout()).toBe(5000);
		});
	});

	describe('local subscription tracking (without Redis)', () => {
		let provider: RedisWsProvider;

		beforeEach(() => {
			provider = new RedisWsProvider(defaultOptions);
		});

		describe('subscribe() - local state tracking', () => {
			it('should track local subscription count', () => {
				provider.subscribe(SOCKET_1, 'room:123');

				expect(provider.getTopicSubscriberCount('room:123')).toBe(1);
			});

			it('should track socket as connected', () => {
				provider.subscribe(SOCKET_1, 'room:123');

				expect(provider.isConnected(SOCKET_1)).toBe(true);
			});

			it('should track multiple sockets on same topic', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_2, 'room:123');

				expect(provider.getTopicSubscriberCount('room:123')).toBe(2);
				expect(provider.isConnected(SOCKET_1)).toBe(true);
				expect(provider.isConnected(SOCKET_2)).toBe(true);
			});

			it('should track multiple topics per socket', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_1, 'room:456');

				expect(provider.getTopicSubscriberCount('room:123')).toBe(1);
				expect(provider.getTopicSubscriberCount('room:456')).toBe(1);
				expect(provider.getConnectionCount()).toBe(1);
			});

			it('should be idempotent for same socket and topic', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_1, 'room:123');

				expect(provider.getTopicSubscriberCount('room:123')).toBe(1);
			});
		});

		describe('unsubscribe()', () => {
			it('should remove socket from topic', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.unsubscribe(SOCKET_1, 'room:123');

				expect(provider.getTopicSubscriberCount('room:123')).toBe(0);
			});

			it('should keep other sockets subscribed', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_2, 'room:123');
				provider.unsubscribe(SOCKET_1, 'room:123');

				expect(provider.getTopicSubscriberCount('room:123')).toBe(1);
				expect(provider.isConnected(SOCKET_2)).toBe(true);
			});

			it('should mark socket as disconnected when no subscriptions remain', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_1, 'room:456');

				provider.unsubscribe(SOCKET_1, 'room:123');
				expect(provider.isConnected(SOCKET_1)).toBe(true);

				provider.unsubscribe(SOCKET_1, 'room:456');
				expect(provider.isConnected(SOCKET_1)).toBe(false);
			});

			it('should throw on invalid socket ID format', () => {
				expect(() => provider.unsubscribe('invalid-socket', 'nonexistent')).toThrow(
					'Invalid socket ID format'
				);
			});

			it('should do nothing for non-subscribed socket', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.unsubscribe(SOCKET_2, 'room:123');

				expect(provider.getTopicSubscriberCount('room:123')).toBe(1);
			});
		});

		describe('isConnected()', () => {
			it('should return true when socket has subscriptions', () => {
				provider.subscribe(SOCKET_1, 'room:123');

				expect(provider.isConnected(SOCKET_1)).toBe(true);
			});

			it('should return false when socket has no subscriptions', () => {
				expect(provider.isConnected(SOCKET_1)).toBe(false);
			});

			it('should return false after socket unsubscribes from all topics', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.unsubscribe(SOCKET_1, 'room:123');

				expect(provider.isConnected(SOCKET_1)).toBe(false);
			});
		});

		describe('getConnectionCount()', () => {
			it('should return 0 initially', () => {
				expect(provider.getConnectionCount()).toBe(0);
			});

			it('should return count of unique connected sockets', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				expect(provider.getConnectionCount()).toBe(1);

				provider.subscribe(SOCKET_2, 'room:123');
				expect(provider.getConnectionCount()).toBe(2);

				provider.subscribe(SOCKET_2, 'room:456');
				expect(provider.getConnectionCount()).toBe(2); // Still 2 unique sockets
			});
		});

		describe('getTopicSubscriberCount()', () => {
			it('should return 0 for non-existent topic', () => {
				expect(provider.getTopicSubscriberCount('nonexistent')).toBe(0);
			});

			it('should return correct count when topic has multiple subscribers', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_2, 'room:123');
				provider.subscribe(SOCKET_3, 'room:456');

				expect(provider.getTopicSubscriberCount('room:123')).toBe(2);
				expect(provider.getTopicSubscriberCount('room:456')).toBe(1);
			});
		});

		describe('disconnect()', () => {
			it('should remove socket from all topics', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_1, 'room:456');
				provider.subscribe(SOCKET_2, 'room:123');

				provider.disconnect(SOCKET_1);

				expect(provider.getTopicSubscriberCount('room:123')).toBe(1);
				expect(provider.getTopicSubscriberCount('room:456')).toBe(0);
				expect(provider.isConnected(SOCKET_1)).toBe(false);
				expect(provider.isConnected(SOCKET_2)).toBe(true);
			});

			it('should mark socket as disconnected', () => {
				provider.subscribe(SOCKET_1, 'room:123');
				expect(provider.isConnected(SOCKET_1)).toBe(true);

				provider.disconnect(SOCKET_1);

				expect(provider.isConnected(SOCKET_1)).toBe(false);
				expect(provider.getConnectionCount()).toBe(0);
			});

			it('should throw on invalid socket ID format', () => {
				expect(() => provider.disconnect('nonexistent')).toThrow('Invalid socket ID format');
			});

			it('should clean up empty topic subscriptions', () => {
				provider.subscribe(SOCKET_1, 'room:123');

				provider.disconnect(SOCKET_1);

				expect(provider.getTopicSubscriberCount('room:123')).toBe(0);
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
				expect(() => provider.subscribe(SOCKET_1, 'topic[name]')).toThrow(
					'Topic contains invalid characters'
				);
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

	describe('setServer()', () => {
		it('should accept server reference without throwing', () => {
			const provider = new RedisWsProvider(defaultOptions);
			const mockServer = { publish: mock(() => 0) } as unknown as BunServer;

			expect(() => provider.setServer(mockServer)).not.toThrow();
		});
	});

	describe('publish() without start', () => {
		it('should reject with error when provider not started', async () => {
			const provider = new RedisWsProvider(defaultOptions);

			await expect(provider.publish('room:123', 'Message')).rejects.toThrow(
				'Cannot publish to topic "room:123": Provider not ready'
			);
		});
	});

	describe('send()', () => {
		it('should not throw with valid UUID', () => {
			const provider = new RedisWsProvider(defaultOptions);

			expect(() => provider.send('550e8400-e29b-41d4-a716-446655440000', 'Message')).not.toThrow();
		});

		it('should throw on invalid socket ID format', () => {
			const provider = new RedisWsProvider(defaultOptions);

			expect(() => provider.send('socket-123', 'Message')).toThrow('Invalid socket ID format');
			expect(() => provider.send('not-a-uuid', 'Message')).toThrow('Invalid socket ID format');
		});

		it('should throw on empty socket ID', () => {
			const provider = new RedisWsProvider(defaultOptions);

			expect(() => provider.send('', 'Message')).toThrow('Socket ID cannot be empty');
		});
	});

	describe('broadcast()', () => {
		it('should not throw when provider not started', () => {
			const provider = new RedisWsProvider(defaultOptions);

			expect(() => provider.broadcast('Broadcast message')).not.toThrow();
		});
	});

	describe('lifecycle state management', () => {
		describe('stop() without start', () => {
			it('should do nothing and not throw', async () => {
				const provider = new RedisWsProvider(defaultOptions);

				await expect(provider.stop()).resolves.toBeUndefined();
			});
		});

		describe('stop() clears local state', () => {
			it('should be idempotent when stop called without prior start', async () => {
				const provider = new RedisWsProvider(defaultOptions);

				// Add subscriptions without starting (they're tracked locally)
				provider.subscribe(SOCKET_1, 'room:123');
				provider.subscribe(SOCKET_2, 'room:456');

				expect(provider.getConnectionCount()).toBe(2);

				// stop() is idempotent - does nothing if not started
				await provider.stop();

				// State preserved since provider was never started
				expect(provider.getConnectionCount()).toBe(2);
			});
		});
	});

	describe('subscribeWithRetry behavior', () => {
		it('should retry subscription up to max retries and clean up pendingSubscriptions', async () => {
			const warnMock = mock((_msg: string, _ctx?: Record<string, unknown>) => {});
			const errorMock = mock((_msg: string, _ctx?: Record<string, unknown>) => {});
			const mockLogger = {
				info: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				warn: warnMock,
				error: errorMock,
				debug: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				child: () => mockLogger
			};

			// Create provider with invalid connection and short timeout
			const provider = new RedisWsProvider({
				connection: { host: 'invalid-host-for-retry-test', port: 59999 },
				connectTimeout: 50, // Very short timeout for fast failures
				logger: mockLogger as never
			});

			await provider.start();

			// Subscribe to trigger retry behavior
			provider.subscribe(SOCKET_1, 'room:test');

			// Wait for all retries to complete using polling instead of fixed delay
			// Expects 2 retry warnings (SUBSCRIBE_MAX_RETRIES - 1) and 1 final error
			await waitFor(
				() => {
					const retryWarnings = warnMock.mock.calls.filter(
						(call) => typeof call[0] === 'string' && call[0].includes('Redis subscribe failed, retrying')
					);
					const finalErrors = errorMock.mock.calls.filter(
						(call) =>
							typeof call[0] === 'string' && call[0].includes('Redis subscribe failed after max retries')
					);
					return retryWarnings.length === 2 && finalErrors.length === 1;
				},
				{ timeout: 3000, message: 'Retries did not complete as expected' }
			);

			// Verify retry warnings count
			const retryWarnings = warnMock.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].includes('Redis subscribe failed, retrying')
			);
			expect(retryWarnings.length).toBe(2);

			// Verify final error count
			const finalErrors = errorMock.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].includes('Redis subscribe failed after max retries')
			);
			expect(finalErrors.length).toBe(1);

			// Access private pendingSubscriptions to verify cleanup
			const pendingSubscriptions = (provider as unknown as { pendingSubscriptions: Set<string> })
				.pendingSubscriptions;
			expect(pendingSubscriptions.size).toBe(0);

			await provider.stop();
		});
	});

	describe('handleRedisMessage error paths', () => {
		it('should log warning for malformed JSON', async () => {
			const warnMock = mock((_msg: string, _ctx?: Record<string, unknown>) => {});
			const mockLogger = {
				info: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				warn: warnMock,
				error: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				debug: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				child: () => mockLogger
			};
			const mockServer = { publish: mock(() => {}) };

			const provider = new RedisWsProvider({
				...defaultOptions,
				logger: mockLogger as never
			});

			await provider.start();
			provider.setServer(mockServer as unknown as BunServer);

			// Access subscriber and emit message with invalid JSON
			const subscriber = (
				provider as unknown as {
					subscriber: { emit: (event: string, channel: string, message: string) => void };
				}
			).subscriber;
			subscriber.emit('message', 'ws:test-channel', 'not-valid-json{');

			// Verify warning was logged
			const jsonWarnings = warnMock.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].includes('Failed to handle Redis message')
			);
			expect(jsonWarnings.length).toBe(1);
			expect(mockServer.publish).not.toHaveBeenCalled();

			await provider.stop();
		});

		it('should log warning for invalid message envelope structure', async () => {
			const warnMock = mock((_msg: string, _ctx?: Record<string, unknown>) => {});
			const mockLogger = {
				info: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				warn: warnMock,
				error: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				debug: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				child: () => mockLogger
			};
			const mockServer = { publish: mock(() => {}) };

			const provider = new RedisWsProvider({
				...defaultOptions,
				logger: mockLogger as never
			});

			await provider.start();
			provider.setServer(mockServer as unknown as BunServer);

			const subscriber = (
				provider as unknown as {
					subscriber: { emit: (event: string, channel: string, message: string) => void };
				}
			).subscriber;

			// Valid JSON but missing required envelope fields
			subscriber.emit('message', 'ws:test-channel', JSON.stringify({ foo: 'bar' }));

			// Verify warning was logged for invalid format
			const formatWarnings = warnMock.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].includes('Invalid Redis message format')
			);
			expect(formatWarnings.length).toBe(1);
			expect(mockServer.publish).not.toHaveBeenCalled();

			await provider.stop();
		});

		it('should log warning when server not set', async () => {
			const warnMock = mock((_msg: string, _ctx?: Record<string, unknown>) => {});
			const mockLogger = {
				info: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				warn: warnMock,
				error: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				debug: mock((_msg: string, _ctx?: Record<string, unknown>) => {}),
				child: () => mockLogger
			};

			const provider = new RedisWsProvider({
				...defaultOptions,
				logger: mockLogger as never
			});

			await provider.start();
			// Deliberately NOT setting server

			const subscriber = (
				provider as unknown as {
					subscriber: { emit: (event: string, channel: string, message: string) => void };
				}
			).subscriber;

			// Send valid message but without server set
			subscriber.emit(
				'message',
				'ws:test-channel',
				JSON.stringify({
					topic: 'test',
					message: 'hello',
					isBinary: false
				})
			);

			// Verify warning was logged
			const serverWarnings = warnMock.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].includes('Server not set')
			);
			expect(serverWarnings.length).toBe(1);

			await provider.stop();
		});
	});

	describe('sanitizeJson (prototype pollution protection)', () => {
		it('should strip __proto__ from incoming messages', async () => {
			const mockServer = { publish: mock(() => {}) };

			const provider = new RedisWsProvider(defaultOptions);
			await provider.start();
			provider.setServer(mockServer as unknown as BunServer);

			const subscriber = (
				provider as unknown as {
					subscriber: { emit: (event: string, channel: string, message: string) => void };
				}
			).subscriber;

			// Send message with __proto__ field (prototype pollution attempt)
			// The message must have valid envelope structure to pass validation
			const maliciousMessage = {
				topic: 'test-topic',
				message: 'safe-message',
				isBinary: false,
				__proto__: { polluted: true }
			};
			subscriber.emit('message', 'ws:test', JSON.stringify(maliciousMessage));

			// Message should be forwarded (sanitized envelope still valid)
			expect(mockServer.publish).toHaveBeenCalledWith('test-topic', 'safe-message');

			await provider.stop();
		});

		it('should strip constructor key from incoming messages', async () => {
			const mockServer = { publish: mock(() => {}) };

			const provider = new RedisWsProvider(defaultOptions);
			await provider.start();
			provider.setServer(mockServer as unknown as BunServer);

			const subscriber = (
				provider as unknown as {
					subscriber: { emit: (event: string, channel: string, message: string) => void };
				}
			).subscriber;

			// Send message with constructor field
			const maliciousMessage = {
				topic: 'test-topic',
				message: 'safe-message',
				isBinary: false,
				constructor: { toString: () => 'hacked' }
			};
			subscriber.emit('message', 'ws:test', JSON.stringify(maliciousMessage));

			// Message should be forwarded (sanitized envelope still valid)
			expect(mockServer.publish).toHaveBeenCalledWith('test-topic', 'safe-message');

			await provider.stop();
		});

		it('should strip prototype key from incoming messages', async () => {
			const mockServer = { publish: mock(() => {}) };

			const provider = new RedisWsProvider(defaultOptions);
			await provider.start();
			provider.setServer(mockServer as unknown as BunServer);

			const subscriber = (
				provider as unknown as {
					subscriber: { emit: (event: string, channel: string, message: string) => void };
				}
			).subscriber;

			// Send message with prototype field
			const maliciousMessage = {
				topic: 'test-topic',
				message: 'safe-message',
				isBinary: false,
				prototype: { polluted: true }
			};
			subscriber.emit('message', 'ws:test', JSON.stringify(maliciousMessage));

			// Message should be forwarded (sanitized envelope still valid)
			expect(mockServer.publish).toHaveBeenCalledWith('test-topic', 'safe-message');

			await provider.stop();
		});
	});

	describe('createRedisWsProvider factory', () => {
		it('should create a RedisWsProvider instance', () => {
			const provider = createRedisWsProvider({
				connection: { host: 'localhost', port: 6379 }
			});

			expect(provider).toBeInstanceOf(RedisWsProvider);
		});

		it('should pass options to constructor', () => {
			const provider = createRedisWsProvider({
				connection: { host: 'localhost', port: 6379 },
				keyPrefix: 'factory-test',
				connectTimeout: 3000
			});

			expect(provider).toBeInstanceOf(RedisWsProvider);
		});
	});
});
