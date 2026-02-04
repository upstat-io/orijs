import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { ValidatedConfig } from '../src/validated-config.ts';
import { EnvConfigProvider } from '../src/env-config.ts';
import { Logger } from '@orijs/logging';
import type { ConfigProvider } from '../src/types.ts';

describe('ValidatedConfig', () => {
	beforeAll(() => {
		Bun.env.TEST_KEY_A = 'value-a';
		Bun.env.TEST_KEY_B = 'value-b';
		Bun.env.TEST_EMPTY_KEY = '';
	});

	afterAll(async () => {
		delete Bun.env.TEST_KEY_A;
		delete Bun.env.TEST_KEY_B;
		delete Bun.env.TEST_EMPTY_KEY;
		// Clean up Logger state to prevent timer from keeping process alive
		await Logger.shutdown();
	});

	/** Creates a mock provider for testing */
	function createMockProvider(values: Record<string, string | undefined>): ConfigProvider {
		return {
			get: async (key: string) => values[key],
			getRequired: async (key: string) => {
				const value = values[key];
				if (value === undefined || value === '') {
					throw new Error(`Missing: ${key}`);
				}
				return value;
			},
			loadKeys: async (keys: string[]) => {
				const result: Record<string, string | undefined> = {};
				for (const key of keys) {
					result[key] = values[key];
				}
				return result;
			}
		};
	}

	describe('delegation', () => {
		test('should delegate get() to wrapped provider', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			const value = await validated.get('TEST_KEY_A');

			expect(value).toBe('value-a');
		});

		test('should delegate getRequired() to wrapped provider', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			const value = await validated.getRequired('TEST_KEY_A');

			expect(value).toBe('value-a');
		});

		test('should propagate errors from wrapped provider', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			await expect(validated.getRequired('NONEXISTENT')).rejects.toThrow();
		});
	});

	describe('key tracking', () => {
		test('should track keys accessed via get()', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			await validated.get('TEST_KEY_A');
			await validated.get('TEST_KEY_B');

			const loadedKeys = validated.getLoadedKeys();
			expect(loadedKeys).toContain('TEST_KEY_A');
			expect(loadedKeys).toContain('TEST_KEY_B');
		});

		test('should track keys accessed via getRequired()', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			await validated.getRequired('TEST_KEY_A');

			expect(validated.getLoadedKeys()).toContain('TEST_KEY_A');
		});

		test('should not duplicate keys on multiple accesses', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			await validated.get('TEST_KEY_A');
			await validated.get('TEST_KEY_A');
			await validated.get('TEST_KEY_A');

			const loadedKeys = validated.getLoadedKeys();
			expect(loadedKeys.filter((k) => k === 'TEST_KEY_A').length).toBe(1);
		});

		test('should return empty array when no keys accessed', () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			expect(validated.getLoadedKeys()).toEqual([]);
		});
	});

	describe('logging', () => {
		test('should log key name on first access', async () => {
			const mockLogger = new Logger('Test', { level: 'debug' });
			const debugSpy = mock(() => {});
			mockLogger.debug = debugSpy;

			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider, mockLogger);
			await validated.get('TEST_KEY_A');

			expect(debugSpy).toHaveBeenCalledWith('Config Key Accessed: TEST_KEY_A');
		});

		test('should not log key on subsequent accesses', async () => {
			const mockLogger = new Logger('Test', { level: 'debug' });
			const debugSpy = mock(() => {});
			mockLogger.debug = debugSpy;

			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider, mockLogger);
			await validated.get('TEST_KEY_A');
			await validated.get('TEST_KEY_A');
			await validated.get('TEST_KEY_A');

			expect(debugSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('logLoadedKeys', () => {
		test('should log summary of all accessed keys', async () => {
			const mockLogger = new Logger('Test', { level: 'info' });
			const infoSpy = mock(() => {});
			mockLogger.info = infoSpy;

			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider, mockLogger);
			await validated.get('TEST_KEY_A');
			await validated.get('TEST_KEY_B');

			validated.logLoadedKeys();

			expect(infoSpy).toHaveBeenCalledWith('Config Keys Accessed: TEST_KEY_A, TEST_KEY_B');
		});

		test('should log appropriate message when no keys accessed', () => {
			const mockLogger = new Logger('Test', { level: 'info' });
			const infoSpy = mock(() => {});
			mockLogger.info = infoSpy;

			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider, mockLogger);

			validated.logLoadedKeys();

			expect(infoSpy).toHaveBeenCalledWith('No Config Keys Accessed');
		});
	});

	describe('expectKeys', () => {
		test('should be chainable', () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			const result = validated.expectKeys('KEY_1').expectKeys('KEY_2', 'KEY_3');

			expect(result).toBe(validated);
		});
	});

	describe('onFail', () => {
		test('should be chainable', () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			const result = validated.onFail('error');

			expect(result).toBe(validated);
		});

		test('should accept "error" mode', () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			// Should not throw
			validated.onFail('error');
		});

		test('should accept "warn" mode', () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			// Should not throw
			validated.onFail('warn');
		});
	});

	describe('validate with onFail("error")', () => {
		test('should pass when all expected keys are present', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A', 'TEST_KEY_B').onFail('error');

			const result = await validated.validate();

			expect(result).toBe(validated);
		});

		test('should throw when any expected key is missing', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('NONEXISTENT_KEY_123').onFail('error');

			await expect(validated.validate()).rejects.toThrow('Missing required config keys: NONEXISTENT_KEY_123');
		});

		test('should list ALL missing keys in error message', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider)
				.expectKeys('MISSING_A', 'MISSING_B', 'MISSING_C')
				.onFail('error');

			await expect(validated.validate()).rejects.toThrow(
				'Missing required config keys: MISSING_A, MISSING_B, MISSING_C'
			);
		});

		test('should treat empty string as missing', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_EMPTY_KEY').onFail('error');

			await expect(validated.validate()).rejects.toThrow('Missing required config keys: TEST_EMPTY_KEY');
		});
	});

	describe('validate with onFail("warn") (default)', () => {
		test('should warn but not throw when keys are missing', async () => {
			const mockLogger = new Logger('Test', { level: 'warn' });
			const warnSpy = mock(() => {});
			mockLogger.warn = warnSpy;

			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider, mockLogger).expectKeys('MISSING_KEY').onFail('warn');

			// Should not throw
			const result = await validated.validate();

			expect(result).toBe(validated);
			expect(warnSpy).toHaveBeenCalled();
		});

		test('should default to warn mode', async () => {
			const mockLogger = new Logger('Test', { level: 'warn' });
			const warnSpy = mock(() => {});
			mockLogger.warn = warnSpy;

			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider, mockLogger).expectKeys('MISSING_KEY');
			// Note: no .onFail() called - should default to warn

			// Should not throw
			await validated.validate();

			expect(warnSpy).toHaveBeenCalled();
		});

		test('should log success when all keys present', async () => {
			const mockLogger = new Logger('Test', { level: 'info' });
			const infoSpy = mock(() => {});
			mockLogger.info = infoSpy;

			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider, mockLogger)
				.expectKeys('TEST_KEY_A', 'TEST_KEY_B')
				.onFail('warn');

			await validated.validate();

			expect(infoSpy).toHaveBeenCalledWith('Config Validated: 2 expected keys present');
		});
	});

	describe('checkExpectedKeys', () => {
		test('should return valid result when all keys present', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A', 'TEST_KEY_B');

			const result = await validated.checkExpectedKeys();

			expect(result.valid).toBe(true);
			expect(result.missing).toEqual([]);
			expect(result.present).toContain('TEST_KEY_A');
			expect(result.present).toContain('TEST_KEY_B');
		});

		test('should return invalid result with missing keys listed', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('MISSING_X', 'MISSING_Y', 'TEST_KEY_A');

			const result = await validated.checkExpectedKeys();

			expect(result.valid).toBe(false);
			expect(result.missing).toContain('MISSING_X');
			expect(result.missing).toContain('MISSING_Y');
			expect(result.present).toContain('TEST_KEY_A');
		});

		test('should not throw even when keys are missing', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('DEFINITELY_MISSING');

			// Should not throw
			const result = await validated.checkExpectedKeys();

			expect(result.valid).toBe(false);
		});
	});

	describe('works with any ConfigProvider', () => {
		test('should work with custom mock provider', async () => {
			const mockProvider = createMockProvider({
				CUSTOM_KEY: 'custom-value'
			});

			const validated = new ValidatedConfig(mockProvider).expectKeys('CUSTOM_KEY');

			const result = await validated.checkExpectedKeys();
			expect(result.valid).toBe(true);

			const value = await validated.get('CUSTOM_KEY');
			expect(value).toBe('custom-value');
		});
	});

	describe('fluent API', () => {
		test('should support full fluent chain', async () => {
			const provider = new EnvConfigProvider();

			const validated = new ValidatedConfig(provider)
				.expectKeys('TEST_KEY_A')
				.expectKeys('TEST_KEY_B')
				.onFail('error');

			await validated.validate();

			// Should still work after all the chaining
			const value = await validated.get('TEST_KEY_A');
			expect(value).toBe('value-a');
		});
	});

	describe('getSync', () => {
		test('should return cached value after validation', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A').onFail('error');

			await validated.validate();

			const value = validated.getSync('TEST_KEY_A');
			expect(value).toBe('value-a');
		});

		test('should return undefined for missing key after validation', async () => {
			const mockProvider = createMockProvider({
				PRESENT_KEY: 'value'
			});
			const validated = new ValidatedConfig(mockProvider)
				.expectKeys('PRESENT_KEY', 'MISSING_KEY')
				.onFail('warn');

			await validated.validate();

			const value = validated.getSync('MISSING_KEY');
			expect(value).toBeUndefined();
		});

		test('should throw if validate() not called', () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A');

			expect(() => validated.getSync('TEST_KEY_A')).toThrow(
				'Cannot use getSync() before validate() is called'
			);
		});

		test('should throw if key was not in expectedKeys', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A').onFail('error');

			await validated.validate();

			expect(() => validated.getSync('TEST_KEY_B')).toThrow(
				'Key "TEST_KEY_B" was not in expectedKeys - add it to expectKeys() for sync access'
			);
		});

		test('should track key access', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A').onFail('error');

			await validated.validate();
			validated.getSync('TEST_KEY_A');

			expect(validated.getLoadedKeys()).toContain('TEST_KEY_A');
		});
	});

	describe('getRequiredSync', () => {
		test('should return value for present key', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A').onFail('error');

			await validated.validate();

			const value = validated.getRequiredSync('TEST_KEY_A');
			expect(value).toBe('value-a');
		});

		test('should throw for missing required key', async () => {
			const mockProvider = createMockProvider({
				PRESENT_KEY: 'value'
			});
			const validated = new ValidatedConfig(mockProvider)
				.expectKeys('PRESENT_KEY', 'MISSING_KEY')
				.onFail('warn');

			await validated.validate();

			expect(() => validated.getRequiredSync('MISSING_KEY')).toThrow(
				'Required config key "MISSING_KEY" is missing or empty'
			);
		});

		test('should throw for empty required key', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_EMPTY_KEY').onFail('warn');

			await validated.validate();

			expect(() => validated.getRequiredSync('TEST_EMPTY_KEY')).toThrow(
				'Required config key "TEST_EMPTY_KEY" is missing or empty'
			);
		});

		test('should throw if validate() not called', () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A');

			expect(() => validated.getRequiredSync('TEST_KEY_A')).toThrow(
				'Cannot use getSync() before validate() is called'
			);
		});

		test('should throw if key was not in expectedKeys', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider).expectKeys('TEST_KEY_A').onFail('error');

			await validated.validate();

			expect(() => validated.getRequiredSync('TEST_KEY_B')).toThrow(
				'Key "TEST_KEY_B" was not in expectedKeys'
			);
		});
	});

	describe('loadKeys', () => {
		test('should delegate to underlying provider', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			const result = await validated.loadKeys(['TEST_KEY_A', 'TEST_KEY_B']);

			expect(result).toEqual({
				TEST_KEY_A: 'value-a',
				TEST_KEY_B: 'value-b'
			});
		});

		test('should return undefined for non-existent keys', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			const result = await validated.loadKeys(['NONEXISTENT_KEY']);

			expect(result.NONEXISTENT_KEY).toBeUndefined();
		});

		test('should handle empty array', async () => {
			const provider = new EnvConfigProvider();
			const validated = new ValidatedConfig(provider);

			const result = await validated.loadKeys([]);

			expect(result).toEqual({});
		});

		test('should work with mock provider', async () => {
			const mockProvider = createMockProvider({
				KEY_1: 'val1',
				KEY_2: 'val2'
			});
			const validated = new ValidatedConfig(mockProvider);

			const result = await validated.loadKeys(['KEY_1', 'KEY_2', 'KEY_3']);

			expect(result).toEqual({
				KEY_1: 'val1',
				KEY_2: 'val2',
				KEY_3: undefined
			});
		});
	});
});
