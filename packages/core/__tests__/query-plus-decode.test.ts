import { describe, test, expect } from 'bun:test';
import { parseQueryString } from '../src/utils/query';

describe('parseQueryString + decode', () => {
	test('should decode + as space in key=value pairs', () => {
		const result = parseQueryString('name=hello+world');
		expect(result.name).toBe('hello world');
	});

	test('should decode + as space in key-only params', () => {
		const result = parseQueryString('hello+world');
		expect(result['hello world']).toBe('');
	});

	test('should decode + in both key and value', () => {
		const result = parseQueryString('first+name=hello+world');
		expect(result['first name']).toBe('hello world');
	});

	test('should decode %20 as space (standard encoding)', () => {
		const result = parseQueryString('name=hello%20world');
		expect(result.name).toBe('hello world');
	});

	test('should decode both + and %20 in same query string', () => {
		const result = parseQueryString('a=hello+world&b=foo%20bar');
		expect(result.a).toBe('hello world');
		expect(result.b).toBe('foo bar');
	});

	test('should handle multiple + signs', () => {
		const result = parseQueryString('q=one+two+three');
		expect(result.q).toBe('one two three');
	});
});
