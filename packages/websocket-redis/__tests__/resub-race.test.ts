/**
 * Tests for Redis subscribe/unsubscribe race conditions.
 *
 * Verifies that rapid subscribe→unsubscribe→subscribe sequences
 * produce correct results via the pendingResubscribe mechanism.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { createRedisTestHelper, delay, type RedisTestHelper } from '@orijs/test-utils';
import { RedisWsProvider } from '../src/redis-websocket-provider';
import type { BunServer } from '@orijs/websocket';

const SOCKET_1 = '550e8400-e29b-41d4-a716-446655440001';
const SOCKET_2 = '550e8400-e29b-41d4-a716-446655440002';

function createMockServer(): BunServer & { publishedMessages: Array<{ topic: string; message: unknown }> } {
	const publishedMessages: Array<{ topic: string; message: unknown }> = [];
	return {
		publishedMessages,
		publish(topic: string, message: unknown): void {
			publishedMessages.push({ topic, message });
		}
	} as BunServer & { publishedMessages: Array<{ topic: string; message: unknown }> };
}

describe('RedisWsProvider resub race conditions', () => {
	let redisHelper: RedisTestHelper;
	let allProviders: RedisWsProvider[] = [];

	function createTrackedProvider(): RedisWsProvider {
		const config = redisHelper.getConnectionConfig();
		const provider = new RedisWsProvider({
			connection: { host: config.host, port: config.port }
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
	});

	afterEach(async () => {
		for (const p of allProviders) {
			try {
				await p.stop();
			} catch {
				// Ignore
			}
		}
		allProviders = [];
	});

	it('should handle subscribe after unsubscribe via resubscribe mechanism', async () => {
		const provider = createTrackedProvider();
		const mockServer = createMockServer();
		provider.setServer(mockServer);
		await provider.start();

		// Subscribe socket 1 to topic — triggers Redis SUBSCRIBE
		provider.subscribe(SOCKET_1, 'room:race');

		// Wait for Redis subscription to establish
		await delay(100);
		expect(provider.getTopicSubscriberCount('room:race')).toBe(1);

		// Unsubscribe socket 1 — triggers Redis UNSUBSCRIBE (in-flight)
		provider.unsubscribe(SOCKET_1, 'room:race');
		expect(provider.getTopicSubscriberCount('room:race')).toBe(0);

		// Immediately subscribe socket 2 to same topic — should mark for resubscribe
		provider.subscribe(SOCKET_2, 'room:race');
		expect(provider.getTopicSubscriberCount('room:race')).toBe(1);

		// Wait for the unsubscribe→resubscribe cycle to complete
		await delay(300);

		// Verify the subscription is active by checking subscriber count
		expect(provider.getTopicSubscriberCount('room:race')).toBe(1);
		expect(provider.isConnected(SOCKET_2)).toBe(true);
	});

	it('should not orphan Redis subscription when all local subscribers leave during subscribe', async () => {
		const provider = createTrackedProvider();
		const mockServer = createMockServer();
		provider.setServer(mockServer);
		await provider.start();

		// Subscribe socket 1 — triggers Redis SUBSCRIBE
		provider.subscribe(SOCKET_1, 'room:orphan');
		// Immediately unsubscribe before Redis SUBSCRIBE completes
		provider.unsubscribe(SOCKET_1, 'room:orphan');

		expect(provider.getTopicSubscriberCount('room:orphan')).toBe(0);

		// Wait for Redis operations to settle
		await delay(300);

		// No local subscribers remain — subscription should have been cleaned up
		expect(provider.getTopicSubscriberCount('room:orphan')).toBe(0);
	});

	it('should maintain correct state after rapid subscribe-unsubscribe-subscribe cycles', async () => {
		const provider = createTrackedProvider();
		const mockServer = createMockServer();
		provider.setServer(mockServer);
		await provider.start();

		// Rapid cycle: subscribe → unsubscribe → subscribe → unsubscribe → subscribe
		provider.subscribe(SOCKET_1, 'room:rapid');
		provider.unsubscribe(SOCKET_1, 'room:rapid');
		provider.subscribe(SOCKET_2, 'room:rapid');
		provider.unsubscribe(SOCKET_2, 'room:rapid');
		provider.subscribe(SOCKET_1, 'room:rapid');

		// Wait for all Redis operations to settle
		await delay(500);

		// Final state: socket 1 subscribed
		expect(provider.getTopicSubscriberCount('room:rapid')).toBe(1);
		expect(provider.isConnected(SOCKET_1)).toBe(true);
	});
});
