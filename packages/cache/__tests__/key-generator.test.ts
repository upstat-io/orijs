import { describe, it, expect } from 'bun:test';
import {
	generateCacheKey,
	generateMetaKey,
	generateConfigMetaKey,
	isCacheKey,
	isMetaKey,
	cacheKeyToMetaKey,
	extractHash
} from '../src/key-generator';
import type { CacheConfig } from '../src/types';
import { CACHE_KEY_PREFIX, META_KEY_PREFIX } from '../src/types';

// ════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ════════════════════════════════════════════════════════════════════════════

interface UserParams {
	accountUuid: string;
	userUuid: string;
}

interface GlobalParams {}

/**
 * Create a test CacheConfig
 */
function createTestConfig<T extends object>(
	entity: string,
	params: readonly (keyof T)[],
	metaParams?: readonly (keyof T)[]
): CacheConfig<T> {
	return {
		entity: entity as any,
		scope: 'account',
		ttl: 3600,
		grace: 0,
		params,
		metaParams: metaParams ?? params,
		dependsOn: {},
		cacheNull: false
	};
}

// ════════════════════════════════════════════════════════════════════════════
// generateCacheKey TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('generateCacheKey', () => {
	describe('basic functionality', () => {
		it('should generate a cache key with correct prefix', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
			const key = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });

			expect(key.startsWith(CACHE_KEY_PREFIX)).toBe(true);
			expect(key).toMatch(/^cache:[a-z0-9]+$/);
		});

		it('should generate deterministic keys for same inputs', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
			const key1 = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });
			const key2 = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });

			expect(key1).toBe(key2);
		});

		it('should generate different keys for different params', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
			const key1 = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });
			const key2 = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'ghi' });

			expect(key1).not.toBe(key2);
		});

		it('should generate different keys for different entity types', () => {
			const userConfig = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
			const teamConfig = createTestConfig<UserParams>('Team', ['accountUuid', 'userUuid']);

			const key1 = generateCacheKey(userConfig, { accountUuid: 'abc', userUuid: 'def' });
			const key2 = generateCacheKey(teamConfig, { accountUuid: 'abc', userUuid: 'def' });

			expect(key1).not.toBe(key2);
		});
	});

	describe('parameter extraction', () => {
		it('should only use params specified in config', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid']);
			const key1 = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });
			const key2 = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'xyz' });

			// Keys should be same because userUuid is not in config.params
			expect(key1).toBe(key2);
		});

		it('should use all params when all are specified in config', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
			const key1 = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });
			const key2 = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'xyz' });

			expect(key1).not.toBe(key2);
		});
	});

	describe('parameter ordering', () => {
		it('should generate same key regardless of parameter order in input', () => {
			const config: CacheConfig<{ a: number; b: number; c: number }> = {
				entity: 'Test' as any,
				scope: 'global',
				ttl: 3600,
				grace: 0,
				params: ['a', 'b', 'c'],
				metaParams: ['a', 'b', 'c'],
				dependsOn: {},
				cacheNull: false
			};

			const key1 = generateCacheKey(config, { a: 1, b: 2, c: 3 });
			const key2 = generateCacheKey(config, { c: 3, a: 1, b: 2 });
			const key3 = generateCacheKey(config, { b: 2, c: 3, a: 1 });

			expect(key1).toBe(key2);
			expect(key2).toBe(key3);
		});
	});

	describe('missing required params validation', () => {
		it('should throw when a declared param is undefined', () => {
			const config: CacheConfig<{ a: number; b: number }> = {
				entity: 'Test' as any,
				scope: 'global',
				ttl: 3600,
				grace: 0,
				params: ['a', 'b'],
				metaParams: ['a', 'b'],
				dependsOn: {},
				cacheNull: false
			};

			expect(() => generateCacheKey(config, { a: 1, b: undefined } as any)).toThrow(
				"Missing required cache params for 'Test': b"
			);
		});

		it('should throw when multiple declared params are undefined', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);

			expect(() => generateCacheKey(config, { accountUuid: undefined, userUuid: undefined } as any)).toThrow(
				"Missing required cache params for 'User': accountUuid, userUuid"
			);
		});

		it('should include helpful message about cache isolation', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);

			expect(() => generateCacheKey(config, { accountUuid: 'abc', userUuid: undefined } as any)).toThrow(
				'to ensure cache isolation'
			);
		});

		it('should not throw when all declared params are provided', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);

			expect(() => generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' })).not.toThrow();
		});

		it('should allow extra params not in config.params', () => {
			// Only params in config.params are validated
			const config = createTestConfig<UserParams>('User', ['accountUuid']);

			// userUuid is not in config.params, so it being undefined is fine
			const key = generateCacheKey(config, { accountUuid: 'abc', userUuid: undefined } as any);
			expect(key).toMatch(/^cache:[a-z0-9]+$/);
		});
	});

	describe('error cases', () => {
		it('should throw for null config', () => {
			expect(() => generateCacheKey(null as any, { accountUuid: 'abc', userUuid: 'def' })).toThrow(
				'CacheConfig is required'
			);
		});

		it('should throw for config without entity', () => {
			const config = { ...createTestConfig<UserParams>('User', ['accountUuid']), entity: '' };
			expect(() => generateCacheKey(config as any, { accountUuid: 'abc', userUuid: 'def' })).toThrow(
				'CacheConfig.entity is required'
			);
		});

		it('should throw for null params', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
			expect(() => generateCacheKey(config, null as any)).toThrow('Params must be an object');
		});

		it('should throw for undefined params', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
			expect(() => generateCacheKey(config, undefined as any)).toThrow('Params must be an object');
		});
	});

	describe('empty params', () => {
		it('should handle config with empty params array', () => {
			const config = createTestConfig<GlobalParams>('BillingPlan', []);
			const key = generateCacheKey(config, {});

			expect(key).toMatch(/^cache:[a-z0-9]+$/);
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// generateMetaKey TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('generateMetaKey', () => {
	describe('basic functionality', () => {
		it('should generate a meta key with correct prefix', () => {
			const key = generateMetaKey('User', { accountUuid: 'abc' });

			expect(key.startsWith(META_KEY_PREFIX)).toBe(true);
			expect(key).toMatch(/^cache:meta:[a-z0-9]+$/);
		});

		it('should generate deterministic keys for same inputs', () => {
			const key1 = generateMetaKey('User', { accountUuid: 'abc' });
			const key2 = generateMetaKey('User', { accountUuid: 'abc' });

			expect(key1).toBe(key2);
		});

		it('should generate different keys for different entity types', () => {
			const key1 = generateMetaKey('User', { accountUuid: 'abc' });
			const key2 = generateMetaKey('Team', { accountUuid: 'abc' });

			expect(key1).not.toBe(key2);
		});

		it('should generate different keys for different accountUuid', () => {
			const key1 = generateMetaKey('User', { accountUuid: 'abc' });
			const key2 = generateMetaKey('User', { accountUuid: 'def' });

			expect(key1).not.toBe(key2);
		});

		it('should generate different keys for different projectUuid', () => {
			const key1 = generateMetaKey('Monitor', { accountUuid: 'abc', projectUuid: 'proj1' });
			const key2 = generateMetaKey('Monitor', { accountUuid: 'abc', projectUuid: 'proj2' });

			expect(key1).not.toBe(key2);
		});
	});

	describe('scope combinations', () => {
		it('should handle account-level meta key (no projectUuid)', () => {
			const key = generateMetaKey('User', { accountUuid: 'abc' });

			expect(key).toMatch(/^cache:meta:[a-z0-9]+$/);
		});

		it('should handle project-level meta key (with projectUuid)', () => {
			const key = generateMetaKey('Monitor', { accountUuid: 'abc', projectUuid: 'xyz' });

			expect(key).toMatch(/^cache:meta:[a-z0-9]+$/);
		});

		it('should handle global meta key (no accountUuid or projectUuid)', () => {
			const key = generateMetaKey('BillingPlan', {});

			expect(key).toMatch(/^cache:meta:[a-z0-9]+$/);
		});
	});

	describe('undefined handling', () => {
		it('should ignore undefined accountUuid', () => {
			const key1 = generateMetaKey('Global', { accountUuid: undefined });
			const key2 = generateMetaKey('Global', {});

			expect(key1).toBe(key2);
		});

		it('should ignore undefined projectUuid', () => {
			const key1 = generateMetaKey('User', { accountUuid: 'abc', projectUuid: undefined });
			const key2 = generateMetaKey('User', { accountUuid: 'abc' });

			expect(key1).toBe(key2);
		});
	});

	describe('error cases', () => {
		it('should throw for empty entity type', () => {
			expect(() => generateMetaKey('' as any, { accountUuid: 'abc' })).toThrow('Entity type is required');
		});

		it('should throw for null params', () => {
			expect(() => generateMetaKey('User', null as any)).toThrow('Params must be an object');
		});

		it('should throw for undefined params', () => {
			expect(() => generateMetaKey('User', undefined as any)).toThrow('Params must be an object');
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// isCacheKey TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('isCacheKey', () => {
	it('should return true for valid cache keys', () => {
		const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
		const key = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });

		expect(isCacheKey(key)).toBe(true);
	});

	it('should return false for meta keys', () => {
		const key = generateMetaKey('User', { accountUuid: 'abc' });

		expect(isCacheKey(key)).toBe(false);
	});

	it('should return false for arbitrary strings', () => {
		expect(isCacheKey('random-string')).toBe(false);
		expect(isCacheKey('')).toBe(false);
		expect(isCacheKey('cache')).toBe(false);
	});

	it('should return false for strings starting with cache: but also cache:meta:', () => {
		// cache:meta: starts with cache: but should not be a cache key
		expect(isCacheKey('cache:meta:abc123')).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// isMetaKey TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('isMetaKey', () => {
	it('should return true for valid meta keys', () => {
		const key = generateMetaKey('User', { accountUuid: 'abc' });

		expect(isMetaKey(key)).toBe(true);
	});

	it('should return false for cache keys', () => {
		const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
		const key = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });

		expect(isMetaKey(key)).toBe(false);
	});

	it('should return false for arbitrary strings', () => {
		expect(isMetaKey('random-string')).toBe(false);
		expect(isMetaKey('')).toBe(false);
		expect(isMetaKey('meta')).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// cacheKeyToMetaKey TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('cacheKeyToMetaKey', () => {
	it('should convert cache key to meta key', () => {
		const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
		const cacheKey = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });
		const metaKey = cacheKeyToMetaKey(cacheKey);

		expect(metaKey.startsWith(META_KEY_PREFIX)).toBe(true);
		expect(isMetaKey(metaKey)).toBe(true);
	});

	it('should preserve the hash portion', () => {
		const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
		const cacheKey = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });
		const metaKey = cacheKeyToMetaKey(cacheKey);

		const cacheHash = cacheKey.substring(CACHE_KEY_PREFIX.length);
		const metaHash = metaKey.substring(META_KEY_PREFIX.length);

		expect(metaHash).toBe(cacheHash);
	});

	it('should throw for non-cache keys', () => {
		const metaKey = generateMetaKey('User', { accountUuid: 'abc' });

		expect(() => cacheKeyToMetaKey(metaKey)).toThrow('Not a cache key');
		expect(() => cacheKeyToMetaKey('random-string')).toThrow('Not a cache key');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// extractHash TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('extractHash', () => {
	it('should extract hash from cache key', () => {
		const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
		const cacheKey = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });
		const hash = extractHash(cacheKey);

		expect(hash).toBe(cacheKey.substring(CACHE_KEY_PREFIX.length));
		expect(hash).toMatch(/^[a-z0-9]+$/);
	});

	it('should extract hash from meta key', () => {
		const metaKey = generateMetaKey('User', { accountUuid: 'abc' });
		const hash = extractHash(metaKey);

		expect(hash).toBe(metaKey.substring(META_KEY_PREFIX.length));
		expect(hash).toMatch(/^[a-z0-9]+$/);
	});

	it('should throw for invalid key format', () => {
		expect(() => extractHash('random-string')).toThrow('Invalid key format');
		expect(() => extractHash('')).toThrow('Invalid key format');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// NestJS COMPATIBILITY TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('NestJS compatibility', () => {
	describe('key format', () => {
		it('should generate cache keys in format cache:{hash}', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid']);
			const key = generateCacheKey(config, { accountUuid: 'abc', userUuid: 'def' });

			// Format: cache:{base36_hash}
			expect(key).toMatch(/^cache:[a-z0-9]+$/);
			// No pipe separators (old format was cache|scope|hash)
			expect(key).not.toContain('|');
		});

		it('should generate meta keys in format cache:meta:{hash}', () => {
			const key = generateMetaKey('User', { accountUuid: 'abc' });

			// Format: cache:meta:{base36_hash}
			expect(key).toMatch(/^cache:meta:[a-z0-9]+$/);
			// No pipe separators
			expect(key).not.toContain('|');
		});
	});

	describe('hash consistency', () => {
		it('should use fast-json-stable-stringify for deterministic hashing', () => {
			// Different property order should produce same hash
			const config: CacheConfig<{ x: number; y: number; z: number }> = {
				entity: 'Test' as any,
				scope: 'global',
				ttl: 3600,
				grace: 0,
				params: ['x', 'y', 'z'],
				metaParams: ['x', 'y', 'z'],
				dependsOn: {},
				cacheNull: false
			};

			const key1 = generateCacheKey(config, { x: 1, y: 2, z: 3 });
			const key2 = generateCacheKey(config, { z: 3, y: 2, x: 1 });

			expect(key1).toBe(key2);
		});
	});

	describe('meta key material', () => {
		it('should only include entity, accountUuid, projectUuid in meta key material', () => {
			// Meta keys are scoped by entity + tenant identifiers only
			// This matches NestJS behavior where meta keys are for dependency tracking

			const key1 = generateMetaKey('Monitor', { accountUuid: 'abc', projectUuid: 'xyz' });
			const key2 = generateMetaKey('Monitor', { accountUuid: 'abc', projectUuid: 'xyz' });

			expect(key1).toBe(key2);
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SPECIAL CHARACTERS TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('special characters in params', () => {
	it('should handle URLs in params', () => {
		const config: CacheConfig<{ url: string }> = {
			entity: 'Test' as any,
			scope: 'global',
			ttl: 3600,
			grace: 0,
			params: ['url'],
			metaParams: ['url'],
			dependsOn: {},
			cacheNull: false
		};

		const key1 = generateCacheKey(config, { url: 'https://example.com?foo=bar&baz=1' });
		const key2 = generateCacheKey(config, { url: 'https://example.com?foo=bar&baz=1' });

		expect(key1).toBe(key2);
	});

	it('should handle unicode characters', () => {
		const config: CacheConfig<{ name: string }> = {
			entity: 'Test' as any,
			scope: 'global',
			ttl: 3600,
			grace: 0,
			params: ['name'],
			metaParams: ['name'],
			dependsOn: {},
			cacheNull: false
		};

		const key1 = generateCacheKey(config, { name: 'Müller' });
		const key2 = generateCacheKey(config, { name: 'Müller' });

		expect(key1).toBe(key2);
	});

	it('should handle quotes and special chars', () => {
		const config: CacheConfig<{ text: string }> = {
			entity: 'Test' as any,
			scope: 'global',
			ttl: 3600,
			grace: 0,
			params: ['text'],
			metaParams: ['text'],
			dependsOn: {},
			cacheNull: false
		};

		const key1 = generateCacheKey(config, { text: 'Hello \'world\' "test"' });
		const key2 = generateCacheKey(config, { text: 'Hello \'world\' "test"' });

		expect(key1).toBe(key2);
	});

	it('should handle newlines and tabs', () => {
		const config: CacheConfig<{ content: string }> = {
			entity: 'Test' as any,
			scope: 'global',
			ttl: 3600,
			grace: 0,
			params: ['content'],
			metaParams: ['content'],
			dependsOn: {},
			cacheNull: false
		};

		const key1 = generateCacheKey(config, { content: 'line1\nline2\ttab' });
		const key2 = generateCacheKey(config, { content: 'line1\nline2\ttab' });

		expect(key1).toBe(key2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// NULL VALUES TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('null values in params', () => {
	it('should handle null values in params', () => {
		const config: CacheConfig<{ a: number; b: null }> = {
			entity: 'Test' as any,
			scope: 'global',
			ttl: 3600,
			grace: 0,
			params: ['a', 'b'],
			metaParams: ['a', 'b'],
			dependsOn: {},
			cacheNull: false
		};

		const key1 = generateCacheKey(config, { a: 1, b: null });
		const key2 = generateCacheKey(config, { a: 1, b: null });

		expect(key1).toBe(key2);
	});

	it('should throw for undefined (null is valid, undefined is missing)', () => {
		const config: CacheConfig<{ a: number; b?: number | null }> = {
			entity: 'Test' as any,
			scope: 'global',
			ttl: 3600,
			grace: 0,
			params: ['a', 'b'],
			metaParams: ['a', 'b'],
			dependsOn: {},
			cacheNull: false
		};

		// null is a valid value (represents explicit "no value")
		expect(() => generateCacheKey(config, { a: 1, b: null })).not.toThrow();

		// undefined means param is missing - should throw
		expect(() => generateCacheKey(config, { a: 1, b: undefined } as any)).toThrow(
			"Missing required cache params for 'Test': b"
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// HASH COLLISION RESISTANCE TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('hash collision resistance', () => {
	it('should generate unique keys for similar but different inputs', () => {
		const keys = new Set<string>();

		const testCases: Array<{ entity: string; params: Record<string, unknown> }> = [
			{ entity: 'Test', params: { a: '1' } },
			{ entity: 'Test', params: { a: '2' } },
			{ entity: 'Test', params: { a: '11' } },
			{ entity: 'Test', params: { a: '12' } },
			{ entity: 'Test', params: { b: '1' } },
			{ entity: 'Test1', params: { a: '1' } },
			{ entity: 'Test', params: { aa: '1' } },
			{ entity: 'Tes', params: { ta: '1' } }
		];

		for (const tc of testCases) {
			const config: CacheConfig<Record<string, unknown>> = {
				entity: tc.entity as any,
				scope: 'global',
				ttl: 3600,
				grace: 0,
				params: Object.keys(tc.params) as any,
				metaParams: Object.keys(tc.params) as any,
				dependsOn: {},
				cacheNull: false
			};

			const key = generateCacheKey(config, tc.params);
			expect(keys.has(key)).toBe(false);
			keys.add(key);
		}

		expect(keys.size).toBe(testCases.length);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// generateConfigMetaKey TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('generateConfigMetaKey', () => {
	describe('basic functionality', () => {
		it('should generate meta key using config metaParams', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid'], ['accountUuid']);
			const key = generateConfigMetaKey(config, { accountUuid: 'abc', userUuid: 'def' });

			expect(key.startsWith(META_KEY_PREFIX)).toBe(true);
		});

		it('should only include metaParams in the key', () => {
			// config.params includes userUuid, but metaParams only includes accountUuid
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid'], ['accountUuid']);

			// Different userUuid should produce same meta key
			const key1 = generateConfigMetaKey(config, { accountUuid: 'abc', userUuid: 'def' });
			const key2 = generateConfigMetaKey(config, { accountUuid: 'abc', userUuid: 'xyz' });

			expect(key1).toBe(key2);
		});
	});

	describe('missing required metaParams validation', () => {
		it('should throw when a declared metaParam is undefined', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid'], ['accountUuid']);

			expect(() => generateConfigMetaKey(config, { accountUuid: undefined, userUuid: 'def' } as any)).toThrow(
				"Missing required meta params for 'User': accountUuid"
			);
		});

		it('should include helpful message about cascade invalidation', () => {
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid'], ['accountUuid']);

			expect(() => generateConfigMetaKey(config, { accountUuid: undefined, userUuid: 'def' } as any)).toThrow(
				'for cascade invalidation'
			);
		});

		it('should not throw when params not in metaParams are undefined', () => {
			// userUuid is in params but not in metaParams
			const config = createTestConfig<UserParams>('User', ['accountUuid', 'userUuid'], ['accountUuid']);

			// userUuid undefined should be fine since it's not in metaParams
			expect(() =>
				generateConfigMetaKey(config, { accountUuid: 'abc', userUuid: undefined } as any)
			).not.toThrow();
		});
	});
});
