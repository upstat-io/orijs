import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { consoleTransport, fileTransport, multiTransport, type LogObject, levels } from '../src/index.ts';

const testLogDir = '/tmp/orijs-test-logs';

function createLogObject(overrides: Partial<LogObject> = {}): LogObject {
	return {
		time: Date.now(),
		level: levels.info,
		msg: 'Test message',
		name: 'Test',
		...overrides
	};
}

describe('consoleTransport', () => {
	test('should create transport with default options', () => {
		const transport = consoleTransport();
		expect(typeof transport.write).toBe('function');
	});

	test('should not throw when writing log', () => {
		const transport = consoleTransport({ json: true });
		expect(() => transport.write(createLogObject())).not.toThrow();
	});

	test('should not throw in pretty mode', () => {
		const transport = consoleTransport({ pretty: true });
		expect(() => transport.write(createLogObject())).not.toThrow();
	});

	test('should accept depth option', () => {
		const transport = consoleTransport({ pretty: true, depth: 6 });
		expect(() => transport.write(createLogObject())).not.toThrow();
	});

	test('should accept colors option', () => {
		const transport = consoleTransport({ pretty: true, colors: true });
		expect(() => transport.write(createLogObject())).not.toThrow();
	});

	test('should handle nested objects using Bun.inspect', () => {
		const transport = consoleTransport({ pretty: true, colors: false });
		const logObj = createLogObject({
			data: {
				nested: {
					deeply: {
						value: 'test',
						array: [1, 2, 3]
					}
				}
			}
		});
		expect(() => transport.write(logObj)).not.toThrow();
	});

	test('should handle circular references gracefully', () => {
		const transport = consoleTransport({ pretty: true, colors: false });
		const circular: Record<string, unknown> = { name: 'test' };
		circular.self = circular;

		const logObj = createLogObject({ data: circular });
		// Bun.inspect handles circular refs - should not throw
		expect(() => transport.write(logObj)).not.toThrow();
	});

	test('should handle error objects with enhanced formatting', () => {
		const transport = consoleTransport({ pretty: true, colors: false });
		const error = new Error('Test error message');
		const logObj = createLogObject({ error });
		expect(() => transport.write(logObj)).not.toThrow();
	});

	test('should handle err property as error object', () => {
		const transport = consoleTransport({ pretty: true, colors: false });
		const err = new Error('Another error');
		const logObj = createLogObject({ err });
		expect(() => transport.write(logObj)).not.toThrow();
	});

	test('should handle objects with Bun.inspect.custom symbol', () => {
		const transport = consoleTransport({ pretty: true, colors: false });

		class CustomInspectable {
			private _secret = 'hidden'; // Intentionally hidden by inspect.custom
			public name = 'visible';

			[Bun.inspect.custom]() {
				return `CustomInspectable(${this.name})`;
			}

			// Used to verify secret is hidden from inspect
			getSecret() {
				return this._secret;
			}
		}

		const logObj = createLogObject({ custom: new CustomInspectable() });
		expect(() => transport.write(logObj)).not.toThrow();
	});

	test('should handle Map and Set objects', () => {
		const transport = consoleTransport({ pretty: true, colors: false });
		const logObj = createLogObject({
			map: new Map([
				['key1', 'value1'],
				['key2', 'value2']
			]),
			set: new Set([1, 2, 3])
		});
		expect(() => transport.write(logObj)).not.toThrow();
	});

	test('should handle Date objects', () => {
		const transport = consoleTransport({ pretty: true, colors: false });
		const logObj = createLogObject({
			createdAt: new Date('2024-01-15T10:30:00Z')
		});
		expect(() => transport.write(logObj)).not.toThrow();
	});

	test('should handle Buffer and Uint8Array', () => {
		const transport = consoleTransport({ pretty: true, colors: false });
		const logObj = createLogObject({
			buffer: Buffer.from('hello'),
			uint8: new Uint8Array([1, 2, 3, 4, 5])
		});
		expect(() => transport.write(logObj)).not.toThrow();
	});
});

