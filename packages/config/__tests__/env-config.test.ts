import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { EnvConfigProvider } from '../src/env-config.ts';

describe('EnvConfigProvider', () => {
	beforeAll(() => {
		Bun.env.TEST_CONFIG_KEY = 'test-value';
		Bun.env.TEST_EMPTY_KEY = '';
	});

	afterAll(() => {
		delete Bun.env.TEST_CONFIG_KEY;
		delete Bun.env.TEST_EMPTY_KEY;
	});

	describe('get', () => {
		test('should return value when key exists', async () => {
			const provider = new EnvConfigProvider();
			const value = await provider.get('TEST_CONFIG_KEY');
			expect(value).toBe('test-value');
		});

		test('should return undefined when key does not exist', async () => {
			const provider = new EnvConfigProvider();
			const value = await provider.get('NON_EXISTENT_KEY_12345');
			expect(value).toBeUndefined();
		});

		test('should return empty string when key is empty', async () => {
			const provider = new EnvConfigProvider();
			const value = await provider.get('TEST_EMPTY_KEY');
			expect(value).toBe('');
		});
	});

	describe('getRequired', () => {
		test('should return value when key exists and is non-empty', async () => {
			const provider = new EnvConfigProvider();
			const value = await provider.getRequired('TEST_CONFIG_KEY');
			expect(value).toBe('test-value');
		});

		test('should throw when key does not exist', async () => {
			const provider = new EnvConfigProvider();
			await expect(provider.getRequired('NON_EXISTENT_KEY_12345')).rejects.toThrow(
				"Required config 'NON_EXISTENT_KEY_12345' is not set"
			);
		});

		test('should throw when key is empty string', async () => {
			const provider = new EnvConfigProvider();
			await expect(provider.getRequired('TEST_EMPTY_KEY')).rejects.toThrow(
				"Required config 'TEST_EMPTY_KEY' is not set"
			);
		});

		test('should include helpful message in error', async () => {
			const provider = new EnvConfigProvider();
			await expect(provider.getRequired('MISSING_KEY')).rejects.toThrow(
				'Add it to your .env file or environment'
			);
		});
	});

	describe('loadKeys', () => {
		test('should return values for all requested keys', async () => {
			const provider = new EnvConfigProvider();
			const result = await provider.loadKeys(['TEST_CONFIG_KEY', 'TEST_EMPTY_KEY']);

			expect(result).toEqual({
				TEST_CONFIG_KEY: 'test-value',
				TEST_EMPTY_KEY: ''
			});
		});

		test('should return undefined for non-existent keys', async () => {
			const provider = new EnvConfigProvider();
			const result = await provider.loadKeys(['NON_EXISTENT_KEY_A', 'NON_EXISTENT_KEY_B']);

			expect(result).toEqual({
				NON_EXISTENT_KEY_A: undefined,
				NON_EXISTENT_KEY_B: undefined
			});
		});

		test('should return mixed results for existing and non-existing keys', async () => {
			const provider = new EnvConfigProvider();
			const result = await provider.loadKeys(['TEST_CONFIG_KEY', 'NON_EXISTENT_KEY_12345']);

			expect(result.TEST_CONFIG_KEY).toBe('test-value');
			expect(result.NON_EXISTENT_KEY_12345).toBeUndefined();
		});

		test('should return empty object for empty keys array', async () => {
			const provider = new EnvConfigProvider();
			const result = await provider.loadKeys([]);

			expect(result).toEqual({});
		});

		test('should handle single key', async () => {
			const provider = new EnvConfigProvider();
			const result = await provider.loadKeys(['TEST_CONFIG_KEY']);

			expect(result).toEqual({
				TEST_CONFIG_KEY: 'test-value'
			});
		});
	});
});
