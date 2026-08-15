import { describe, expect, test } from 'bun:test';
import { RedisDatabaseLease } from '../src/core/redis-database-lease';
import { RedisContainerManager } from '../src/core/redis-container-manager';

class FakeLeaseClient {
	readonly values = new Map<string, string>();

	async set(key: string, value: string, mode: 'NX'): Promise<'OK' | null> {
		expect(mode).toBe('NX');
		if (this.values.has(key)) return null;
		this.values.set(key, value);
		return 'OK';
	}

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async eval(_script: string, _keys: number, key: string, token: string, replacement?: string): Promise<number> {
		if (this.values.get(key) !== token) return 0;
		if (replacement) this.values.set(key, replacement);
		else this.values.delete(key);
		return 1;
	}
}

describe('RedisDatabaseLease', () => {
	test('allocates distinct databases to concurrent owners and releases only its own lease', async () => {
		const client = new FakeLeaseClient();
		const first = new RedisDatabaseLease(client, 'first-owner', 3);
		const second = new RedisDatabaseLease(client, 'second-owner', 3);

		const [firstDatabase, secondDatabase] = await Promise.all([first.acquire(), second.acquire()]);

		expect(firstDatabase).not.toBe(secondDatabase);
		expect([firstDatabase, secondDatabase].sort()).toEqual([1, 2]);

		await first.release();
		const third = new RedisDatabaseLease(client, 'third-owner', 3);
		expect(await third.acquire()).toBe(firstDatabase);
	});

	test('fails closed when every isolated database is owned', async () => {
		const client = new FakeLeaseClient();
		await new RedisDatabaseLease(client, 'first-owner', 1).acquire();

		await expect(new RedisDatabaseLease(client, 'second-owner', 1).acquire()).rejects.toThrow(
			'No isolated Redis test database is available'
		);
	});

	test('atomically reclaims a database whose owning process is gone', async () => {
		const client = new FakeLeaseClient();
		client.values.set(
			'__orijs_test_database_lease__:1',
			JSON.stringify({ owner: 'crashed', pid: 12345, identity: '12345:old-start', nonce: 'old' })
		);
		const replacement = new RedisDatabaseLease(client, 'replacement', 1, () => false);

		expect(await replacement.acquire()).toBe(1);
		expect(client.values.get('__orijs_test_database_lease__:1')).toContain('replacement');
	});

	test('reclaims a stale lease when its PID was reused by a different process', async () => {
		const client = new FakeLeaseClient();
		client.values.set(
			'__orijs_test_database_lease__:1',
			JSON.stringify({ owner: 'crashed', pid: process.pid, identity: `${process.pid}:old-start`, nonce: 'old' })
		);
		const replacement = new RedisDatabaseLease(
			client,
			'replacement-after-pid-reuse',
			1,
			(_pid, identity) => identity !== `${process.pid}:old-start`
		);

		expect(await replacement.acquire()).toBe(1);
	});

	test('reclaims a legacy lease when its owning PID no longer exists', async () => {
		const client = new FakeLeaseClient();
		client.values.set(
			'__orijs_test_database_lease__:1',
			JSON.stringify({ owner: 'legacy-crash', pid: 987654321, nonce: 'old' })
		);
		const replacement = new RedisDatabaseLease(client, 'replacement-after-legacy-crash', 1);

		expect(await replacement.acquire()).toBe(1);
	});
});

describe('RedisContainerManager database ownership', () => {
	test('flushes only the leased database and never the shared Redis instance', async () => {
		let flushDatabaseCalls = 0;
		const manager = new RedisContainerManager('isolated-owner');
		Reflect.set(manager, 'redisClient', {
			status: 'ready',
			async flushdb() {
				flushDatabaseCalls += 1;
			}
		});

		await manager.flushAll();

		expect(flushDatabaseCalls).toBe(1);
	});
});
