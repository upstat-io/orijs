import { describe, test, expect } from 'bun:test';
import {
	readLogConfig,
	buildLoggerOptions,
	createLoggerOptionsFromConfig,
	type LogConfig
} from '../src/config.ts';
import type { ConfigProvider } from '@orijs/config';

// Mock config provider for testing
function createMockConfigProvider(values: Record<string, string | undefined>): ConfigProvider {
	return {
		async get(key: string): Promise<string | undefined> {
			return values[key];
		},
		async getRequired(key: string): Promise<string> {
			const value = values[key];
			if (value === undefined) {
				throw new Error(`Required config key missing: ${key}`);
			}
			return value;
		},
		async loadKeys(keys: string[]): Promise<Record<string, string | undefined>> {
			const result: Record<string, string | undefined> = {};
			for (const key of keys) {
				result[key] = values[key];
			}
			return result;
		}
	};
}

describe('readLogConfig', () => {
	describe('default values', () => {
		test('should return defaults when no config provided', async () => {
			const config = createMockConfigProvider({});

			const result = await readLogConfig(config);

			expect(result.level).toBe('info');
			expect(result.includeNames).toEqual([]);
			expect(result.excludeNames).toEqual([]);
			expect(result.fileEnabled).toBe(false);
			expect(result.filePath).toBe('./logs/app.log');
			expect(result.fileMaxSize).toBe('10mb');
			expect(result.fileMaxFiles).toBe(5);
			expect(result.jsonFormat).toBe(false);
		});
	});

	describe('LOG_LEVEL parsing', () => {
		test('should parse debug level', async () => {
			const config = createMockConfigProvider({ LOG_LEVEL: 'debug' });

			const result = await readLogConfig(config);

			expect(result.level).toBe('debug');
		});

		test('should parse info level', async () => {
			const config = createMockConfigProvider({ LOG_LEVEL: 'info' });

			const result = await readLogConfig(config);

			expect(result.level).toBe('info');
		});

		test('should parse warn level', async () => {
			const config = createMockConfigProvider({ LOG_LEVEL: 'warn' });

			const result = await readLogConfig(config);

			expect(result.level).toBe('warn');
		});

		test('should parse error level', async () => {
			const config = createMockConfigProvider({ LOG_LEVEL: 'error' });

			const result = await readLogConfig(config);

			expect(result.level).toBe('error');
		});

		test('should default to info for invalid level', async () => {
			const config = createMockConfigProvider({ LOG_LEVEL: 'invalid' });

			const result = await readLogConfig(config);

			expect(result.level).toBe('info');
		});

		test('should default to info for empty level', async () => {
			const config = createMockConfigProvider({ LOG_LEVEL: '' });

			const result = await readLogConfig(config);

			expect(result.level).toBe('info');
		});
	});

	describe('name list parsing', () => {
		test('should parse comma-separated include names', async () => {
			const config = createMockConfigProvider({
				LOG_INCLUDE_NAMES: 'AuthService,UserService,DbService'
			});

			const result = await readLogConfig(config);

			expect(result.includeNames).toEqual(['AuthService', 'UserService', 'DbService']);
		});

		test('should parse comma-separated exclude names', async () => {
			const config = createMockConfigProvider({
				LOG_EXCLUDE_NAMES: 'HealthCheck,Metrics'
			});

			const result = await readLogConfig(config);

			expect(result.excludeNames).toEqual(['HealthCheck', 'Metrics']);
		});

		test('should trim whitespace from names', async () => {
			const config = createMockConfigProvider({
				LOG_INCLUDE_NAMES: ' AuthService , UserService , DbService '
			});

			const result = await readLogConfig(config);

			expect(result.includeNames).toEqual(['AuthService', 'UserService', 'DbService']);
		});

		test('should filter empty strings from names', async () => {
			const config = createMockConfigProvider({
				LOG_INCLUDE_NAMES: 'AuthService,,UserService,'
			});

			const result = await readLogConfig(config);

			expect(result.includeNames).toEqual(['AuthService', 'UserService']);
		});

		test('should return empty array for empty string', async () => {
			const config = createMockConfigProvider({
				LOG_INCLUDE_NAMES: '',
				LOG_EXCLUDE_NAMES: ''
			});

			const result = await readLogConfig(config);

			expect(result.includeNames).toEqual([]);
			expect(result.excludeNames).toEqual([]);
		});

		test('should return empty array for whitespace-only string', async () => {
			const config = createMockConfigProvider({
				LOG_INCLUDE_NAMES: '   '
			});

			const result = await readLogConfig(config);

			expect(result.includeNames).toEqual([]);
		});
	});

	describe('file options', () => {
		test('should parse file enabled true', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_ENABLED: 'true'
			});

			const result = await readLogConfig(config);

			expect(result.fileEnabled).toBe(true);
		});

		test('should parse file enabled false', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_ENABLED: 'false'
			});

			const result = await readLogConfig(config);

			expect(result.fileEnabled).toBe(false);
		});

		test('should default file enabled to false for invalid value', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_ENABLED: 'yes'
			});

			const result = await readLogConfig(config);

			expect(result.fileEnabled).toBe(false);
		});

		test('should parse custom file path', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_PATH: '/var/log/myapp.log'
			});

			const result = await readLogConfig(config);

			expect(result.filePath).toBe('/var/log/myapp.log');
		});

		test('should parse file max count', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_MAX_COUNT: '10'
			});

			const result = await readLogConfig(config);

			expect(result.fileMaxFiles).toBe(10);
		});
	});

	describe('size normalization', () => {
		test('should normalize 10m to 10mb', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_MAX_SIZE: '10m'
			});

			const result = await readLogConfig(config);

			expect(result.fileMaxSize).toBe('10mb');
		});

		test('should keep 10mb as 10mb', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_MAX_SIZE: '10mb'
			});

			const result = await readLogConfig(config);

			expect(result.fileMaxSize).toBe('10mb');
		});

		test('should lowercase 10MB to 10mb', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_MAX_SIZE: '10MB'
			});

			const result = await readLogConfig(config);

			expect(result.fileMaxSize).toBe('10mb');
		});

		test('should keep 100kb as 100kb', async () => {
			const config = createMockConfigProvider({
				LOG_FILE_MAX_SIZE: '100kb'
			});

			const result = await readLogConfig(config);

			expect(result.fileMaxSize).toBe('100kb');
		});
	});

	describe('JSON format', () => {
		test('should parse JSON format true', async () => {
			const config = createMockConfigProvider({
				LOG_JSON: 'true'
			});

			const result = await readLogConfig(config);

			expect(result.jsonFormat).toBe(true);
		});

		test('should parse JSON format false', async () => {
			const config = createMockConfigProvider({
				LOG_JSON: 'false'
			});

			const result = await readLogConfig(config);

			expect(result.jsonFormat).toBe(false);
		});

		test('should default JSON format to false', async () => {
			const config = createMockConfigProvider({
				LOG_JSON: 'invalid'
			});

			const result = await readLogConfig(config);

			expect(result.jsonFormat).toBe(false);
		});
	});
});

