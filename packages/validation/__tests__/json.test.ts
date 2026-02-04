/**
 * Tests for safe JSON parsing utilities.
 *
 * Verifies prototype pollution protection and correct behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Json } from '../src/json.ts';

describe('Json', () => {
	// Track prototype pollution for cleanup
	let originalPrototype: PropertyDescriptor | undefined;

	beforeEach(() => {
		originalPrototype = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');
	});

	afterEach(() => {
		// Clean up any pollution
		if ('polluted' in Object.prototype) {
			delete (Object.prototype as Record<string, unknown>)['polluted'];
		}
		if (originalPrototype) {
			Object.defineProperty(Object.prototype, 'polluted', originalPrototype);
		}
	});

	describe('parse', () => {
		describe('prototype pollution prevention', () => {
			it('should strip __proto__ key from parsed objects', () => {
				const result = Json.parse<Record<string, unknown>>(
					'{"__proto__": {"polluted": true}, "safe": "value"}'
				);

				expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
				expect(result.safe).toBe('value');
				expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
			});

			it('should strip constructor key from parsed objects', () => {
				const result = Json.parse<Record<string, unknown>>(
					'{"constructor": {"prototype": {"polluted": true}}, "safe": "value"}'
				);

				expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
				expect(result.safe).toBe('value');
			});

			it('should strip prototype key from parsed objects', () => {
				const result = Json.parse<Record<string, unknown>>(
					'{"prototype": {"polluted": true}, "safe": "value"}'
				);

				expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
				expect(result.safe).toBe('value');
			});

			it('should recursively strip dangerous keys from nested objects', () => {
				const result = Json.parse<{ nested: { data: string } }>(
					'{"nested": {"__proto__": {"polluted": true}, "data": "ok"}}'
				);

				expect(Object.prototype.hasOwnProperty.call(result.nested, '__proto__')).toBe(false);
				expect(result.nested.data).toBe('ok');
			});

			it('should sanitize arrays of objects', () => {
				const result = Json.parse<Array<Record<string, unknown>>>(
					'[{"__proto__": {"polluted": true}}, {"safe": "value"}]'
				);

				expect(Object.prototype.hasOwnProperty.call(result[0], '__proto__')).toBe(false);
				expect(result[1]!.safe).toBe('value');
			});

			it('should prevent prototype modification after sanitization', () => {
				const malicious = Json.parse<Record<string, unknown>>(
					'{"__proto__": {"polluted": true}, "data": "ok"}'
				);

				// Object.assign should NOT modify prototype
				const target: Record<string, unknown> = {};
				Object.assign(target, malicious);

				expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
				expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
				expect(target.data).toBe('ok');
			});

			it('should handle deeply nested dangerous keys', () => {
				const result = Json.parse<{ a: { b: { c: { d: string } } } }>(
					'{"a": {"b": {"__proto__": {}, "c": {"prototype": {}, "d": "deep"}}}}'
				);

				expect(result.a.b.c.d).toBe('deep');
				expect(Object.prototype.hasOwnProperty.call(result.a.b, '__proto__')).toBe(false);
				expect(Object.prototype.hasOwnProperty.call(result.a.b.c, 'prototype')).toBe(false);
			});
		});

		describe('normal JSON parsing', () => {
			it('should parse simple objects', () => {
				const result = Json.parse<{ name: string; age: number }>('{"name": "test", "age": 42}');

				expect(result.name).toBe('test');
				expect(result.age).toBe(42);
			});

			it('should parse arrays', () => {
				const result = Json.parse<number[]>('[1, 2, 3]');

				expect(result).toEqual([1, 2, 3]);
			});

			it('should parse nested objects', () => {
				const result = Json.parse<{ user: { name: string } }>('{"user": {"name": "test"}}');

				expect(result.user.name).toBe('test');
			});

			it('should handle null values', () => {
				const result = Json.parse<null>('null');

				expect(result).toBe(null);
			});

			it('should handle primitive values', () => {
				expect(Json.parse<string>('"hello"')).toBe('hello');
				expect(Json.parse<number>('42')).toBe(42);
				expect(Json.parse<boolean>('true')).toBe(true);
				expect(Json.parse<boolean>('false')).toBe(false);
			});

			it('should handle empty objects and arrays', () => {
				expect(Json.parse<Record<string, never>>('{}')).toEqual({});
				expect(Json.parse<never[]>('[]')).toEqual([]);
			});

			it('should support reviver function', () => {
				const result = Json.parse<{ date: Date }>('{"date": "2024-01-01T00:00:00.000Z"}', (key, value) => {
					if (key === 'date' && typeof value === 'string') {
						return new Date(value);
					}
					return value;
				});

				expect(result.date).toBeInstanceOf(Date);
			});

			it('should throw SyntaxError for invalid JSON', () => {
				expect(() => Json.parse('not valid json')).toThrow(SyntaxError);
			});
		});

		describe('edge cases', () => {
			it('should handle objects with only dangerous keys', () => {
				const result = Json.parse<Record<string, unknown>>(
					'{"__proto__": {}, "constructor": {}, "prototype": {}}'
				);

				expect(Object.keys(result)).toEqual([]);
			});

			it('should handle mixed safe and dangerous keys', () => {
				const result = Json.parse<Record<string, unknown>>(
					'{"safe1": 1, "__proto__": {}, "safe2": 2, "constructor": {}, "safe3": 3}'
				);

				expect(Object.keys(result).sort()).toEqual(['safe1', 'safe2', 'safe3']);
				expect(result.safe1).toBe(1);
				expect(result.safe2).toBe(2);
				expect(result.safe3).toBe(3);
			});

			it('should handle arrays with mixed object types', () => {
				const result = Json.parse<unknown[]>(
					'[1, "string", null, {"__proto__": {}, "valid": true}, [{"nested": 1}]]'
				);

				expect(result[0]).toBe(1);
				expect(result[1]).toBe('string');
				expect(result[2]).toBe(null);
				expect((result[3] as Record<string, unknown>).valid).toBe(true);
				expect(Object.prototype.hasOwnProperty.call(result[3], '__proto__')).toBe(false);
			});
		});
	});

	describe('stringify', () => {
		it('should stringify objects', () => {
			const result = Json.stringify({ name: 'test', age: 42 });

			expect(result).toBe('{"name":"test","age":42}');
		});

		it('should support replacer function', () => {
			const result = Json.stringify({ name: 'test', secret: 'hidden' }, (key, value) =>
				key === 'secret' ? undefined : value
			);

			expect(result).toBe('{"name":"test"}');
		});

		it('should support space parameter', () => {
			const result = Json.stringify({ a: 1 }, null, 2);

			expect(result).toBe('{\n  "a": 1\n}');
		});
	});

	describe('sanitize', () => {
		it('should sanitize an already-parsed object', () => {
			// Simulate receiving a pre-parsed object from external source
			const parsed = JSON.parse('{"__proto__": {"polluted": true}, "safe": "value"}');
			const result = Json.sanitize(parsed);

			expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
			expect(result.safe).toBe('value');
		});

		it('should return primitives unchanged', () => {
			expect(Json.sanitize(null)).toBe(null);
			expect(Json.sanitize(undefined)).toBe(undefined);
			expect(Json.sanitize(42)).toBe(42);
			expect(Json.sanitize('string')).toBe('string');
			expect(Json.sanitize(true)).toBe(true);
		});

		it('should sanitize nested structures', () => {
			const obj = {
				level1: {
					__proto__: { bad: true },
					level2: {
						constructor: {},
						safe: 'value'
					}
				}
			};

			const result = Json.sanitize(obj);

			expect(Object.prototype.hasOwnProperty.call(result.level1, '__proto__')).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(result.level1.level2, 'constructor')).toBe(false);
			expect(result.level1.level2.safe).toBe('value');
		});
	});

	describe('performance characteristics', () => {
		it('should handle large objects efficiently', () => {
			// Create a large object with many keys
			const largeObject: Record<string, number> = {};
			for (let i = 0; i < 10000; i++) {
				largeObject[`key${i}`] = i;
			}
			// Add a dangerous key in the middle
			(largeObject as Record<string, unknown>)['__proto__'] = { polluted: true };

			const json = JSON.stringify(largeObject);

			const start = performance.now();
			const result = Json.parse<Record<string, unknown>>(json);
			const elapsed = performance.now() - start;

			// Should complete in reasonable time (< 100ms for 10k keys)
			expect(elapsed).toBeLessThan(100);
			expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
			expect(result['key5000']).toBe(5000);
		});

		it('should handle deeply nested objects efficiently', () => {
			// Create deeply nested structure
			let nested = '{"value": 0}';
			for (let i = 0; i < 100; i++) {
				nested = `{"level${i}": ${nested}, "__proto__": {}}`;
			}

			const start = performance.now();
			const result = Json.parse<Record<string, unknown>>(nested);
			const elapsed = performance.now() - start;

			// Should complete in reasonable time (< 50ms for 100 levels)
			expect(elapsed).toBeLessThan(50);
			expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
		});
	});
});