describe('fileTransport', () => {
	beforeEach(() => {
		if (!existsSync(testLogDir)) {
			mkdirSync(testLogDir, { recursive: true });
		}
	});

	afterEach(() => {
		if (existsSync(testLogDir)) {
			rmSync(testLogDir, { recursive: true, force: true });
		}
	});

	test('should create log file and write JSON', async () => {
		const logPath = `${testLogDir}/test.log`;
		const transport = fileTransport(logPath, { sync: true });

		transport.write(createLogObject({ msg: 'Test log entry' }));

		expect(existsSync(logPath)).toBe(true);
		const content = readFileSync(logPath, 'utf-8');
		expect(content).toContain('Test log entry');

		const parsed = JSON.parse(content.trim());
		expect(parsed.msg).toBe('Test log entry');
	});

	test('should append multiple logs', async () => {
		const logPath = `${testLogDir}/append.log`;
		const transport = fileTransport(logPath, { sync: true });

		transport.write(createLogObject({ msg: 'First' }));
		transport.write(createLogObject({ msg: 'Second' }));

		const content = readFileSync(logPath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(2);

		expect(JSON.parse(lines[0]!).msg).toBe('First');
		expect(JSON.parse(lines[1]!).msg).toBe('Second');
	});

	test('should flush async writes', async () => {
		const logPath = `${testLogDir}/async.log`;
		const transport = fileTransport(logPath);

		transport.write(createLogObject({ msg: 'Async log' }));

		// Wait for async flush
		await transport.flush?.();

		expect(existsSync(logPath)).toBe(true);
		const content = readFileSync(logPath, 'utf-8');
		expect(content).toContain('Async log');
	});

	test('should close transport and flush pending writes', async () => {
		const logPath = `${testLogDir}/close.log`;
		const transport = fileTransport(logPath);

		transport.write(createLogObject({ msg: 'Before close' }));

		await transport.close?.();

		expect(existsSync(logPath)).toBe(true);
		const content = readFileSync(logPath, 'utf-8');
		expect(content).toContain('Before close');
	});

	test('should create nested directories if they do not exist', async () => {
		const nestedPath = `${testLogDir}/nested/deep/path/app.log`;
		const transport = fileTransport(nestedPath, { sync: true });

		transport.write(createLogObject({ msg: 'Nested dir log' }));

		expect(existsSync(nestedPath)).toBe(true);
		const content = readFileSync(nestedPath, 'utf-8');
		expect(content).toContain('Nested dir log');
	});

	describe('size parsing', () => {
		test('should parse kb size correctly', async () => {
			const logPath = `${testLogDir}/kb-size.log`;
			// 1kb = 1024 bytes, a log line is ~100 bytes
			const transport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '1kb', keep: 2 }
			});

			// Write enough to trigger rotation (more than 1kb)
			for (let i = 0; i < 20; i++) {
				transport.write(
					createLogObject({ msg: `Message number ${i} with some extra padding to make it longer` })
				);
			}

			// Should have rotated - check for .1 file
			expect(existsSync(`${logPath}.1`)).toBe(true);
		});

		test('should parse mb size correctly', async () => {
			const logPath = `${testLogDir}/mb-size.log`;
			const transport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '1mb', keep: 2 }
			});

			// Just verify it accepts mb format without error
			transport.write(createLogObject({ msg: 'MB format test' }));
			expect(existsSync(logPath)).toBe(true);
		});

		test('should parse gb size correctly', async () => {
			const logPath = `${testLogDir}/gb-size.log`;
			const transport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '1gb', keep: 2 }
			});

			// Just verify it accepts gb format without error
			transport.write(createLogObject({ msg: 'GB format test' }));
			expect(existsSync(logPath)).toBe(true);
		});

		test('should parse plain bytes correctly', async () => {
			const logPath = `${testLogDir}/bytes-size.log`;
			const transport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '500', keep: 2 }
			});

			// Write enough to trigger rotation (more than 500 bytes)
			for (let i = 0; i < 10; i++) {
				transport.write(createLogObject({ msg: `Message ${i} with padding` }));
			}

			expect(existsSync(`${logPath}.1`)).toBe(true);
		});

		test('should throw on invalid size format', () => {
			const logPath = `${testLogDir}/invalid-size.log`;
			expect(() => {
				fileTransport(logPath, {
					sync: true,
					rotate: { size: 'invalid' }
				});
			}).toThrow('Invalid size format: invalid');
		});

		test('should throw on malformed size string', () => {
			const logPath = `${testLogDir}/malformed-size.log`;
			expect(() => {
				fileTransport(logPath, {
					sync: true,
					rotate: { size: 'abc123' }
				});
			}).toThrow('Invalid size format: abc123');
		});
	});

	describe('file rotation', () => {
		test('should rotate files when size limit is reached', async () => {
			const logPath = `${testLogDir}/rotate.log`;
			const transport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '200', keep: 3 }
			});

			// Write enough to trigger multiple rotations
			for (let i = 0; i < 30; i++) {
				transport.write(createLogObject({ msg: `Rotation test message ${i}` }));
			}

			// Check rotated files exist
			expect(existsSync(`${logPath}.1`)).toBe(true);
			expect(existsSync(`${logPath}.2`)).toBe(true);
		});

		test('should keep only specified number of rotated files', async () => {
			const logPath = `${testLogDir}/keep-limit.log`;
			const transport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '150', keep: 2 }
			});

			// Write a lot to trigger many rotations
			for (let i = 0; i < 50; i++) {
				transport.write(createLogObject({ msg: `Keep limit test ${i}` }));
			}

			// Only .1 and .2 should exist (keep: 2)
			expect(existsSync(`${logPath}.1`)).toBe(true);
			expect(existsSync(`${logPath}.2`)).toBe(true);
			// .3 should have been deleted
			expect(existsSync(`${logPath}.3`)).toBe(false);
		});

		test('should use default keep value of 5', async () => {
			const logPath = `${testLogDir}/default-keep.log`;
			const transport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '100' }
			});

			// Just verify it works with default keep
			for (let i = 0; i < 20; i++) {
				transport.write(createLogObject({ msg: `Default keep ${i}` }));
			}

			expect(existsSync(logPath)).toBe(true);
		});

		test('should shift existing rotated files correctly', async () => {
			const logPath = `${testLogDir}/shift.log`;
			const transport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '100', keep: 3 }
			});

			// First batch - will become .2 after second rotation
			transport.write(createLogObject({ msg: 'First batch' }));

			// Trigger rotation
			for (let i = 0; i < 5; i++) {
				transport.write(createLogObject({ msg: `Filler ${i} to trigger rotation` }));
			}

			// Second batch - will become .1 after third rotation
			for (let i = 0; i < 5; i++) {
				transport.write(createLogObject({ msg: `Second batch ${i}` }));
			}

			// Verify rotated files exist
			expect(existsSync(`${logPath}.1`)).toBe(true);
		});
	});

	describe('error handling', () => {
		test('should call onError callback when write fails', async () => {
			// Use a path that will fail (directory as file)
			const invalidPath = `${testLogDir}/error-test`;
			mkdirSync(invalidPath, { recursive: true });

			const errors: Error[] = [];
			const transport = fileTransport(`${invalidPath}`, {
				onError: (err) => errors.push(err)
			});

			// Write should fail because path is a directory
			transport.write(createLogObject({ msg: 'Will fail' }));

			// Wait for async flush to attempt and fail
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(errors.length).toBeGreaterThan(0);
		});

		test('should handle flush on empty buffer gracefully', async () => {
			const logPath = `${testLogDir}/empty-flush.log`;
			const transport = fileTransport(logPath);

			// Flush without writing anything
			await transport.flush?.();

			// Should not throw and file may or may not exist
			expect(true).toBe(true);
		});

		test('should batch multiple writes in async mode', async () => {
			const logPath = `${testLogDir}/batch.log`;
			const transport = fileTransport(logPath);

			// Write multiple times quickly (should be batched)
			transport.write(createLogObject({ msg: 'Batch 1' }));
			transport.write(createLogObject({ msg: 'Batch 2' }));
			transport.write(createLogObject({ msg: 'Batch 3' }));

			await transport.flush?.();

			const content = readFileSync(logPath, 'utf-8');
			const lines = content.trim().split('\n');
			expect(lines).toHaveLength(3);
		});
	});

	describe('sync vs async mode', () => {
		test('should write synchronously when sync option is true', () => {
			const logPath = `${testLogDir}/sync-mode.log`;
			const transport = fileTransport(logPath, { sync: true });

			transport.write(createLogObject({ msg: 'Sync write' }));

			// File should exist immediately after write (no need to flush)
			expect(existsSync(logPath)).toBe(true);
			const content = readFileSync(logPath, 'utf-8');
			expect(content).toContain('Sync write');
		});

		test('should write asynchronously by default', async () => {
			const logPath = `${testLogDir}/async-mode.log`;
			const transport = fileTransport(logPath);

			transport.write(createLogObject({ msg: 'Async write' }));

			// File might not exist immediately
			// Need to flush to ensure write completes
			await transport.flush?.();

			expect(existsSync(logPath)).toBe(true);
			const content = readFileSync(logPath, 'utf-8');
			expect(content).toContain('Async write');
		});
	});

	describe('existing file handling', () => {
		test('should append to existing file', async () => {
			const logPath = `${testLogDir}/existing.log`;

			// Create file with existing content
			const existingTransport = fileTransport(logPath, { sync: true });
			existingTransport.write(createLogObject({ msg: 'Existing content' }));

			// Create new transport for same file
			const newTransport = fileTransport(logPath, { sync: true });
			newTransport.write(createLogObject({ msg: 'New content' }));

			const content = readFileSync(logPath, 'utf-8');
			const lines = content.trim().split('\n');
			expect(lines).toHaveLength(2);
			expect(content).toContain('Existing content');
			expect(content).toContain('New content');
		});

		test('should track existing file size for rotation', async () => {
			const logPath = `${testLogDir}/existing-size.log`;

			// Create file with some content
			const firstTransport = fileTransport(logPath, { sync: true });
			for (let i = 0; i < 5; i++) {
				firstTransport.write(createLogObject({ msg: `Pre-existing ${i}` }));
			}

			// Create new transport with rotation - should account for existing size
			const secondTransport = fileTransport(logPath, {
				sync: true,
				rotate: { size: '500', keep: 2 }
			});

			// Write more to trigger rotation (combined with existing content)
			for (let i = 0; i < 10; i++) {
				secondTransport.write(createLogObject({ msg: `Additional ${i}` }));
			}

			// Should have rotated
			expect(existsSync(`${logPath}.1`)).toBe(true);
		});
	});
});

