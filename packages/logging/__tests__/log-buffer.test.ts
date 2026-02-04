import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
	logBuffer,
	DEFAULT_FLUSH_INTERVAL,
	DEFAULT_BUFFER_SIZE,
	MAX_WRITE_SIZE,
	MAX_BUFFER_SIZE
} from '../src/log-buffer.ts';
import type { LogObject, Transport } from '../src/types';

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

function createLogObject(msg: string): LogObject {
	return {
		level: 20,
		time: Date.now(),
		msg,
		name: 'TestLogger'
	};
}

describe('LogBufferManager', () => {
	beforeEach(() => {
		logBuffer.reset();
	});

	afterEach(() => {
		logBuffer.reset();
	});

	describe('default constants', () => {
		test('should export correct default flush interval', () => {
			expect(DEFAULT_FLUSH_INTERVAL).toBe(10);
		});

		test('should export correct default buffer size', () => {
			expect(DEFAULT_BUFFER_SIZE).toBe(4096);
		});

		test('should export correct max write size', () => {
			expect(MAX_WRITE_SIZE).toBe(16 * 1024);
		});

		test('should export correct max buffer size', () => {
			expect(MAX_BUFFER_SIZE).toBe(1024 * 1024); // 1MB
		});
	});

	describe('configure()', () => {
		test('should enable buffering by default', () => {
			logBuffer.configure({});
			expect(logBuffer.isEnabled()).toBe(true);
		});

		test('should disable buffering when enabled is false', () => {
			logBuffer.configure({ enabled: false });
			expect(logBuffer.isEnabled()).toBe(false);
		});

		test('should re-enable buffering after being disabled', () => {
			logBuffer.configure({ enabled: false });
			expect(logBuffer.isEnabled()).toBe(false);

			logBuffer.configure({ enabled: true });
			expect(logBuffer.isEnabled()).toBe(true);
		});
	});

	describe('write()', () => {
		test('should buffer log when enabled', () => {
			logBuffer.configure({ enabled: true });

			const result = logBuffer.write(createLogObject('test message'));

			expect(result).toBe(true);
		});

		test('should return false when buffering is disabled', () => {
			logBuffer.configure({ enabled: false });

			const result = logBuffer.write(createLogObject('test message'));

			expect(result).toBe(false);
		});

		test('should start timer lazily on first write', () => {
			// Configure without starting timer implicitly
			logBuffer.reset();
			logBuffer.configure({ enabled: true });

			// Write should start the timer and buffer
			const result = logBuffer.write(createLogObject('lazy start'));

			expect(result).toBe(true);
		});
	});

	describe('flush()', () => {
		test('should flush buffered logs to transport', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector]);

			logBuffer.write(createLogObject('message 1'));
			logBuffer.write(createLogObject('message 2'));

			logBuffer.flush();

			expect(collector.logs.length).toBe(2);
			expect(collector.logs[0]!.msg).toBe('message 1');
			expect(collector.logs[1]!.msg).toBe('message 2');
		});

		test('should clear buffer after flush', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector]);

			logBuffer.write(createLogObject('first'));
			logBuffer.flush();

			// Flush again - should have nothing new
			logBuffer.flush();

			expect(collector.logs.length).toBe(1);
		});

		test('should do nothing when buffer is empty', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector]);

			logBuffer.flush();

			expect(collector.logs.length).toBe(0);
		});

		test('should handle concurrent flush attempts gracefully', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector]);

			logBuffer.write(createLogObject('concurrent test'));

			// Multiple flush calls should not duplicate logs
			logBuffer.flush();
			logBuffer.flush();
			logBuffer.flush();

			expect(collector.logs.length).toBe(1);
		});

		test('should use default console transport when no resolver configured', () => {
			logBuffer.configure({ enabled: true });
			// No transport resolver set

			logBuffer.write(createLogObject('default transport'));

			// Should not throw
			expect(() => logBuffer.flush()).not.toThrow();
		});

		test('should handle transport write errors without throwing', () => {
			const errorTransport: Transport = {
				write() {
					throw new Error('Transport error');
				},
				async flush() {},
				async close() {}
			};
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [errorTransport]);

			logBuffer.write(createLogObject('error test'));

			// Should not throw
			expect(() => logBuffer.flush()).not.toThrow();
		});

		test('should handle invalid JSON in buffer gracefully', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector]);

			// Write valid log
			logBuffer.write(createLogObject('valid'));

			// Flush should not throw even if there are parse issues
			expect(() => logBuffer.flush()).not.toThrow();
			expect(collector.logs.length).toBe(1);
		});
	});

	describe('auto-flush on buffer size threshold', () => {
		test('should auto-flush when buffer exceeds threshold', () => {
			const collector = createCollectorTransport();
			// Set a small buffer size to trigger auto-flush
			logBuffer.configure({ enabled: true, bufferSize: 100 });
			logBuffer.setTransportResolver(() => [collector]);

			// Write enough data to exceed threshold
			const largeMessage = 'x'.repeat(150);
			logBuffer.write(createLogObject(largeMessage));

			// Should have auto-flushed
			expect(collector.logs.length).toBe(1);
			expect(collector.logs[0]!.msg).toBe(largeMessage);
		});
	});

	describe('reset()', () => {
		test('should clear buffer without flushing', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector]);

			logBuffer.write(createLogObject('will be discarded'));

			logBuffer.reset();

			// Collector should have nothing - reset discards without flushing
			expect(collector.logs.length).toBe(0);
		});

		test('should reset enabled state to true', () => {
			logBuffer.configure({ enabled: false });
			expect(logBuffer.isEnabled()).toBe(false);

			logBuffer.reset();

			expect(logBuffer.isEnabled()).toBe(true);
		});
	});

	describe('shutdown()', () => {
		test('should flush remaining logs on shutdown', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector]);

			logBuffer.write(createLogObject('shutdown message'));

			logBuffer.shutdown();

			expect(collector.logs.length).toBe(1);
			expect(collector.logs[0]!.msg).toBe('shutdown message');
		});

		test('should stop timer on shutdown', () => {
			logBuffer.configure({ enabled: true, flushInterval: 100 });

			logBuffer.shutdown();

			// After shutdown, writes should still work if re-enabled
			logBuffer.configure({ enabled: true });
			expect(logBuffer.isEnabled()).toBe(true);
		});
	});

	describe('setTransportResolver()', () => {
		test('should use provided transport resolver during flush', () => {
			const collector1 = createCollectorTransport();
			const collector2 = createCollectorTransport();

			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector1, collector2]);

			logBuffer.write(createLogObject('multi-transport'));
			logBuffer.flush();

			expect(collector1.logs.length).toBe(1);
			expect(collector2.logs.length).toBe(1);
		});

		test('should fall back to default transport when resolver returns null', () => {
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => null);

			logBuffer.write(createLogObject('fallback test'));

			// Should not throw
			expect(() => logBuffer.flush()).not.toThrow();
		});

		test('should fall back to default transport when resolver returns empty array', () => {
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => []);

			logBuffer.write(createLogObject('empty array test'));

			// Should not throw
			expect(() => logBuffer.flush()).not.toThrow();
		});
	});

	describe('log object serialization', () => {
		test('should preserve all log object properties through buffer', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true });
			logBuffer.setTransportResolver(() => [collector]);

			const logObj: LogObject = {
				level: 30,
				time: 1704067200000,
				msg: 'test message',
				name: 'TestService',
				userId: 123,
				action: 'test'
			};

			logBuffer.write(logObj);
			logBuffer.flush();

			expect(collector.logs.length).toBe(1);
			expect(collector.logs[0]!.level).toBe(30);
			expect(collector.logs[0]!.time).toBe(1704067200000);
			expect(collector.logs[0]!.msg).toBe('test message');
			expect(collector.logs[0]!.name).toBe('TestService');
			expect(collector.logs[0]!.userId).toBe(123);
			expect(collector.logs[0]!.action).toBe('test');
		});
	});

	describe('buffer overflow protection', () => {
		test('should drop logs when buffer would exceed max size', () => {
			const collector = createCollectorTransport();
			// Set a very small max buffer size (500 bytes)
			logBuffer.configure({ enabled: true, maxBufferSize: 500 });
			logBuffer.setTransportResolver(() => [collector]);

			// Write a log that fits
			const smallMsg = 'a'.repeat(100);
			logBuffer.write(createLogObject(smallMsg));
			expect(logBuffer.getDroppedCount()).toBe(0);

			// Write more logs until buffer overflows
			for (let i = 0; i < 10; i++) {
				logBuffer.write(createLogObject(smallMsg));
			}

			// Some logs should have been dropped
			expect(logBuffer.getDroppedCount()).toBeGreaterThan(0);
		});

		test('should report dropped logs count via getDroppedCount()', () => {
			// Set a tiny max buffer size
			logBuffer.configure({ enabled: true, maxBufferSize: 100 });

			expect(logBuffer.getDroppedCount()).toBe(0);

			// Write logs that exceed buffer
			const msg = 'x'.repeat(50);
			logBuffer.write(createLogObject(msg)); // This fits
			logBuffer.write(createLogObject(msg)); // This might overflow
			logBuffer.write(createLogObject(msg)); // This should overflow

			expect(logBuffer.getDroppedCount()).toBeGreaterThan(0);
		});

		test('should include warning in flush when logs were dropped', () => {
			const collector = createCollectorTransport();
			// Set a tiny max buffer size
			logBuffer.configure({ enabled: true, maxBufferSize: 200 });
			logBuffer.setTransportResolver(() => [collector]);

			// Fill buffer to overflow
			const msg = 'x'.repeat(100);
			logBuffer.write(createLogObject(msg));
			logBuffer.write(createLogObject(msg));
			logBuffer.write(createLogObject(msg)); // Should overflow

			// Flush should include warning about dropped logs
			logBuffer.flush();

			// First log should be the warning
			const warningLog = collector.logs[0]!;
			expect(warningLog.name).toBe('LogBuffer');
			expect(warningLog.level).toBe(40); // WARN level
			expect(warningLog.msg).toContain('overflow');
			expect(warningLog.msg).toContain('dropped');
		});

		test('should reset dropped count after flush', () => {
			const collector = createCollectorTransport();
			logBuffer.configure({ enabled: true, maxBufferSize: 100 });
			logBuffer.setTransportResolver(() => [collector]);

			// Cause overflow
			const msg = 'x'.repeat(50);
			logBuffer.write(createLogObject(msg));
			logBuffer.write(createLogObject(msg));
			logBuffer.write(createLogObject(msg));

			const droppedBefore = logBuffer.getDroppedCount();
			expect(droppedBefore).toBeGreaterThan(0);

			// Flush should reset counter
			logBuffer.flush();

			expect(logBuffer.getDroppedCount()).toBe(0);
		});

		test('should report buffer size via getBufferSize()', () => {
			logBuffer.configure({ enabled: true });

			expect(logBuffer.getBufferSize()).toBe(0);

			logBuffer.write(createLogObject('test'));

			expect(logBuffer.getBufferSize()).toBeGreaterThan(0);
		});

		test('should reset dropped count on reset()', () => {
			logBuffer.configure({ enabled: true, maxBufferSize: 100 });

			// Cause overflow
			const msg = 'x'.repeat(150);
			logBuffer.write(createLogObject(msg));

			expect(logBuffer.getDroppedCount()).toBeGreaterThan(0);

			logBuffer.reset();

			expect(logBuffer.getDroppedCount()).toBe(0);
		});

		test('should use custom maxBufferSize from configure()', () => {
			const collector = createCollectorTransport();
			const customMaxSize = 300;
			logBuffer.configure({ enabled: true, maxBufferSize: customMaxSize });
			logBuffer.setTransportResolver(() => [collector]);

			// Write log that fits within custom limit
			const fitMsg = 'a'.repeat(100);
			logBuffer.write(createLogObject(fitMsg));
			expect(logBuffer.getDroppedCount()).toBe(0);

			// Write more to exceed custom limit
			logBuffer.write(createLogObject(fitMsg));
			logBuffer.write(createLogObject(fitMsg));
			logBuffer.write(createLogObject(fitMsg));

			// Should have dropped due to custom limit
			expect(logBuffer.getDroppedCount()).toBeGreaterThan(0);
		});
	});
});
