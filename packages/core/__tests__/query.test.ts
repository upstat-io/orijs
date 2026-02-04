import { describe, test, expect } from 'bun:test';
import { parseQuery, parseQueryString } from '../src/utils/query.ts';

describe('parseQuery', () => {
	describe('single value parameters', () => {
		test('should parse single query parameter', () => {
			const url = new URL('https://example.com?name=John');

			const result = parseQuery(url);

			expect(result).toEqual({ name: 'John' });
		});

		test('should parse multiple different parameters', () => {
			const url = new URL('https://example.com?name=John&age=30&city=NYC');

			const result = parseQuery(url);

			expect(result).toEqual({
				name: 'John',
				age: '30',
				city: 'NYC'
			});
		});

		test('should handle empty value', () => {
			const url = new URL('https://example.com?name=');

			const result = parseQuery(url);

			expect(result).toEqual({ name: '' });
		});

		test('should decode URL-encoded values', () => {
			const url = new URL('https://example.com?message=Hello%20World');

			const result = parseQuery(url);

			expect(result).toEqual({ message: 'Hello World' });
		});
	});

	describe('repeated key handling', () => {
		test('should convert repeated keys to array with two values', () => {
			const url = new URL('https://example.com?tag=red&tag=blue');

			const result = parseQuery(url);

			expect(result).toEqual({ tag: ['red', 'blue'] });
		});

		test('should handle three repeated values', () => {
			const url = new URL('https://example.com?id=1&id=2&id=3');

			const result = parseQuery(url);

			expect(result).toEqual({ id: ['1', '2', '3'] });
		});

		test('should mix single values and arrays', () => {
			const url = new URL('https://example.com?name=John&tag=red&tag=blue');

			const result = parseQuery(url);

			expect(result).toEqual({
				name: 'John',
				tag: ['red', 'blue']
			});
		});

		test('should handle multiple arrays', () => {
			const url = new URL('https://example.com?color=red&color=blue&size=S&size=M');

			const result = parseQuery(url);

			expect(result).toEqual({
				color: ['red', 'blue'],
				size: ['S', 'M']
			});
		});
	});

	describe('edge cases', () => {
		test('should return empty object for URL without query string', () => {
			const url = new URL('https://example.com');

			const result = parseQuery(url);

			expect(result).toEqual({});
		});

		test('should return empty object for URL with only question mark', () => {
			const url = new URL('https://example.com?');

			const result = parseQuery(url);

			expect(result).toEqual({});
		});

		test('should handle special characters in values', () => {
			const url = new URL('https://example.com?email=user%40example.com');

			const result = parseQuery(url);

			expect(result).toEqual({ email: 'user@example.com' });
		});

		test('should handle plus signs as spaces', () => {
			const url = new URL('https://example.com?query=hello+world');

			const result = parseQuery(url);

			expect(result).toEqual({ query: 'hello world' });
		});

		test('should handle numeric parameter names', () => {
			const url = new URL('https://example.com?0=first&1=second');

			const result = parseQuery(url);

			expect(result).toEqual({ '0': 'first', '1': 'second' });
		});

		test('should handle parameter with equals sign in value', () => {
			const url = new URL('https://example.com?formula=a%3Db');

			const result = parseQuery(url);

			expect(result).toEqual({ formula: 'a=b' });
		});
	});
});

describe('parseQueryString', () => {
	describe('single value parameters', () => {
		test('should parse single query parameter', () => {
			const result = parseQueryString('name=John');

			expect(result).toEqual({ name: 'John' });
		});

		test('should parse multiple different parameters', () => {
			const result = parseQueryString('name=John&age=30&city=NYC');

			expect(result).toEqual({
				name: 'John',
				age: '30',
				city: 'NYC'
			});
		});

		test('should handle empty value', () => {
			const result = parseQueryString('name=');

			expect(result).toEqual({ name: '' });
		});

		test('should decode URL-encoded values', () => {
			const result = parseQueryString('message=Hello%20World');

			expect(result).toEqual({ message: 'Hello World' });
		});
	});

	describe('repeated key handling', () => {
		test('should convert repeated keys to array with two values', () => {
			const result = parseQueryString('tag=red&tag=blue');

			expect(result).toEqual({ tag: ['red', 'blue'] });
		});

		test('should handle three repeated values', () => {
			const result = parseQueryString('id=1&id=2&id=3');

			expect(result).toEqual({ id: ['1', '2', '3'] });
		});

		test('should mix single values and arrays', () => {
			const result = parseQueryString('name=John&tag=red&tag=blue');

			expect(result).toEqual({
				name: 'John',
				tag: ['red', 'blue']
			});
		});
	});

	describe('edge cases', () => {
		test('should return empty object for empty string', () => {
			const result = parseQueryString('');

			expect(result).toEqual({});
		});

		test('should handle key without equals sign (value becomes empty string)', () => {
			const result = parseQueryString('flag');

			expect(result).toEqual({ flag: '' });
		});

		test('should handle multiple keys without values', () => {
			const result = parseQueryString('debug&verbose&trace');

			expect(result).toEqual({
				debug: '',
				verbose: '',
				trace: ''
			});
		});

		test('should handle mixed keys with and without values', () => {
			const result = parseQueryString('debug&name=John&verbose');

			expect(result).toEqual({
				debug: '',
				name: 'John',
				verbose: ''
			});
		});

		test('should handle special characters in values', () => {
			const result = parseQueryString('email=user%40example.com');

			expect(result).toEqual({ email: 'user@example.com' });
		});

		test('should handle parameter with equals sign in value', () => {
			const result = parseQueryString('formula=a%3Db');

			expect(result).toEqual({ formula: 'a=b' });
		});

		test('should handle multiple equals signs in value', () => {
			const result = parseQueryString('equation=a=b=c');

			expect(result).toEqual({ equation: 'a=b=c' });
		});
	});

	describe('malformed input handling', () => {
		test('should handle malformed percent encoding gracefully', () => {
			// Invalid %XX sequence - should return raw string
			const result = parseQueryString('value=%ZZ');

			expect(result).toEqual({ value: '%ZZ' });
		});

		test('should handle incomplete percent encoding', () => {
			// Incomplete %X sequence
			const result = parseQueryString('value=%2');

			expect(result).toEqual({ value: '%2' });
		});

		test('should handle percent at end of string', () => {
			const result = parseQueryString('value=test%');

			expect(result).toEqual({ value: 'test%' });
		});
	});

	describe('security', () => {
		test('should not allow prototype pollution via __proto__', () => {
			const result = parseQueryString('__proto__=polluted');

			// Result should have __proto__ as own property, not polluting Object.prototype
			expect(result['__proto__']).toBe('polluted');
			expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
			// Verify Object.prototype wasn't modified
			expect(({} as Record<string, unknown>)['__proto__']).not.toBe('polluted');
		});

		test('should not allow constructor pollution', () => {
			const result = parseQueryString('constructor=polluted');

			expect(result['constructor']).toBe('polluted');
			expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(true);
		});
	});
});
