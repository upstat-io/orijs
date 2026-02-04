import { describe, test, expect, mock } from 'bun:test';
import { filterTransport } from '../src/transports/filter.ts';
import type { Transport, LogObject } from '../src/logger.ts';

function createMockTransport(): Transport & { logs: LogObject[] } {
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

function createLogObject(name: string, msg = 'test'): LogObject {
	return { time: Date.now(), level: 20, msg, name };
}

describe('filterTransport', () => {
	describe('includeNames', () => {
		test('should only pass logs from included names', () => {
			const inner = createMockTransport();
			const transport = filterTransport(inner, {
				includeNames: ['AuthService', 'UserService']
			});

			transport.write(createLogObject('AuthService'));
			transport.write(createLogObject('UserService'));
			transport.write(createLogObject('OtherService'));

			expect(inner.logs.length).toBe(2);
			expect(inner.logs[0]!.name).toBe('AuthService');
			expect(inner.logs[1]!.name).toBe('UserService');
		});

		test('should pass all logs when includeNames is empty', () => {
			const inner = createMockTransport();
			const transport = filterTransport(inner, {
				includeNames: []
			});

			transport.write(createLogObject('AnyService'));

			expect(inner.logs.length).toBe(1);
		});
	});

	describe('excludeNames', () => {
		test('should block logs from excluded names', () => {
			const inner = createMockTransport();
			const transport = filterTransport(inner, {
				excludeNames: ['HealthCheck', 'Metrics']
			});

			transport.write(createLogObject('AuthService'));
			transport.write(createLogObject('HealthCheck'));
			transport.write(createLogObject('Metrics'));
			transport.write(createLogObject('UserService'));

			expect(inner.logs.length).toBe(2);
			expect(inner.logs[0]!.name).toBe('AuthService');
			expect(inner.logs[1]!.name).toBe('UserService');
		});

		test('should pass all logs when excludeNames is empty', () => {
			const inner = createMockTransport();
			const transport = filterTransport(inner, {
				excludeNames: []
			});

			transport.write(createLogObject('AnyService'));

			expect(inner.logs.length).toBe(1);
		});
	});

	describe('combined filtering', () => {
		test('should apply both include and exclude filters', () => {
			const inner = createMockTransport();
			const transport = filterTransport(inner, {
				includeNames: ['AuthService', 'UserService', 'HealthCheck'],
				excludeNames: ['HealthCheck']
			});

			transport.write(createLogObject('AuthService'));
			transport.write(createLogObject('HealthCheck')); // included but also excluded
			transport.write(createLogObject('UserService'));
			transport.write(createLogObject('OtherService')); // not included

			expect(inner.logs.length).toBe(2);
			expect(inner.logs[0]!.name).toBe('AuthService');
			expect(inner.logs[1]!.name).toBe('UserService');
		});
	});

	describe('logs without name', () => {
		test('should pass logs without a name', () => {
			const inner = createMockTransport();
			const transport = filterTransport(inner, {
				includeNames: ['AuthService']
			});

			const logWithoutName: LogObject = { time: Date.now(), level: 20, msg: 'test' };
			transport.write(logWithoutName);

			expect(inner.logs.length).toBe(1);
		});
	});

	describe('flush and close', () => {
		test('should delegate flush to inner transport', async () => {
			const flushMock = mock(() => Promise.resolve());
			const closeMock = mock(() => Promise.resolve());
			const inner: Transport = {
				write: () => {},
				flush: flushMock,
				close: closeMock
			};
			const transport = filterTransport(inner, {});

			await transport.flush();

			expect(flushMock).toHaveBeenCalled();
		});

		test('should delegate close to inner transport', async () => {
			const flushMock = mock(() => Promise.resolve());
			const closeMock = mock(() => Promise.resolve());
			const inner: Transport = {
				write: () => {},
				flush: flushMock,
				close: closeMock
			};
			const transport = filterTransport(inner, {});

			await transport.close();

			expect(closeMock).toHaveBeenCalled();
		});
	});
});