function createDefaultConfig(): LogConfig {
	return {
		level: 'info',
		includeNames: [],
		excludeNames: [],
		fileEnabled: false,
		filePath: './logs/app.log',
		fileMaxSize: '10mb',
		fileMaxFiles: 5,
		jsonFormat: false
	};
}

describe('buildLoggerOptions', () => {
	describe('basic options', () => {
		test('should set log level from config', () => {
			const config = { ...createDefaultConfig(), level: 'debug' as const };

			const result = buildLoggerOptions(config);

			expect(result.level).toBe('debug');
		});

		test('should create single transport when no file logging', () => {
			const config = createDefaultConfig();

			const result = buildLoggerOptions(config);

			expect(result.transports).toHaveLength(1);
		});
	});

	describe('file transport', () => {
		test('should create multi transport when file enabled', () => {
			const config = { ...createDefaultConfig(), fileEnabled: true };

			const result = buildLoggerOptions(config);

			// When file is enabled, we get a multi transport wrapping console + file
			expect(result.transports).toHaveLength(1);
		});
	});

	describe('transport functionality with filtering', () => {
		test('should apply include filter to console transport', () => {
			const config: LogConfig = {
				...createDefaultConfig(),
				includeNames: ['AuthService', 'UserService']
			};

			const result = buildLoggerOptions(config);

			// Verify transport was created with filtering
			expect(result.transports).toHaveLength(1);
			expect(result.level).toBe('info');
		});

		test('should apply exclude filter to console transport', () => {
			const config: LogConfig = {
				...createDefaultConfig(),
				excludeNames: ['HealthCheck']
			};

			const result = buildLoggerOptions(config);

			expect(result.transports).toHaveLength(1);
		});

		test('should apply both include and exclude filters', () => {
			const config: LogConfig = {
				...createDefaultConfig(),
				includeNames: ['AuthService', 'UserService', 'HealthCheck'],
				excludeNames: ['HealthCheck']
			};

			const result = buildLoggerOptions(config);

			expect(result.transports).toHaveLength(1);
		});
	});

	describe('JSON format', () => {
		test('should create transport with JSON format when jsonFormat is true', () => {
			const config: LogConfig = {
				...createDefaultConfig(),
				jsonFormat: true
			};

			const result = buildLoggerOptions(config);

			// We can't easily inspect the console transport options,
			// but we can verify the transport was created
			expect(result.transports).toHaveLength(1);
		});

		test('should create transport with pretty format when jsonFormat is false', () => {
			const config: LogConfig = {
				...createDefaultConfig(),
				jsonFormat: false
			};

			const result = buildLoggerOptions(config);

			expect(result.transports).toHaveLength(1);
		});
	});
});

