import { describe, it, expect, beforeEach } from 'bun:test';
import { waitForAsync } from '@orijs/test-utils';
import { InMemoryCacheProvider } from '../src/in-memory-cache-provider';

describe('InMemoryCacheProvider', () => {
	let provider: InMemoryCacheProvider;

	beforeEach(() => {
		provider = new InMemoryCacheProvider();
	});

	describe('get()', () => {
		it('should return null when key does not exist', async () => {
			const key = `nonexistent-${crypto.randomUUID()}`;
			const result = await provider.get<string>(key);

			expect(result).toBeNull();
		});

		it('should return the stored value when key exists', async () => {
			const key = `stored-${crypto.randomUUID()}`;
			await provider.set(key, 'my-value', 60);

			const result = await provider.get<string>(key);

			expect(result).toBe('my-value');
		});

		it('should return object values correctly', async () => {
			const key = `object-${crypto.randomUUID()}`;
			const objectValue = { id: 1, name: 'test', nested: { foo: 'bar' } };
			await provider.set(key, objectValue, 60);

			const result = await provider.get<typeof objectValue>(key);

			expect(result).toEqual(objectValue);
		});

		it('should return null when value has expired', async () => {
			const key = `expiring-${crypto.randomUUID()}`;
			await provider.set(key, 'will-expire', 0.05);

			await new Promise((resolve) => setTimeout(resolve, 80));

			const result = await provider.get<string>(key);

			expect(result).toBeNull();
		});

		it('should delete expired key from store when accessed', async () => {
			const key = `auto-delete-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 0.05);

			expect(provider.size).toBe(1);

			await new Promise((resolve) => setTimeout(resolve, 80));

			await provider.get(key);

			expect(provider.size).toBe(0);
		});

		it('should return value when TTL is 0 (no expiration)', async () => {
			const key = `no-expire-${crypto.randomUUID()}`;
			await provider.set(key, 'persistent', 0);

			await new Promise((resolve) => setTimeout(resolve, 20));

			const result = await provider.get<string>(key);

			expect(result).toBe('persistent');
		});
	});

	describe('set()', () => {
		it('should store a string value', async () => {
			const key = `string-${crypto.randomUUID()}`;
			await provider.set(key, 'string-value', 60);

			const result = await provider.get<string>(key);
			expect(result).toBe('string-value');
		});

		it('should store a number value', async () => {
			const key = `number-${crypto.randomUUID()}`;
			await provider.set(key, 42, 60);

			const result = await provider.get<number>(key);
			expect(result).toBe(42);
		});

		it('should store an array value', async () => {
			const key = `array-${crypto.randomUUID()}`;
			const arrayValue = [1, 2, 3, 'four', { five: 5 }];
			await provider.set(key, arrayValue, 60);

			const result = await provider.get<typeof arrayValue>(key);
			expect(result).toEqual(arrayValue);
		});

		it('should overwrite existing value', async () => {
			const key = `overwrite-${crypto.randomUUID()}`;
			await provider.set(key, 'original', 60);
			await provider.set(key, 'updated', 60);

			const result = await provider.get<string>(key);
			expect(result).toBe('updated');
		});

		it('should set TTL correctly', async () => {
			const key = `ttl-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 10);

			const ttl = await provider.ttl(key);

			expect(ttl).toBeGreaterThanOrEqual(9);
			expect(ttl).toBeLessThanOrEqual(10);
		});

		it('should set no expiration when TTL is 0', async () => {
			const key = `no-ttl-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 0);

			const ttl = await provider.ttl(key);

			expect(ttl).toBe(-1);
		});

		it('should increment store size', async () => {
			const key1 = `size1-${crypto.randomUUID()}`;
			const key2 = `size2-${crypto.randomUUID()}`;

			expect(provider.size).toBe(0);

			await provider.set(key1, 'value1', 60);
			expect(provider.size).toBe(1);

			await provider.set(key2, 'value2', 60);
			expect(provider.size).toBe(2);
		});
	});

	describe('del()', () => {
		it('should return 1 when key is deleted', async () => {
			const key = `delete-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 60);

			const result = await provider.del(key);

			expect(result).toBe(1);
		});

		it('should return 0 when key does not exist', async () => {
			const key = `nonexistent-${crypto.randomUUID()}`;
			const result = await provider.del(key);

			expect(result).toBe(0);
		});

		it('should actually remove the key from store', async () => {
			const key = `to-delete-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 60);
			expect(provider.size).toBe(1);

			await provider.del(key);

			expect(provider.size).toBe(0);
			expect(await provider.get(key)).toBeNull();
		});
	});

	describe('delMany()', () => {
		it('should return count of deleted keys', async () => {
			const key1 = `del1-${crypto.randomUUID()}`;
			const key2 = `del2-${crypto.randomUUID()}`;
			const key3 = `del3-${crypto.randomUUID()}`;

			await provider.set(key1, 'value1', 60);
			await provider.set(key2, 'value2', 60);
			await provider.set(key3, 'value3', 60);

			const result = await provider.delMany([key1, key2, key3]);

			expect(result).toBe(3);
		});

		it('should return 0 when no keys exist', async () => {
			const key1 = `nonexistent1-${crypto.randomUUID()}`;
			const key2 = `nonexistent2-${crypto.randomUUID()}`;

			const result = await provider.delMany([key1, key2]);

			expect(result).toBe(0);
		});

		it('should return partial count when some keys exist', async () => {
			const exists1 = `exists1-${crypto.randomUUID()}`;
			const exists2 = `exists2-${crypto.randomUUID()}`;
			const nonexistent = `nonexistent-${crypto.randomUUID()}`;

			await provider.set(exists1, 'value1', 60);
			await provider.set(exists2, 'value2', 60);

			const result = await provider.delMany([exists1, nonexistent, exists2]);

			expect(result).toBe(2);
		});

		it('should remove all specified keys from store', async () => {
			const remove1 = `remove1-${crypto.randomUUID()}`;
			const remove2 = `remove2-${crypto.randomUUID()}`;
			const keep = `keep-${crypto.randomUUID()}`;

			await provider.set(remove1, 'value1', 60);
			await provider.set(remove2, 'value2', 60);
			await provider.set(keep, 'value3', 60);

			await provider.delMany([remove1, remove2]);

			expect(provider.size).toBe(1);
			expect(await provider.get<string>(keep)).toBe('value3');
			expect(await provider.get(remove1)).toBeNull();
			expect(await provider.get(remove2)).toBeNull();
		});

		it('should handle empty array', async () => {
			const key = `keep-${crypto.randomUUID()}`;
			await provider.set(key, 'value1', 60);

			const result = await provider.delMany([]);

			expect(result).toBe(0);
			expect(provider.size).toBe(1);
		});
	});

	describe('exists()', () => {
		it('should return true when key exists', async () => {
			const key = `existing-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 60);

			const result = await provider.exists(key);

			expect(result).toBe(true);
		});

		it('should return false when key does not exist', async () => {
			const key = `missing-${crypto.randomUUID()}`;
			const result = await provider.exists(key);

			expect(result).toBe(false);
		});

		it('should return false when key has expired', async () => {
			const key = `expired-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 0.05);

			await new Promise((resolve) => setTimeout(resolve, 80));

			const result = await provider.exists(key);

			expect(result).toBe(false);
		});

		it('should delete expired key when checking existence', async () => {
			const key = `check-expire-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 0.05); // 50ms TTL
			expect(provider.size).toBe(1);

			// Poll until exists() returns false (key expired and deleted)
			await waitForAsync(
				async () => {
					const exists = await provider.exists(key);
					return !exists;
				},
				{ timeout: 500 }
			);

			expect(provider.size).toBe(0);
		});

		it('should return true for key with no expiration', async () => {
			const key = `no-expire-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 0);

			await new Promise((resolve) => setTimeout(resolve, 20));

			const result = await provider.exists(key);

			expect(result).toBe(true);
		});
	});

	describe('ttl()', () => {
		it('should return -2 when key does not exist', async () => {
			const key = `nonexistent-${crypto.randomUUID()}`;
			const result = await provider.ttl(key);

			expect(result).toBe(-2);
		});

		it('should return -1 when key has no expiration', async () => {
			const key = `no-expire-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 0);

			const result = await provider.ttl(key);

			expect(result).toBe(-1);
		});

		it('should return remaining seconds for key with TTL', async () => {
			const key = `with-ttl-${crypto.randomUUID()}`;
			await provider.set(key, 'value', 60);

			const result = await provider.ttl(key);

			expect(result).toBeGreaterThanOrEqual(59);
			expect(result).toBeLessThanOrEqual(60);
		});

		it('should return decreasing TTL over time', async () => {
			// Use local provider for timing-sensitive test isolation
			const localProvider = new InMemoryCacheProvider();
			const key = `decreasing-${crypto.randomUUID()}`;
			// Use 10 second TTL for reliable timing under test parallelism load
			await localProvider.set(key, 'value', 10);

			const ttl1 = await localProvider.ttl(key);
			const startTime = Date.now();

			// Wait 3 seconds - enough to reliably see a decrease even under load
			await new Promise((resolve) => setTimeout(resolve, 3100));

			const ttl2 = await localProvider.ttl(key);
			const elapsed = Date.now() - startTime;

			// TTL should have decreased by approximately the elapsed time (in seconds)
			// Allow for Math.ceil rounding by checking TTL decreased by at least 2 seconds
			// when we waited ~3 seconds (accounts for timing variance)
			expect(ttl2).toBeLessThan(ttl1);
			expect(ttl1 - ttl2).toBeGreaterThanOrEqual(Math.floor(elapsed / 1000) - 1);
		});

		it('should return -2 when key has expired', async () => {
			const key = `expire-ttl-${crypto.randomUUID()}`;
			// Use 100ms TTL and wait 200ms for reliable expiration detection
			await provider.set(key, 'value', 0.1);

			await new Promise((resolve) => setTimeout(resolve, 200));

			const result = await provider.ttl(key);

			expect(result).toBe(-2);
		});

		it('should delete expired key when checking TTL', async () => {
			const key = `ttl-expire-delete-${crypto.randomUUID()}`;
			// Use 100ms TTL and wait 200ms for reliable expiration detection
			await provider.set(key, 'value', 0.1);
			expect(provider.size).toBe(1);

			await new Promise((resolve) => setTimeout(resolve, 200));

			await provider.ttl(key);

			expect(provider.size).toBe(0);
		});
	});

	describe('clear()', () => {
		it('should remove all entries', () => {
			const key1 = `clear1-${crypto.randomUUID()}`;
			const key2 = `clear2-${crypto.randomUUID()}`;
			const key3 = `clear3-${crypto.randomUUID()}`;

			provider.set(key1, 'value1', 60);
			provider.set(key2, 'value2', 60);
			provider.set(key3, 'value3', 60);

			expect(provider.size).toBe(3);

			provider.clear();

			expect(provider.size).toBe(0);
		});

		it('should make all keys inaccessible after clear', async () => {
			const key1 = `clear-key1-${crypto.randomUUID()}`;
			const key2 = `clear-key2-${crypto.randomUUID()}`;

			await provider.set(key1, 'value1', 60);
			await provider.set(key2, 'value2', 60);

			provider.clear();

			expect(await provider.get(key1)).toBeNull();
			expect(await provider.get(key2)).toBeNull();
		});

		it('should work on empty store', () => {
			expect(provider.size).toBe(0);

			provider.clear();

			expect(provider.size).toBe(0);
		});
	});

	describe('size', () => {
		it('should return 0 for empty store', () => {
			expect(provider.size).toBe(0);
		});

		it('should return correct count after additions', async () => {
			const keyA = `a-${crypto.randomUUID()}`;
			const keyB = `b-${crypto.randomUUID()}`;
			const keyC = `c-${crypto.randomUUID()}`;

			await provider.set(keyA, 1, 60);
			expect(provider.size).toBe(1);

			await provider.set(keyB, 2, 60);
			expect(provider.size).toBe(2);

			await provider.set(keyC, 3, 60);
			expect(provider.size).toBe(3);
		});

		it('should return correct count after deletions', async () => {
			const keyX = `x-${crypto.randomUUID()}`;
			const keyY = `y-${crypto.randomUUID()}`;
			const keyZ = `z-${crypto.randomUUID()}`;

			await provider.set(keyX, 1, 60);
			await provider.set(keyY, 2, 60);
			await provider.set(keyZ, 3, 60);
			expect(provider.size).toBe(3);

			await provider.del(keyX);
			expect(provider.size).toBe(2);

			await provider.del(keyY);
			expect(provider.size).toBe(1);
		});

		it('should not change when overwriting key', async () => {
			const key = `same-key-${crypto.randomUUID()}`;

			await provider.set(key, 'value1', 60);
			expect(provider.size).toBe(1);

			await provider.set(key, 'value2', 60);
			expect(provider.size).toBe(1);
		});

		it('should include expired entries until accessed', async () => {
			// Use local provider for timing-sensitive test isolation
			const localProvider = new InMemoryCacheProvider();
			const key1 = `exp1-${crypto.randomUUID()}`;
			const key2 = `exp2-${crypto.randomUUID()}`;

			await localProvider.set(key1, 'value1', 0.05);
			await localProvider.set(key2, 'value2', 0.05);
			expect(localProvider.size).toBe(2);

			await new Promise((resolve) => setTimeout(resolve, 80));

			// Size still includes expired entries until accessed
			expect(localProvider.size).toBe(2);

			// Access one key to trigger cleanup
			await localProvider.get(key1);

			// Now only one entry remains (the other expired key not yet cleaned)
			expect(localProvider.size).toBe(1);
		});
	});

	describe('multiple operations', () => {
		it('should handle interleaved set and get operations', async () => {
			const key1 = `inter1-${crypto.randomUUID()}`;
			const key2 = `inter2-${crypto.randomUUID()}`;

			await provider.set(key1, 'a', 60);
			expect(await provider.get<string>(key1)).toBe('a');

			await provider.set(key2, 'b', 60);
			expect(await provider.get<string>(key1)).toBe('a');
			expect(await provider.get<string>(key2)).toBe('b');

			await provider.set(key1, 'c', 60);
			expect(await provider.get<string>(key1)).toBe('c');
			expect(await provider.get<string>(key2)).toBe('b');
		});

		it('should isolate different keys', async () => {
			const keyA = `isolated-a-${crypto.randomUUID()}`;
			const keyB = `isolated-b-${crypto.randomUUID()}`;

			await provider.set(keyA, 'value-a', 60);
			await provider.set(keyB, 'value-b', 60);

			await provider.del(keyA);

			expect(await provider.get(keyA)).toBeNull();
			expect(await provider.get<string>(keyB)).toBe('value-b');
		});

		it('should handle rapid successive operations', async () => {
			const prefix = crypto.randomUUID();
			const operations = [];
			for (let i = 0; i < 100; i++) {
				operations.push(provider.set(`rapid-${prefix}-${i}`, i, 60));
			}
			await Promise.all(operations);

			expect(provider.size).toBe(100);

			for (let i = 0; i < 100; i++) {
				expect(await provider.get<number>(`rapid-${prefix}-${i}`)).toBe(i);
			}
		});
	});

	describe('edge cases', () => {
		it('should handle empty string as key', async () => {
			await provider.set('', 'empty-key-value', 60);

			const result = await provider.get<string>('');

			expect(result).toBe('empty-key-value');
		});

		it('should handle null value', async () => {
			const key = `null-${crypto.randomUUID()}`;
			await provider.set(key, null, 60);

			const result = await provider.get(key);

			expect(result).toBeNull();
		});

		it('should handle undefined value', async () => {
			const key = `undefined-${crypto.randomUUID()}`;
			await provider.set(key, undefined, 60);

			const result = await provider.get(key);

			expect(result).toBeUndefined();
		});

		it('should handle very long TTL', async () => {
			const key = `long-ttl-${crypto.randomUUID()}`;
			const oneYear = 365 * 24 * 60 * 60;
			await provider.set(key, 'value', oneYear);

			const ttl = await provider.ttl(key);

			expect(ttl).toBeGreaterThan(oneYear - 10);
		});

		it('should handle very short TTL', async () => {
			const key = `short-ttl-${crypto.randomUUID()}`;
			// Set TTL to 50ms
			await provider.set(key, 'value', 0.05);

			const exists1 = await provider.exists(key);
			expect(exists1).toBe(true);

			// Wait longer than TTL to ensure expiry under parallel test load
			// Using 200ms instead of 80ms provides sufficient margin for CI
			await new Promise((resolve) => setTimeout(resolve, 200));

			const exists2 = await provider.exists(key);
			expect(exists2).toBe(false);
		});

		it('should handle special characters in keys', async () => {
			const specialKey = `key:with:colons:and/slashes/and?query=params&more=true-${crypto.randomUUID()}`;
			await provider.set(specialKey, 'special-value', 60);

			const result = await provider.get<string>(specialKey);

			expect(result).toBe('special-value');
		});
	});
});
