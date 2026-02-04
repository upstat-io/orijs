/**
 * Tag Meta Key Generation Tests
 *
 * Tests for the tag-based cross-scope invalidation key generation functions.
 */

import { describe, it, expect } from 'bun:test';
import { generateTagMetaKey, isTagMetaKey } from '../src/key-generator';
import { TAG_META_KEY_PREFIX } from '../src/types';

describe('generateTagMetaKey', () => {
	describe('basic functionality', () => {
		it('should generate a tag meta key with correct prefix', () => {
			const key = generateTagMetaKey('user:abc123');

			expect(key.startsWith(TAG_META_KEY_PREFIX)).toBe(true);
			expect(key).toMatch(/^cache:tag:[a-z0-9]+$/);
		});

		it('should generate deterministic keys for same inputs', () => {
			const key1 = generateTagMetaKey('user:abc123');
			const key2 = generateTagMetaKey('user:abc123');

			expect(key1).toBe(key2);
		});

		it('should generate different keys for different tags', () => {
			const key1 = generateTagMetaKey('user:abc');
			const key2 = generateTagMetaKey('user:def');

			expect(key1).not.toBe(key2);
		});

		it('should generate different keys for different prefixes', () => {
			const key1 = generateTagMetaKey('user:abc');
			const key2 = generateTagMetaKey('team:abc');

			expect(key1).not.toBe(key2);
		});
	});

	describe('error handling', () => {
		it('should throw for empty tag', () => {
			expect(() => generateTagMetaKey('')).toThrow('Tag is required');
		});
	});

	describe('special characters', () => {
		it('should handle colons in tags', () => {
			const key = generateTagMetaKey('user:abc:extra');

			expect(key.startsWith(TAG_META_KEY_PREFIX)).toBe(true);
		});

		it('should handle UUIDs in tags', () => {
			const key = generateTagMetaKey('user:550e8400-e29b-41d4-a716-446655440000');

			expect(key.startsWith(TAG_META_KEY_PREFIX)).toBe(true);
		});

		it('should handle special characters', () => {
			const key = generateTagMetaKey('tag-with-dashes_and_underscores');

			expect(key.startsWith(TAG_META_KEY_PREFIX)).toBe(true);
		});
	});
});

describe('isTagMetaKey', () => {
	it('should return true for valid tag meta keys', () => {
		const key = generateTagMetaKey('user:abc123');

		expect(isTagMetaKey(key)).toBe(true);
	});

	it('should return true for keys with tag prefix', () => {
		expect(isTagMetaKey('cache:tag:somehash')).toBe(true);
	});

	it('should return false for cache keys', () => {
		expect(isTagMetaKey('cache:somehash')).toBe(false);
	});

	it('should return false for meta keys', () => {
		expect(isTagMetaKey('cache:meta:somehash')).toBe(false);
	});

	it('should return false for arbitrary strings', () => {
		expect(isTagMetaKey('random-string')).toBe(false);
		expect(isTagMetaKey('')).toBe(false);
		expect(isTagMetaKey('tag')).toBe(false);
	});
});