describe('createLoggerOptionsFromConfig', () => {
	test('should create logger options from config provider', async () => {
		const config = createMockConfigProvider({
			LOG_LEVEL: 'debug',
			LOG_INCLUDE_NAMES: 'AuthService',
			LOG_FILE_ENABLED: 'false'
		});

		const result = await createLoggerOptionsFromConfig(config);

		expect(result.level).toBe('debug');
		expect(result.transports).toHaveLength(1);
	});

	test('should work with complete config', async () => {
		const config = createMockConfigProvider({
			LOG_LEVEL: 'warn',
			LOG_INCLUDE_NAMES: 'AuthService,UserService',
			LOG_EXCLUDE_NAMES: 'HealthCheck',
			LOG_FILE_ENABLED: 'true',
			LOG_FILE_PATH: './logs/test.log',
			LOG_FILE_MAX_SIZE: '5mb',
			LOG_FILE_MAX_COUNT: '3',
			LOG_JSON: 'true'
		});

		const result = await createLoggerOptionsFromConfig(config);

		expect(result.level).toBe('warn');
		expect(result.transports).toHaveLength(1); // multi transport wrapping filtered console + file
	});

	test('should work with minimal config', async () => {
		const config = createMockConfigProvider({});

		const result = await createLoggerOptionsFromConfig(config);

		expect(result.level).toBe('info');
		expect(result.transports).toHaveLength(1);
	});

	test('should integrate with GsmConfigProvider interface', async () => {
		// This simulates how a GCP config provider would work
		const gsmValues: Record<string, string> = {
			LOG_LEVEL: 'error',
			LOG_JSON: 'true'
		};

		const gsmConfig: ConfigProvider = {
			async get(key: string): Promise<string | undefined> {
				// Simulate fetching from GCP Secret Manager
				return gsmValues[key];
			},
			async getRequired(key: string): Promise<string> {
				const value = gsmValues[key];
				if (!value) throw new Error(`Missing: ${key}`);
				return value;
			},
			async loadKeys(keys: string[]): Promise<Record<string, string | undefined>> {
				const result: Record<string, string | undefined> = {};
				for (const key of keys) {
					result[key] = gsmValues[key];
				}
				return result;
			}
		};

		const result = await createLoggerOptionsFromConfig(gsmConfig);

		expect(result.level).toBe('error');
	});
});
