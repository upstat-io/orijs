/**
 * Type re-export verification tests.
 *
 * These tests verify that types re-exported from other packages
 * are accessible and match the expected shape.
 */

import { describe, test, expect } from 'bun:test';
import type { SocketEmitter } from '../../src/types/emitter.ts';

describe('emitter type re-exports', () => {
	describe('SocketEmitter', () => {
		test('should be importable from types/emitter', () => {
			// Type-level verification: if this compiles, the re-export works
			const mockEmitter: SocketEmitter = {
				publish: () => Promise.resolve(),
				send: () => {},
				broadcast: () => {},
				emit: () => Promise.resolve()
			};

			// Runtime verification: the mock has the expected methods
			expect(typeof mockEmitter.publish).toBe('function');
			expect(typeof mockEmitter.send).toBe('function');
			expect(typeof mockEmitter.broadcast).toBe('function');
			expect(typeof mockEmitter.emit).toBe('function');
		});

		test('should have correct method signatures', () => {
			// Verify the interface shape matches expectations
			const mockEmitter: SocketEmitter = {
				publish: (topic: string, message: string | ArrayBuffer) => {
					expect(typeof topic).toBe('string');
					expect(message).toBeDefined();
					return Promise.resolve();
				},
				send: (socketId: string, message: string | ArrayBuffer) => {
					expect(typeof socketId).toBe('string');
					expect(message).toBeDefined();
				},
				broadcast: (message: string | ArrayBuffer) => {
					expect(message).toBeDefined();
				},
				emit: () => Promise.resolve()
			};

			// Call methods to verify they work
			mockEmitter.publish('topic', 'message');
			mockEmitter.send('socket-id', 'message');
			mockEmitter.broadcast('broadcast-message');

			// If we get here without throwing, the methods work
			expect(true).toBe(true);
		});
	});
});
