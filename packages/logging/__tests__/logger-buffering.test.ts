import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Logger, type LogObject, type Transport } from '../src/index.ts';
import { ValidatedConfig } from '@orijs/config';
import type { ConfigProvider } from '@orijs/config';

describe('Logger buffering', () => {
	beforeEach(() => {
		Logger.reset();
	});

	afterEach(() => {
		Logger.reset();
	});

	function createCollectorTransport(): Transport & { logs: LogObject[] } {
		const logs: LogObject[] = [];
		return {
			logs,
			write(obj: LogObject) {
				logs.push(obj);
			},
			async flush() {},
			async close() {}
		};
	}

	describe('pending logs before initialization', () => {
		test('should buffer logs when Logger is not initialized', () => {
			const collector = createCollectorTransport();
			const logger = new Logger('TestService');

			// Log before configure - should be buffered
			logger.info('First message');
			logger.warn('Second message');

			// Collector should have nothing yet
			expect(collector.logs.length).toBe(0);

			// Configure with our collector
			Logger.configure({ transports: [collector] });

			// Now buffered logs should be flushed
			expect(collector.logs.length).toBe(2);
			expect(collector.logs[0]!.msg).toBe('First message');
			expect(collector.logs[0]!.level).toBe(20); // info
			expect(collector.logs[1]!.msg).toBe('Second message');
			expect(collector.logs[1]!.level).toBe(30); // warn
		});

		test('should include all log levels in buffer', () => {
			const collector = createCollectorTransport();
			const logger = new Logger('TestService', { level: 'debug' });

			logger.debug('Debug message');
			logger.info('Info message');
			logger.warn('Warn message');
			logger.error('Error message');

			Logger.configure({ level: 'debug', transports: [collector] });

			expect(collector.logs.length).toBe(4);
			expect(collector.logs[0]!.level).toBe(10); // debug
			expect(collector.logs[1]!.level).toBe(20); // info
			expect(collector.logs[2]!.level).toBe(30); // warn
			expect(collector.logs[3]!.level).toBe(40); // error
		});

		test('should preserve log context in buffered logs', () => {
			const collector = createCollectorTransport();
			const logger = new Logger('TestService');

			logger.info('Message with data', { userId: 123, action: 'login' });

			Logger.configure({ transports: [collector] });

			expect(collector.logs.length).toBe(1);
			expect(collector.logs[0]!.userId).toBe(123);
			expect(collector.logs[0]!.action).toBe('login');
		});

		test('should preserve logger name in buffered logs', () => {
			const collector = createCollectorTransport();
			const logger = new Logger('MyService');

			logger.info('Test message');

			Logger.configure({ transports: [collector] });

			expect(collector.logs[0]!.name).toBe('MyService');
		});
	});

	describe('Logger.flush()', () => {
		test('should flush pending logs to default transport', () => {
			// We can't easily capture default transport output, but we can verify
			// the buffer is cleared after flush
			const logger = new Logger('TestService');

			logger.info('Buffered message');

			// Flush should not throw
			expect(() => Logger.flush()).not.toThrow();

			// After flush, configure should not replay the message
			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector] });

			expect(collector.logs.length).toBe(0);
		});

		test('should do nothing when no pending logs', () => {
			expect(() => Logger.flush()).not.toThrow();
		});
	});

	describe('Logger.reset()', () => {
		test('should clear pending logs', () => {
			const logger = new Logger('TestService');

			logger.info('Message before reset');

			Logger.reset();

			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector], async: false });

			// Message should be gone after reset
			expect(collector.logs.length).toBe(0);
		});

		test('should reset initialized state', () => {
			const collector1 = createCollectorTransport();
			Logger.configure({ transports: [collector1], async: false });

			const logger = new Logger('TestService');
			logger.info('First message');

			expect(collector1.logs.length).toBe(1);

			// Reset and reconfigure
			Logger.reset();

			const collector2 = createCollectorTransport();
			const logger2 = new Logger('TestService2');

			logger2.info('Buffered after reset');

			// Should be buffered again
			expect(collector2.logs.length).toBe(0);

			Logger.configure({ transports: [collector2], async: false });

			expect(collector2.logs.length).toBe(1);
			expect(collector2.logs[0]!.msg).toBe('Buffered after reset');
		});
	});

	describe('explicit transports bypass buffering', () => {
		test('should write immediately when logger has explicit transports', () => {
			const collector = createCollectorTransport();
			const logger = new Logger('TestService', { transports: [collector] });

			// Logger not configured globally, but has explicit transport
			logger.info('Immediate message');

			// Should write immediately, not buffer
			expect(collector.logs.length).toBe(1);
			expect(collector.logs[0]!.msg).toBe('Immediate message');
		});

		test('should not be affected by global configure when using explicit transports', () => {
			const explicitCollector = createCollectorTransport();
			const globalCollector = createCollectorTransport();

			const logger = new Logger('TestService', { transports: [explicitCollector] });

			logger.info('Before configure');

			Logger.configure({ transports: [globalCollector] });

			logger.info('After configure');

			// All messages should go to explicit transport
			expect(explicitCollector.logs.length).toBe(2);
			expect(globalCollector.logs.length).toBe(0);
		});
	});

	describe('after initialization', () => {
		test('should write directly to transports after configure with async=false', () => {
			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector], async: false });

			const logger = new Logger('TestService');
			logger.info('Direct message');

			expect(collector.logs.length).toBe(1);
			expect(collector.logs[0]!.msg).toBe('Direct message');
		});

		test('should buffer when async=true (default) and flush on interval', () => {
			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector], async: true });

			const logger = new Logger('TestService');
			logger.info('Message 1');
			logger.info('Message 2');

			// With async=true, messages are buffered
			expect(collector.logs.length).toBe(0);

			// Flush manually to verify they're in the buffer
			Logger.flush();
			expect(collector.logs.length).toBe(2);
		});

		test('should not buffer after configure with async=false', () => {
			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector], async: false });

			const logger = new Logger('TestService');
			logger.info('Message 1');
			logger.info('Message 2');

			// Should write immediately, not batch
			expect(collector.logs.length).toBe(2);
		});
	});

	describe('multiple loggers', () => {
		test('should buffer logs from multiple loggers', () => {
			const collector = createCollectorTransport();

			const logger1 = new Logger('Service1');
			const logger2 = new Logger('Service2');

			logger1.info('From service 1');
			logger2.info('From service 2');
			logger1.warn('Warning from service 1');

			Logger.configure({ transports: [collector] });

			expect(collector.logs.length).toBe(3);
			expect(collector.logs[0]!.name).toBe('Service1');
			expect(collector.logs[1]!.name).toBe('Service2');
			expect(collector.logs[2]!.name).toBe('Service1');
		});
	});

	describe('child loggers with context', () => {
		test('should buffer logs from child loggers with context', () => {
			const collector = createCollectorTransport();

			const logger = new Logger('Service');
			const childLogger = logger.with({ correlationId: 'req-123' });

			childLogger.info('Request started');

			Logger.configure({ transports: [collector] });

			expect(collector.logs.length).toBe(1);
			expect(collector.logs[0]!.correlationId).toBe('req-123');
		});
	});

	describe('config validation errors', () => {
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

		test('should send config validation errors to configured transport', async () => {
			const collector = createCollectorTransport();

			// Configure logger with custom transport BEFORE config validation
			// Use async: false for synchronous writes in tests
			Logger.configure({ transports: [collector], async: false });

			const provider = createMockConfigProvider({
				EXISTING_KEY: 'value'
				// Missing: REQUIRED_KEY_1, REQUIRED_KEY_2
			});

			const config = new ValidatedConfig(provider)
				.expectKeys('EXISTING_KEY', 'REQUIRED_KEY_1', 'REQUIRED_KEY_2')
				.onFail('warn'); // Use warn mode so it doesn't exit

			await config.validate();

			// Should have logged the error through our collector
			const errorLogs = collector.logs.filter((log) => log.level === 30); // warn level
			expect(errorLogs.length).toBe(1);
			expect(errorLogs[0]!.msg).toContain('Missing required config keys');
			expect(errorLogs[0]!.msg).toContain('REQUIRED_KEY_1');
			expect(errorLogs[0]!.msg).toContain('REQUIRED_KEY_2');
		});

		test('should send config validation success to configured transport', async () => {
			const collector = createCollectorTransport();

			// Use async: false for synchronous writes in tests
			Logger.configure({ transports: [collector], async: false });

			const provider = createMockConfigProvider({
				KEY_1: 'value1',
				KEY_2: 'value2'
			});

			const config = new ValidatedConfig(provider).expectKeys('KEY_1', 'KEY_2').onFail('error');

			await config.validate();

			// Should have logged success
			const infoLogs = collector.logs.filter((log) => log.level === 20); // info level
			expect(infoLogs.length).toBe(1);
			expect(infoLogs[0]!.msg).toContain('Config Validated');
			expect(infoLogs[0]!.msg).toContain('2 expected keys present');
		});

		test('should buffer config validation logs and flush to configured transport', async () => {
			// Simulate real app startup: config validation runs BEFORE Logger.configure()
			const provider = createMockConfigProvider({
				EXISTING: 'value'
				// Missing: MISSING_KEY
			});

			const config = new ValidatedConfig(provider).expectKeys('EXISTING', 'MISSING_KEY').onFail('warn');

			// Validate BEFORE configuring logger - logs get buffered
			await config.validate();

			// Now configure logger - buffered logs should flush
			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector] });

			// Should have received the buffered validation error
			const warnLogs = collector.logs.filter((log) => log.level === 30);
			expect(warnLogs.length).toBe(1);
			expect(warnLogs[0]!.msg).toContain('MISSING_KEY');
			expect(warnLogs[0]!.name).toBe('Config');
		});

		test('should not crash when warn mode and missing keys', async () => {
			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector], async: false });

			const provider = createMockConfigProvider({
				EXISTING: 'value'
				// Missing: MISSING_KEY
			});

			const config = new ValidatedConfig(provider).expectKeys('EXISTING', 'MISSING_KEY').onFail('warn');

			// Should not throw
			await config.validate();

			// App continues, can still access existing keys
			const value = await config.get('EXISTING');
			expect(value).toBe('value');

			// Missing key returns undefined (not throw)
			const missing = await config.get('MISSING_KEY');
			expect(missing).toBeUndefined();
		});

		test('getRequired should throw for missing key even in warn mode', async () => {
			const provider = createMockConfigProvider({
				EXISTING: 'value'
			});

			const config = new ValidatedConfig(provider).expectKeys('EXISTING', 'MISSING_KEY').onFail('warn');

			// Validation passes in warn mode (logs warning but doesn't throw)
			await config.validate();

			// But getRequired always throws for missing keys - use get() for optional values
			await expect(config.getRequired('MISSING_KEY')).rejects.toThrow();
		});

		test('getRequired should throw for unexpected missing key in warn mode', async () => {
			const provider = createMockConfigProvider({
				EXISTING: 'value'
			});

			const config = new ValidatedConfig(provider).expectKeys('EXISTING').onFail('warn');

			await config.validate();

			// Key not in expectedKeys, so getRequired should still throw
			await expect(config.getRequired('UNEXPECTED_KEY')).rejects.toThrow();
		});

		test('getRequired should throw for missing key in error mode', async () => {
			const provider = createMockConfigProvider({
				EXISTING: 'value'
			});

			// Use a custom logger to avoid process.exit
			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector], async: false });

			const config = new ValidatedConfig(provider).expectKeys('EXISTING').onFail('error');

			await config.validate();

			// Key not validated, so getRequired should throw
			await expect(config.getRequired('MISSING_KEY')).rejects.toThrow();
		});
	});

	describe('buffer parse errors', () => {
		test('should log parse errors to stderr when buffer contains invalid JSON', async () => {
			// Verifies that parse errors are reported to stderr when flushing
			// corrupted buffer content (rather than silently swallowing errors)

			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector], async: true });

			const logger = new Logger('TestService');
			logger.info('Valid message');

			// Manually corrupt the buffer by accessing the internal logBuffer
			// We need to import and manipulate it directly
			const { logBuffer } = await import('../src/log-buffer.ts');

			// Write some corrupted data directly to the buffer
			// We do this by calling write() which adds JSON, then manually appending garbage
			(logBuffer as any).buffer += 'not valid json\n';

			// Capture stderr output
			const originalStderrWrite = process.stderr.write;
			const stderrOutput: string[] = [];
			process.stderr.write = (data: string | Uint8Array): boolean => {
				if (typeof data === 'string') {
					stderrOutput.push(data);
				}
				return true;
			};

			try {
				// Flush the buffer - this should trigger the parse error handling
				Logger.flush();

				// Valid log should have been written to collector
				expect(collector.logs.length).toBe(1);
				expect(collector.logs[0]!.msg).toBe('Valid message');

				// Invalid line should have triggered stderr warning
				expect(stderrOutput.length).toBe(1);
				expect(stderrOutput[0]).toContain('[ori-logger] Buffer parse error');
				expect(stderrOutput[0]).toContain('not valid json');
			} finally {
				process.stderr.write = originalStderrWrite;
			}
		});

		test('should truncate long invalid lines in error message', async () => {
			const collector = createCollectorTransport();
			Logger.configure({ transports: [collector], async: true });

			const { logBuffer } = await import('../src/log-buffer.ts');

			// Write a very long invalid line (over 100 chars)
			const longInvalidLine = 'x'.repeat(200);
			(logBuffer as any).buffer += longInvalidLine + '\n';

			const originalStderrWrite = process.stderr.write;
			const stderrOutput: string[] = [];
			process.stderr.write = (data: string | Uint8Array): boolean => {
				if (typeof data === 'string') {
					stderrOutput.push(data);
				}
				return true;
			};

			try {
				Logger.flush();

				// Should truncate the line preview to 100 chars + "..."
				expect(stderrOutput.length).toBe(1);
				expect(stderrOutput[0]).toContain('[ori-logger] Buffer parse error');
				// The "Line:" part should be truncated with "..."
				expect(stderrOutput[0]).toMatch(/Line: x{100}\.\.\./);
			} finally {
				process.stderr.write = originalStderrWrite;
			}
		});
	});

	describe('flush before crash (no configure)', () => {
		test('should flush all pending logs before exit without configure', () => {
			// Simulate the config validation failure scenario:
			// 1. Logger is created and used before configure()
			// 2. App needs to exit (e.g., missing config keys)
			// 3. Logger.flush() is called to output buffered logs

			const logger = new Logger('Config');

			logger.info('Loading config');
			logger.error('Missing required config keys: SECRET_DB_URL');

			// Capture console.log output
			const originalLog = console.log;
			const capturedOutput: string[] = [];
			console.log = (msg: string) => capturedOutput.push(msg);

			try {
				// Flush without ever calling configure
				Logger.flush();

				// Should have flushed both messages to default transport
				expect(capturedOutput.length).toBe(2);
				expect(capturedOutput[0]).toContain('Loading config');
				expect(capturedOutput[1]).toContain('Missing required config keys: SECRET_DB_URL');
			} finally {
				console.log = originalLog;
			}
		});

		test('should flush logs with correct levels', () => {
			const logger = new Logger('TestService', { level: 'debug' });

			logger.debug('Debug msg');
			logger.info('Info msg');
			logger.warn('Warn msg');
			logger.error('Error msg');

			const originalLog = console.log;
			const capturedOutput: string[] = [];
			console.log = (msg: string) => capturedOutput.push(msg);

			try {
				Logger.flush();

				expect(capturedOutput.length).toBe(4);
				// Check message content (works with both pretty and JSON format)
				expect(capturedOutput[0]).toContain('Debug msg');
				expect(capturedOutput[1]).toContain('Info msg');
				expect(capturedOutput[2]).toContain('Warn msg');
				expect(capturedOutput[3]).toContain('Error msg');
			} finally {
				console.log = originalLog;
			}
		});

		test('should include logger name in flushed output', () => {
			const logger = new Logger('ConfigValidator');

			logger.error('Validation failed');

			const originalLog = console.log;
			const capturedOutput: string[] = [];
			console.log = (msg: string) => capturedOutput.push(msg);

			try {
				Logger.flush();

				// Check name is present (works with both pretty and JSON format)
				expect(capturedOutput[0]).toContain('ConfigValidator');
			} finally {
				console.log = originalLog;
			}
		});

		test('should include extra data in flushed output', () => {
			const logger = new Logger('Config');

			logger.info('Provider selected', { provider: 'EnvConfigProvider' });

			const originalLog = console.log;
			const capturedOutput: string[] = [];
			console.log = (msg: string) => capturedOutput.push(msg);

			try {
				Logger.flush();

				expect(capturedOutput[0]).toContain('EnvConfigProvider');
			} finally {
				console.log = originalLog;
			}
		});

		test('should clear buffer after flush', () => {
			const logger = new Logger('TestService');

			logger.info('Message');

			Logger.flush();

			// Second flush should output nothing
			const originalLog = console.log;
			const capturedOutput: string[] = [];
			console.log = (msg: string) => capturedOutput.push(msg);

			try {
				Logger.flush();
				expect(capturedOutput.length).toBe(0);
			} finally {
				console.log = originalLog;
			}
		});
	});
});
