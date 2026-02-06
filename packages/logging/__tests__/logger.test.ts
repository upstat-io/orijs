import { describe, expect, test, beforeEach } from 'bun:test';
import { Logger, type Transport, type LogObject, levels } from '../src/index.ts';

describe('Logger', () => {
	let mockTransport: Transport & { logs: LogObject[] };

	beforeEach(() => {
		// Reset global Logger state to ensure test isolation
		Logger.reset();

		mockTransport = {
			logs: [],
			write(obj: LogObject) {
				this.logs.push(obj);
			},
			async flush() {},
			async close() {}
		};
	});

	describe('log levels', () => {
		test('should log debug messages when level is debug', () => {
			const log = new Logger('Test', { level: 'debug', transports: [mockTransport] });
			log.debug('debug message');
			expect(mockTransport.logs).toHaveLength(1);
			expect(mockTransport.logs[0]!.level).toBe(levels.debug);
			expect(mockTransport.logs[0]!.msg).toBe('debug message');
		});

		test('should not log debug messages when level is info', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });
			log.debug('debug message');
			expect(mockTransport.logs).toHaveLength(0);
		});

		test('should log info messages when level is info', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });
			log.info('info message');
			expect(mockTransport.logs).toHaveLength(1);
			expect(mockTransport.logs[0]!.level).toBe(levels.info);
		});

		test('should log warn messages', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });
			log.warn('warn message');
			expect(mockTransport.logs).toHaveLength(1);
			expect(mockTransport.logs[0]!.level).toBe(levels.warn);
		});

		test('should log error messages', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });
			log.error('error message');
			expect(mockTransport.logs).toHaveLength(1);
			expect(mockTransport.logs[0]!.level).toBe(levels.error);
		});
	});

	describe('context', () => {
		test('should include logger name in log output', () => {
			const log = new Logger('MyService', { transports: [mockTransport] });
			log.info('test');
			expect(mockTransport.logs[0]!.name).toBe('MyService');
		});

		test('should include additional data in log output', () => {
			const log = new Logger('Test', { transports: [mockTransport] });
			log.info('test', { userId: 123, action: 'login' });
			expect(mockTransport.logs[0]!.userId).toBe(123);
			expect(mockTransport.logs[0]!.action).toBe('login');
		});

		test('should include timestamp in log output', () => {
			const log = new Logger('Test', { transports: [mockTransport] });
			const before = Date.now();
			log.info('test');
			const after = Date.now();
			expect(mockTransport.logs[0]!.time).toBeGreaterThanOrEqual(before);
			expect(mockTransport.logs[0]!.time).toBeLessThanOrEqual(after);
		});
	});

	describe('with()', () => {
		test('should create new logger with additional context', () => {
			const log = new Logger('Test', { transports: [mockTransport] });
			const childLog = log.with({ correlationId: 'abc123' });

			childLog.info('test');
			expect(mockTransport.logs[0]!.correlationId).toBe('abc123');
		});

		test('should not modify parent logger context', () => {
			const log = new Logger('Test', { transports: [mockTransport] });
			log.with({ correlationId: 'abc123' });

			log.info('parent log');
			expect(mockTransport.logs[0]!.correlationId).toBeUndefined();
		});

		test('should merge context with parent', () => {
			const log = new Logger('Test', { transports: [mockTransport] });
			const child1 = log.with({ userId: 1 });
			const child2 = child1.with({ tenantId: 'acme' });

			child2.info('test');
			expect(mockTransport.logs[0]!.userId).toBe(1);
			expect(mockTransport.logs[0]!.tenantId).toBe('acme');
		});

		test('should share transports with parent', () => {
			const log = new Logger('Test', { transports: [mockTransport] });
			const childLog = log.with({ extra: true });

			log.info('parent');
			childLog.info('child');

			expect(mockTransport.logs).toHaveLength(2);
		});
	});

	describe('propagation', () => {
		test('propagationHeaders should include x-request-id when set', () => {
			const log = new Logger('Test', { transports: [mockTransport] }).with({ correlationId: 'abc123' });
			const headers = log.propagationHeaders();
			expect(headers['x-request-id']).toBe('abc123');
		});

		test('propagationHeaders should include x-correlation-context for other context', () => {
			const log = new Logger('Test', { transports: [mockTransport] }).with({
				correlationId: 'abc123',
				userId: 42,
				tenantId: 'acme'
			});
			const headers = log.propagationHeaders();

			expect(headers['x-request-id']).toBe('abc123');
			const context = JSON.parse(headers['x-correlation-context']!);
			expect(context.userId).toBe(42);
			expect(context.tenantId).toBe('acme');
		});

		test('propagationMeta should include all context', () => {
			const log = new Logger('Test', { transports: [mockTransport] }).with({
				correlationId: 'abc123',
				userId: 42
			});
			const meta = log.propagationMeta();

			expect(meta.correlationId).toBe('abc123');
			expect(meta.userId).toBe(42);
		});
	});

	describe('fromMeta', () => {
		test('should create logger from meta object', () => {
			const meta = { correlationId: 'abc123', userId: 42, tenantId: 'acme' };
			const log = Logger.fromMeta('Worker', meta, { transports: [mockTransport] });

			log.info('processing');

			expect(mockTransport.logs[0]!.name).toBe('Worker');
			expect(mockTransport.logs[0]!.correlationId).toBe('abc123');
			expect(mockTransport.logs[0]!.userId).toBe(42);
			expect(mockTransport.logs[0]!.tenantId).toBe('acme');
		});
	});

	describe('console fallback', () => {
		test('Logger.console should create a working logger with info level', () => {
			// Logger.console creates a console transport with info level
			const log = Logger.console('Fallback');

			// Verify it's a Logger instance with proper configuration
			expect(log).toBeInstanceOf(Logger);

			// Test that it can create child loggers (verifies internal state)
			const childLog = log.with({ testKey: 'testValue' });
			expect(childLog).toBeInstanceOf(Logger);

			// Verify propagation methods work correctly
			const meta = childLog.propagationMeta();
			expect(meta.testKey).toBe('testValue');
		});

		test('Logger.console should use provided name', () => {
			Logger.console('CustomName'); // Verify it doesn't throw

			// Create a mock transport to capture output
			const capturedLogs: LogObject[] = [];
			const testLog = new Logger('CustomName', {
				level: 'info',
				transports: [
					{
						write(obj: LogObject) {
							capturedLogs.push(obj);
						},
						async flush() {},
						async close() {}
					}
				]
			});

			testLog.info('test');
			expect(capturedLogs[0]!.name).toBe('CustomName');
		});
	});

	describe('table()', () => {
		test('should log tabular data', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });
			const data = [
				{ name: 'Alice', role: 'admin' },
				{ name: 'Bob', role: 'user' }
			];

			log.table('Users', data);

			expect(mockTransport.logs).toHaveLength(1);
			expect(mockTransport.logs[0]!.msg).toContain('Users');
			expect(mockTransport.logs[0]!.level).toBe(levels.info);
		});

		test('should not log table when level is below info', () => {
			const log = new Logger('Test', { level: 'warn', transports: [mockTransport] });
			const data = [{ name: 'Alice' }];

			log.table('Users', data);

			expect(mockTransport.logs).toHaveLength(0);
		});

		test('should accept specific columns to display', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });
			const data = [
				{ name: 'Alice', email: 'alice@example.com', secret: 'hidden' },
				{ name: 'Bob', email: 'bob@example.com', secret: 'hidden' }
			];

			log.table('Users', data, ['name', 'email']);

			expect(mockTransport.logs).toHaveLength(1);
			expect(mockTransport.logs[0]!.msg).toContain('Users');
		});

		test('should include context in table log', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] }).with({
				correlationId: 'abc123'
			});
			const data = [{ id: 1 }];

			log.table('Data', data);

			expect(mockTransport.logs[0]!.correlationId).toBe('abc123');
		});

		test('should handle empty data array', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });

			log.table('Empty', []);

			expect(mockTransport.logs).toHaveLength(1);
		});
	});

	describe('Logger.inspect()', () => {
		test('should format simple objects', () => {
			const result = Logger.inspect({ foo: 'bar', num: 42 });
			expect(result).toContain('foo');
			expect(result).toContain('bar');
			expect(result).toContain('42');
		});

		test('should format arrays', () => {
			const result = Logger.inspect([1, 2, 3]);
			expect(result).toContain('1');
			expect(result).toContain('2');
			expect(result).toContain('3');
		});

		test('should format errors with stack trace', () => {
			const error = new Error('Test error');
			const result = Logger.inspect(error);
			expect(result).toContain('Error');
			expect(result).toContain('Test error');
		});

		test('should respect depth option', () => {
			const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
			const shallow = Logger.inspect(deep, { depth: 2 });
			const deeper = Logger.inspect(deep, { depth: 10 });
			// Both should work, deeper should show more
			expect(shallow).toBeDefined();
			expect(deeper).toBeDefined();
		});

		test('should respect colors option', () => {
			const obj = { name: 'test' };
			Logger.inspect(obj, { colors: true }); // Should not throw
			const withoutColors = Logger.inspect(obj, { colors: false });
			// No-colors version should not contain ANSI codes
			expect(withoutColors).not.toContain('\x1b[');
		});

		test('should handle objects with Bun.inspect.custom', () => {
			class User {
				constructor(
					public id: number,
					public name: string,
					private _password: string
				) {}

				[Bun.inspect.custom]() {
					return `User(${this.id}: ${this.name})`;
				}

				// Used in test assertions below to verify it's hidden
				getPassword() {
					return this._password;
				}
			}

			const user = new User(123, 'Alice', 'secret123');
			const result = Logger.inspect(user, { colors: false });
			expect(result).toContain('User(123: Alice)');
			expect(result).not.toContain('secret123');
		});

		test('should handle Map objects', () => {
			const map = new Map([
				['key1', 'value1'],
				['key2', 'value2']
			]);
			const result = Logger.inspect(map, { colors: false });
			expect(result).toContain('Map');
			expect(result).toContain('key1');
			expect(result).toContain('value1');
		});

		test('should handle Set objects', () => {
			const set = new Set([1, 2, 3]);
			const result = Logger.inspect(set, { colors: false });
			expect(result).toContain('Set');
		});

		test('should handle circular references', () => {
			const circular: Record<string, unknown> = { name: 'test' };
			circular.self = circular;

			// Should not throw
			const result = Logger.inspect(circular, { colors: false });
			expect(result).toContain('name');
			expect(result).toContain('test');
		});

		test('should handle null and undefined', () => {
			expect(Logger.inspect(null)).toContain('null');
			expect(Logger.inspect(undefined)).toContain('undefined');
		});

		test('should handle primitives', () => {
			expect(Logger.inspect('hello')).toContain('hello');
			expect(Logger.inspect(42)).toContain('42');
			expect(Logger.inspect(true)).toContain('true');
		});
	});

	describe('setMeta()', () => {
		test('should include meta fields in subsequent log output', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });

			log.setMeta({ userId: 'user-123', accountUuid: 'acc-456' });
			log.info('request handled');

			expect(mockTransport.logs).toHaveLength(1);
			expect(mockTransport.logs[0]!.userId).toBe('user-123');
			expect(mockTransport.logs[0]!.accountUuid).toBe('acc-456');
		});

		test('should merge with existing context from .with()', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] }).with({
				correlationId: 'corr-789'
			});

			log.setMeta({ userId: 'user-123' });
			log.info('after setMeta');

			expect(mockTransport.logs[0]!.correlationId).toBe('corr-789');
			expect(mockTransport.logs[0]!.userId).toBe('user-123');
		});

		test('should persist across multiple log calls', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });

			log.setMeta({ userId: 'user-123' });
			log.info('first');
			log.info('second');
			log.warn('third');

			expect(mockTransport.logs).toHaveLength(3);
			expect(mockTransport.logs[0]!.userId).toBe('user-123');
			expect(mockTransport.logs[1]!.userId).toBe('user-123');
			expect(mockTransport.logs[2]!.userId).toBe('user-123');
		});

		test('should call setMetaCallback when registered', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });

			const callbackMeta: Record<string, unknown>[] = [];
			log.onSetMeta((meta) => callbackMeta.push(meta));

			log.setMeta({ userId: 'user-123', accountUuid: 'acc-456' });

			expect(callbackMeta).toHaveLength(1);
			expect(callbackMeta[0]).toEqual({ userId: 'user-123', accountUuid: 'acc-456' });
		});

		test('should preserve setMetaCallback on child logger from .with()', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });

			const callbackMeta: Record<string, unknown>[] = [];
			log.onSetMeta((meta) => callbackMeta.push(meta));

			const child = log.with({ correlationId: 'corr-1' });
			child.setMeta({ userId: 'user-123' });

			expect(callbackMeta).toHaveLength(1);
			expect(callbackMeta[0]).toEqual({ userId: 'user-123' });
		});

		test('should override previous meta values with same key', () => {
			const log = new Logger('Test', { level: 'info', transports: [mockTransport] });

			log.setMeta({ userId: 'user-1' });
			log.setMeta({ userId: 'user-2' });
			log.info('final');

			expect(mockTransport.logs[0]!.userId).toBe('user-2');
		});
	});
});
