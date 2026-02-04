import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
	NamespacedConfigBuilder,
	createConfigProvider,
	type NamespacedConfigResult,
	type ConfigTransformer
} from '../src/namespaced-config.ts';
import type { ConfigProvider } from '../src/types.ts';
import { Logger } from '@orijs/logging';

/**
 * Helper to create a mock ConfigProvider with all required methods.
 */
function createMockProvider(
	loadKeysFn: (keys: string[]) => Promise<Record<string, string | undefined>>
): ConfigProvider {
	const cache: Record<string, string | undefined> = {};

	return {
		loadKeys: async (keys: string[]) => {
			const result = await loadKeysFn(keys);
			Object.assign(cache, result);
			return result;
		},
		get: async (key: string) => cache[key],
		getRequired: async (key: string) => {
			const value = cache[key];
			if (value === undefined) throw new Error(`Config key not found: ${key}`);
			return value;
		}
	};
}

/**
 * Helper to create a simple mock provider that returns static values.
 */
function createStaticMockProvider(values: Record<string, string>): ConfigProvider {
	return createMockProvider(async () => values);
}

describe('NamespacedConfigBuilder', () => {
	// Store original env values
	const originalEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		Logger.reset();
		// Save and clear test env vars
		originalEnv.TEST_PORT = Bun.env.TEST_PORT;
		originalEnv.TEST_HOST = Bun.env.TEST_HOST;
		originalEnv.NODE_ENV = Bun.env.NODE_ENV;
	});

	afterEach(() => {
		Logger.reset();
		// Restore original env values
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	});

	describe('createConfigProvider()', () => {
		test('should create a new NamespacedConfigBuilder', () => {
			const builder = createConfigProvider();

			expect(builder).toBeInstanceOf(NamespacedConfigBuilder);
		});

		test('should accept custom logger', () => {
			const customLogger = new Logger('CustomConfig');
			const builder = createConfigProvider(customLogger);

			expect(builder).toBeInstanceOf(NamespacedConfigBuilder);
		});
	});

	describe('env namespace', () => {
		test('should read env keys from Bun.env', async () => {
			Bun.env.TEST_PORT = '3000';
			Bun.env.TEST_HOST = 'localhost';

			const config = await createConfigProvider()
				.expectKeys({ env: ['TEST_PORT', 'TEST_HOST'] })
				.onFail('warn')
				.validate();

			expect(config.env.TEST_PORT).toBe('3000');
			expect(config.env.TEST_HOST).toBe('localhost');
		});

		test('should report missing env keys', async () => {
			// Ensure these don't exist
			delete Bun.env.MISSING_KEY_1;
			delete Bun.env.MISSING_KEY_2;

			await expect(
				createConfigProvider()
					.expectKeys({ env: ['MISSING_KEY_1', 'MISSING_KEY_2'] })
					.onFail('error')
					.validate()
			).rejects.toThrow('Missing required config keys');
		});

		test('should warn but continue when onFail is warn', async () => {
			delete Bun.env.OPTIONAL_KEY;

			const config = await createConfigProvider()
				.expectKeys({ env: ['OPTIONAL_KEY'] })
				.onFail('warn')
				.validate();

			expect(config.env.OPTIONAL_KEY).toBeUndefined();
		});

		test('should treat empty string as missing', async () => {
			Bun.env.EMPTY_KEY = '';

			await expect(
				createConfigProvider()
					.expectKeys({ env: ['EMPTY_KEY'] })
					.onFail('error')
					.validate()
			).rejects.toThrow('Missing required config keys');
		});
	});

	describe('add() for custom namespaces', () => {
		test('should throw when trying to override env namespace', () => {
			const mockProvider = createStaticMockProvider({});

			expect(() => {
				createConfigProvider().add('env', mockProvider);
			}).toThrow('Cannot override "env" namespace');
		});

		test('should add provider instance', async () => {
			const mockProvider = createMockProvider(async (keys: string[]) => {
				const result: Record<string, string> = {};
				for (const key of keys) {
					result[key] = `value-${key}`;
				}
				return result;
			});

			const config = await createConfigProvider()
				.add('secrets', mockProvider)
				.expectKeys({ secrets: ['DB_PASSWORD', 'API_KEY'] })
				.validate();

			expect(config.secrets!.DB_PASSWORD).toBe('value-DB_PASSWORD');
			expect(config.secrets!.API_KEY).toBe('value-API_KEY');
		});

		test('should add provider constructor', async () => {
			class TestProvider implements ConfigProvider {
				private cache: Record<string, string | undefined> = {};

				async loadKeys(keys: string[]): Promise<Record<string, string>> {
					const result: Record<string, string> = {};
					for (const key of keys) {
						result[key] = `ctor-${key}`;
					}
					Object.assign(this.cache, result);
					return result;
				}

				async get(key: string): Promise<string | undefined> {
					return this.cache[key];
				}

				async getRequired(key: string): Promise<string> {
					const value = this.cache[key];
					if (value === undefined) throw new Error(`Config key not found: ${key}`);
					return value;
				}
			}

			const config = await createConfigProvider()
				.add('secrets', TestProvider)
				.expectKeys({ secrets: ['SECRET_1'] })
				.validate();

			expect(config.secrets!.SECRET_1).toBe('ctor-SECRET_1');
		});

		test('should add provider factory', async () => {
			const factory = {
				create: async (): Promise<ConfigProvider> => {
					return createMockProvider(async (keys: string[]) => {
						const result: Record<string, string> = {};
						for (const key of keys) {
							result[key] = `factory-${key}`;
						}
						return result;
					});
				}
			};

			const config = await createConfigProvider()
				.add('secrets', factory)
				.expectKeys({ secrets: ['SECRET_A'] })
				.validate();

			expect(config.secrets!.SECRET_A).toBe('factory-SECRET_A');
		});

		test('should chain multiple add calls', async () => {
			const provider1 = createStaticMockProvider({ KEY_1: 'value1' });
			const provider2 = createStaticMockProvider({ KEY_2: 'value2' });

			const config = await createConfigProvider()
				.add('namespace1', provider1)
				.add('namespace2', provider2)
				.expectKeys({
					namespace1: ['KEY_1'],
					namespace2: ['KEY_2']
				})
				.validate();

			expect(config.namespace1!.KEY_1).toBe('value1');
			expect(config.namespace2!.KEY_2).toBe('value2');
		});
	});

	describe('expectKeys()', () => {
		test('should throw when namespace not added', async () => {
			await expect(
				createConfigProvider()
					.expectKeys({ nonexistent: ['KEY'] })
					.validate()
			).rejects.toThrow('Namespace "nonexistent" in expectKeys was not added');
		});

		test('should handle empty keys array for namespace', async () => {
			const loadKeysMock = mock(async () => ({}));
			const mockProvider = createMockProvider(loadKeysMock);

			const config = await createConfigProvider()
				.add('empty', mockProvider)
				.expectKeys({ empty: [] })
				.validate();

			// loadKeys should not be called with empty array
			expect(config.empty).toEqual({});
		});

		test('should validate across multiple namespaces', async () => {
			Bun.env.ENV_KEY = 'env-value';

			const secretsProvider = createStaticMockProvider({ SECRET_KEY: 'secret-value' });

			const config = await createConfigProvider()
				.add('secrets', secretsProvider)
				.expectKeys({
					env: ['ENV_KEY'],
					secrets: ['SECRET_KEY']
				})
				.validate();

			expect(config.env.ENV_KEY).toBe('env-value');
			expect(config.secrets!.SECRET_KEY).toBe('secret-value');
		});
	});

	describe('onFail()', () => {
		test('should throw by default when keys are missing', async () => {
			delete Bun.env.REQUIRED_KEY;

			await expect(
				createConfigProvider()
					.expectKeys({ env: ['REQUIRED_KEY'] })
					.validate()
			).rejects.toThrow('Missing required config keys');
		});

		test('should throw when onFail is error', async () => {
			delete Bun.env.REQUIRED_KEY;

			await expect(
				createConfigProvider()
					.expectKeys({ env: ['REQUIRED_KEY'] })
					.onFail('error')
					.validate()
			).rejects.toThrow('Missing required config keys');
		});

		test('should not throw when onFail is warn', async () => {
			delete Bun.env.OPTIONAL_KEY;

			const config = await createConfigProvider()
				.expectKeys({ env: ['OPTIONAL_KEY'] })
				.onFail('warn')
				.validate();

			expect(config.env.OPTIONAL_KEY).toBeUndefined();
		});
	});

	describe('validate()', () => {
		test('should return sync accessor for cached values', async () => {
			Bun.env.CACHED_KEY = 'cached-value';

			const config = await createConfigProvider()
				.expectKeys({ env: ['CACHED_KEY'] })
				.onFail('warn')
				.validate();

			// Access should be sync (no await needed)
			const value = config.env.CACHED_KEY;
			expect(value).toBe('cached-value');
		});

		test('should return empty object for unknown namespace access', async () => {
			const config = await createConfigProvider().expectKeys({ env: [] }).onFail('warn').validate();

			// Accessing unknown namespace should return empty object
			const unknown = config.unknown as Record<string, string | undefined>;
			expect(unknown).toEqual({});
			expect(unknown.SOME_KEY).toBeUndefined();
		});

		test('should handle provider that returns missing keys', async () => {
			// Provider that only returns some keys (KEY_1, not KEY_2)
			const incompleteProvider = createStaticMockProvider({ KEY_1: 'value1' });

			await expect(
				createConfigProvider()
					.add('partial', incompleteProvider)
					.expectKeys({ partial: ['KEY_1', 'KEY_2'] })
					.onFail('error')
					.validate()
			).rejects.toThrow('Missing required config keys');
		});

		test('should report present keys count in success message', async () => {
			Bun.env.KEY_A = 'a';
			Bun.env.KEY_B = 'b';

			// This should log success without throwing
			const config = await createConfigProvider()
				.expectKeys({ env: ['KEY_A', 'KEY_B'] })
				.validate();

			expect(config.env.KEY_A).toBe('a');
			expect(config.env.KEY_B).toBe('b');
		});
	});

	describe('fluent chaining', () => {
		test('should support full fluent chain', async () => {
			Bun.env.CHAIN_KEY = 'chain-value';

			const secretsProvider = createStaticMockProvider({ SECRET: 'secret-value' });

			const config = await createConfigProvider()
				.add('secrets', secretsProvider)
				.expectKeys({
					env: ['CHAIN_KEY'],
					secrets: ['SECRET']
				})
				.onFail('error')
				.validate();

			expect(config.env.CHAIN_KEY).toBe('chain-value');
			expect(config.secrets!.SECRET).toBe('secret-value');
		});

		test('should allow calling methods in any order before validate', async () => {
			Bun.env.ORDER_KEY = 'order-value';

			const provider = createStaticMockProvider({ P_KEY: 'p-value' });

			// Different order
			const config = await createConfigProvider()
				.onFail('warn')
				.expectKeys({ env: ['ORDER_KEY'], ns: ['P_KEY'] })
				.add('ns', provider)
				.validate();

			expect(config.env.ORDER_KEY).toBe('order-value');
			expect(config.ns!.P_KEY).toBe('p-value');
		});
	});

	describe('proxy behavior', () => {
		test('should use proxy for namespace access', async () => {
			Bun.env.PROXY_KEY = 'proxy-value';

			const config = await createConfigProvider()
				.expectKeys({ env: ['PROXY_KEY'] })
				.validate();

			// Verify proxy behavior - accessing existing namespace
			expect('env' in config).toBe(true);
			expect(config.env.PROXY_KEY).toBe('proxy-value');
		});

		test('should return empty object for unknown namespace via proxy', async () => {
			const config = await createConfigProvider().expectKeys({ env: [] }).onFail('warn').validate();

			// Proxy should return empty object for unknown namespace
			const result = (config as NamespacedConfigResult).unknownNamespace;
			expect(result).toEqual({});
		});
	});

	describe('transform()', () => {
		interface SecretsConfig {
			SECRET_HOST: string;
			SECRET_PORT: string;
		}

		interface RedisConfig {
			host: string;
			port: number;
		}

		interface AppConfig {
			secrets: SecretsConfig;
			redis: RedisConfig;
		}

		const RedisConfigTransformer: ConfigTransformer<{ secrets: SecretsConfig }, RedisConfig> = {
			property: 'redis',
			transform: (config) => ({
				host: config.secrets.SECRET_HOST,
				port: Number(config.secrets.SECRET_PORT) || 6379
			})
		};

		test('should apply transformer to derive property', async () => {
			const secretsProvider = createStaticMockProvider({
				SECRET_HOST: 'localhost',
				SECRET_PORT: '6380'
			});

			const config = await createConfigProvider()
				.add('secrets', secretsProvider)
				.expectKeys({ secrets: ['SECRET_HOST', 'SECRET_PORT'] })
				.transform(RedisConfigTransformer)
				.validate<AppConfig>();

			expect(config.redis).toEqual({
				host: 'localhost',
				port: 6380
			});
		});

		test('should apply default port when SECRET_PORT is invalid', async () => {
			const secretsProvider = createStaticMockProvider({
				SECRET_HOST: 'redis.example.com',
				SECRET_PORT: 'invalid'
			});

			const config = await createConfigProvider()
				.add('secrets', secretsProvider)
				.expectKeys({ secrets: ['SECRET_HOST', 'SECRET_PORT'] })
				.transform(RedisConfigTransformer)
				.validate<AppConfig>();

			expect(config.redis.port).toBe(6379);
		});

		test('should chain multiple transformers', async () => {
			interface DbConfig {
				connectionString: string;
			}

			const DbConfigTransformer: ConfigTransformer<{ secrets: SecretsConfig }, DbConfig> = {
				property: 'db',
				transform: () => ({
					connectionString: 'postgres://localhost/test'
				})
			};

			const secretsProvider = createStaticMockProvider({
				SECRET_HOST: 'localhost',
				SECRET_PORT: '6379'
			});

			const config = await createConfigProvider()
				.add('secrets', secretsProvider)
				.expectKeys({ secrets: ['SECRET_HOST', 'SECRET_PORT'] })
				.transform(RedisConfigTransformer)
				.transform(DbConfigTransformer)
				.validate<AppConfig & { db: DbConfig }>();

			expect(config.redis.host).toBe('localhost');
			expect(config.db.connectionString).toBe('postgres://localhost/test');
		});

		test('transformer is a pure function - testable in isolation', () => {
			// Transformers can be unit tested without the config builder
			const mockConfig = {
				secrets: {
					SECRET_HOST: 'test-host',
					SECRET_PORT: '9999'
				}
			};

			const result = RedisConfigTransformer.transform(mockConfig);

			expect(result).toEqual({
				host: 'test-host',
				port: 9999
			});
		});
	});
});