describe('multiTransport', () => {
	test('should write to all transports', () => {
		const logs1: LogObject[] = [];
		const logs2: LogObject[] = [];

		const transport = multiTransport([
			{ write: (obj) => logs1.push(obj), flush: async () => {}, close: async () => {} },
			{ write: (obj) => logs2.push(obj), flush: async () => {}, close: async () => {} }
		]);

		const logObj = createLogObject({ msg: 'Multi log' });
		transport.write(logObj);

		expect(logs1).toHaveLength(1);
		expect(logs2).toHaveLength(1);
		expect(logs1[0]!.msg).toBe('Multi log');
		expect(logs2[0]!.msg).toBe('Multi log');
	});

	test('should flush all transports', async () => {
		let flushed1 = false;
		let flushed2 = false;

		const transport = multiTransport([
			{
				write: () => {},
				flush: async () => {
					flushed1 = true;
				},
				close: async () => {}
			},
			{
				write: () => {},
				flush: async () => {
					flushed2 = true;
				},
				close: async () => {}
			}
		]);

		await transport.flush?.();

		expect(flushed1).toBe(true);
		expect(flushed2).toBe(true);
	});

	test('should close all transports', async () => {
		let closed1 = false;
		let closed2 = false;

		const transport = multiTransport([
			{
				write: () => {},
				flush: async () => {},
				close: async () => {
					closed1 = true;
				}
			},
			{
				write: () => {},
				flush: async () => {},
				close: async () => {
					closed2 = true;
				}
			}
		]);

		await transport.close?.();

		expect(closed1).toBe(true);
		expect(closed2).toBe(true);
	});
});
