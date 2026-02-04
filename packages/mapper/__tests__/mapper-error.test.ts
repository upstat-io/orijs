import { describe, test, expect } from 'bun:test';
import { MapperError } from '../src/mapper-error';

describe('MapperError', () => {
	describe('construction', () => {
		test('should create error with all properties', () => {
			const error = new MapperError('user', 'age', 'coercion failed', 'number', 'abc');

			expect(error.tableName).toBe('user');
			expect(error.columnName).toBe('age');
			expect(error.reason).toBe('coercion failed');
			expect(error.expectedType).toBe('number');
			expect(error.actualValue).toBe('abc');
		});

		test('should create error with minimal properties', () => {
			const error = new MapperError('user', 'email', 'missing required');

			expect(error.tableName).toBe('user');
			expect(error.columnName).toBe('email');
			expect(error.reason).toBe('missing required');
			expect(error.expectedType).toBeUndefined();
			expect(error.actualValue).toBeUndefined();
		});

		test('should be instance of Error', () => {
			const error = new MapperError('user', 'uuid', 'test error');
			expect(error).toBeInstanceOf(Error);
		});

		test('should have correct name property', () => {
			const error = new MapperError('user', 'uuid', 'test error');
			expect(error.name).toBe('MapperError');
		});
	});

	describe('message format', () => {
		test('should include table and column in message', () => {
			const error = new MapperError('user', 'display_name', 'missing required');
			expect(error.message).toContain('user');
			expect(error.message).toContain('display_name');
			expect(error.message).toContain('missing required');
		});

		test('should include expected type when provided', () => {
			const error = new MapperError('monitor', 'timeout_ms', 'coercion failed', 'number');
			expect(error.message).toContain('number');
		});

		test('should include actual value when provided', () => {
			const error = new MapperError('user', 'created_at', 'invalid date', 'date', 'not-a-date');
			expect(error.message).toContain('not-a-date');
		});

		test('should handle null actual value', () => {
			const error = new MapperError('user', 'uuid', 'null value', 'string', null);
			expect(error.message).toContain('null');
		});

		test('should handle undefined actual value', () => {
			const error = new MapperError('user', 'uuid', 'undefined value', 'string', undefined);
			// undefined in actualValue should not cause error
			expect(error.message).toBeDefined();
		});
	});

	describe('property access', () => {
		test('should allow access to tableName', () => {
			const error = new MapperError('account', 'name', 'test');
			expect(error.tableName).toBe('account');
		});

		test('should allow access to columnName', () => {
			const error = new MapperError('project', 'alias', 'test');
			expect(error.columnName).toBe('alias');
		});

		test('should allow access to reason', () => {
			const error = new MapperError('monitor', 'url', 'invalid format');
			expect(error.reason).toBe('invalid format');
		});

		test('should allow access to expectedType', () => {
			const error = new MapperError('user', 'age', 'coercion', 'number');
			expect(error.expectedType).toBe('number');
		});

		test('should allow access to actualValue', () => {
			const error = new MapperError('user', 'age', 'coercion', 'number', 'NaN');
			expect(error.actualValue).toBe('NaN');
		});
	});

	describe('error handling', () => {
		test('should be catchable as Error', () => {
			const throwError = () => {
				throw new MapperError('user', 'uuid', 'test');
			};

			expect(throwError).toThrow(Error);
		});

		test('should be catchable as MapperError', () => {
			const throwError = () => {
				throw new MapperError('user', 'uuid', 'test');
			};

			expect(throwError).toThrow(MapperError);
		});

		test('should preserve stack trace', () => {
			const error = new MapperError('user', 'uuid', 'test');
			expect(error.stack).toBeDefined();
			expect(error.stack).toContain('MapperError');
		});
	});
});
