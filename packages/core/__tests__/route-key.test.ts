import { describe, test, expect } from 'bun:test';
import { createRouteKey, isRouteKey } from '../src/route-key.ts';

describe('RouteKey', () => {
	describe('createRouteKey', () => {
		test('should create a symbol with the given name', () => {
			const key = createRouteKey<string>('TestKey');

			expect(typeof key).toBe('symbol');
			expect(key.description).toBe('TestKey');
		});

		test('should create unique keys even with same name', () => {
			const key1 = createRouteKey<string>('TestKey');
			const key2 = createRouteKey<string>('TestKey');

			expect(key1).not.toBe(key2);
		});
	});

	describe('isRouteKey', () => {
		test('should return true for route keys', () => {
			const key = createRouteKey<string>('TestKey');
			expect(isRouteKey(key)).toBe(true);
		});

		test('should return true for raw symbols', () => {
			expect(isRouteKey(Symbol('test'))).toBe(true);
		});

		test('should return false for non-symbols', () => {
			expect(isRouteKey('string')).toBe(false);
			expect(isRouteKey(123)).toBe(false);
			expect(isRouteKey({})).toBe(false);
			expect(isRouteKey(null)).toBe(false);
			expect(isRouteKey(undefined)).toBe(false);
		});
	});
});
