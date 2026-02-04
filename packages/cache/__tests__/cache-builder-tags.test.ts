/**
 * Cache Builder Tags Tests
 *
 * Tests for the .tags() method on the cache builder.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EntityRegistry, createCacheBuilder, cacheRegistry } from '../src';

// Test setup
function createTestRegistry() {
	return EntityRegistry.create()
		.scope('global')
		.scope('account', 'accountUuid')
		.scope('project', 'projectUuid')
		.entity('Account', 'account')
		.entity('User', 'account', 'userUuid')
		.entity('UserAuth', 'global', 'fbAuthUid')
		.entity('Monitor', 'project', 'monitorUuid')
		.build();
}

describe('CacheBuilder tags()', () => {
	beforeEach(() => {
		cacheRegistry.reset();
	});

	describe('basic functionality', () => {
		it('should add tags function to config', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.build();

			expect(config.tags).toBeDefined();
			expect(typeof config.tags).toBe('function');
		});

		it('should generate correct tag values', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.build();

			const tags = config.tags!({ fbAuthUid: 'test-uid' });

			expect(tags).toEqual(['user:test-uid']);
		});

		it('should support multiple tags', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ accountUuid: string; userUuid: string }>('User')
				.ttl('1h')
				.tags((params) => [`user:${params.userUuid}`, `account:${params.accountUuid}`])
				.build();

			const tags = config.tags!({ accountUuid: 'acc-123', userUuid: 'usr-456' });

			expect(tags).toEqual(['user:usr-456', 'account:acc-123']);
		});

		it('should allow tags to be optional (undefined by default)', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('User').ttl('1h').build();

			expect(config.tags).toBeUndefined();
		});
	});

	describe('chaining', () => {
		it('should be chainable with other builder methods', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.grace('5m')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.cacheNull()
				.build();

			expect(config.ttl).toBe(3600);
			expect(config.grace).toBe(300);
			expect(config.tags).toBeDefined();
			expect(config.cacheNull).toBe(true);
		});

		it('should work when called before other methods', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.grace('5m')
				.build();

			expect(config.tags).toBeDefined();
			expect(config.grace).toBe(300);
		});
	});

	describe('tag generation patterns', () => {
		it('should handle UUID-based tags', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for<{ fbAuthUid: string }>('UserAuth')
				.ttl('1h')
				.tags((params) => [`user:${params.fbAuthUid}`])
				.build();

			const uuid = '550e8400-e29b-41d4-a716-446655440000';
			const tags = config.tags!({ fbAuthUid: uuid });

			expect(tags).toEqual([`user:${uuid}`]);
		});

		it('should handle empty tags array', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			const config = Cache.for('User')
				.ttl('1h')
				.tags(() => [])
				.build();

			const tags = config.tags!({ accountUuid: 'acc', userUuid: 'usr' });

			expect(tags).toEqual([]);
		});

		it('should handle dynamic tag generation based on params', () => {
			const registry = createTestRegistry();
			const Cache = createCacheBuilder(registry);

			interface CustomParams {
				accountUuid: string;
				userUuid: string;
				isAdmin?: boolean;
			}

			const config = Cache.for<CustomParams>('User')
				.ttl('1h')
				.tags((params) => {
					const tags = [`user:${params.userUuid}`];
					if (params.isAdmin) {
						tags.push('admin');
					}
					return tags;
				})
				.build();

			const regularTags = config.tags!({ accountUuid: 'acc', userUuid: 'usr', isAdmin: false });
			const adminTags = config.tags!({ accountUuid: 'acc', userUuid: 'usr', isAdmin: true });

			expect(regularTags).toEqual(['user:usr']);
			expect(adminTags).toEqual(['user:usr', 'admin']);
		});
	});
});
