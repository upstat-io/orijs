/**
 * Tests for Event Provider Interface Segregation (ISP)
 *
 * Verifies that the interface hierarchy follows ISP correctly:
 * - EventEmitter: Consumer-facing (emit + subscribe only)
 * - EventLifecycle: Framework-facing (start + stop only)
 * - EventProvider: Full implementation (extends both)
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { InProcessEventProvider } from '../src/in-process-orchestrator.ts';
import { TestEventProvider } from '../src/test-event-provider.ts';
import type { EventEmitter, EventLifecycle, EventProvider } from '../src/event-provider.types.ts';
import { Logger, type PropagationMeta } from '@orijs/logging';

// Helper functions for testing interface compatibility
function useEmitter(emitter: EventEmitter): void {
	emitter.subscribe('event', async () => {});
}

function useLifecycle(lifecycle: EventLifecycle): Promise<void> {
	return lifecycle.start();
}

function useProvider(provider: EventProvider): void {
	provider.subscribe('event', async () => {});
}

describe('Event Provider Interface Segregation', () => {
	beforeEach(() => {
		Logger.reset();
	});

	describe('EventEmitter interface', () => {
		it('should allow using provider as EventEmitter', () => {
			const provider = new InProcessEventProvider();

			// Type assignment - provider can be used where EventEmitter is expected
			const emitter: EventEmitter = provider;

			expect(typeof emitter.emit).toBe('function');
			expect(typeof emitter.subscribe).toBe('function');

			// Should NOT have lifecycle methods on the interface type
			// (they exist on the object but the type doesn't expose them)
			const emitterKeys = ['emit', 'subscribe'];
			emitterKeys.forEach((key) => {
				expect(key in emitter).toBe(true);
			});
		});

		it('should emit and subscribe via EventEmitter interface', async () => {
			const provider = new InProcessEventProvider();
			const emitter: EventEmitter = provider;

			let received: unknown = null;

			emitter.subscribe('test.event', async (msg) => {
				received = msg.payload;
			});

			const meta: PropagationMeta = { correlationId: 'req-1' };
			emitter.emit('test.event', { value: 42 }, meta);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received).toEqual({ value: 42 });

			await provider.stop();
		});

		it('should support request-response via EventEmitter interface', async () => {
			const provider = new InProcessEventProvider();
			const emitter: EventEmitter = provider;

			emitter.subscribe<{ x: number }, { doubled: number }>('calc.double', async (msg) => {
				return { doubled: msg.payload.x * 2 };
			});

			let result: { doubled: number } | undefined;
			const meta: PropagationMeta = {};
			emitter.emit<{ doubled: number }>('calc.double', { x: 21 }, meta).subscribe((r) => {
				result = r;
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(result).toBeDefined();
			expect(result!.doubled).toBe(42);

			await provider.stop();
		});
	});

	describe('EventLifecycle interface', () => {
		it('should allow using provider as EventLifecycle', () => {
			const provider = new InProcessEventProvider();

			// Type assignment - provider can be used where EventLifecycle is expected
			const lifecycle: EventLifecycle = provider;

			expect(typeof lifecycle.start).toBe('function');
			expect(typeof lifecycle.stop).toBe('function');
		});

		it('should start and stop via EventLifecycle interface', async () => {
			const provider = new InProcessEventProvider();
			const lifecycle: EventLifecycle = provider;

			// Start
			await lifecycle.start();
			expect(provider.isStarted()).toBe(true);

			// Stop
			await lifecycle.stop();
			expect(provider.isStarted()).toBe(false);
		});

		it('should be idempotent for multiple start/stop calls', async () => {
			const provider = new InProcessEventProvider();
			const lifecycle: EventLifecycle = provider;

			// Multiple starts should not throw
			await lifecycle.start();
			await lifecycle.start();
			expect(provider.isStarted()).toBe(true);

			// Multiple stops should not throw
			await lifecycle.stop();
			await lifecycle.stop();
			expect(provider.isStarted()).toBe(false);
		});
	});

	describe('EventProvider interface', () => {
		it('should extend both EventEmitter and EventLifecycle', () => {
			const provider: EventProvider = new InProcessEventProvider();

			// Has EventEmitter methods
			expect(typeof provider.emit).toBe('function');
			expect(typeof provider.subscribe).toBe('function');

			// Has EventLifecycle methods
			expect(typeof provider.start).toBe('function');
			expect(typeof provider.stop).toBe('function');
		});

		it('should work with InProcessEventProvider', async () => {
			const provider: EventProvider = new InProcessEventProvider();

			let received: unknown = null;

			provider.subscribe('test.event', async (msg) => {
				received = msg.payload;
			});

			await provider.start();

			provider.emit('test.event', { data: 'test' }, {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received).toEqual({ data: 'test' });

			await provider.stop();
		});

		it('should work with TestEventProvider', async () => {
			const provider: EventProvider = new TestEventProvider({ processingDelay: 5 });

			let received: unknown = null;

			provider.subscribe('test.event', async (msg) => {
				received = msg.payload;
			});

			await provider.start();

			provider.emit('test.event', { data: 'test' }, {});

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(received).toEqual({ data: 'test' });

			await provider.stop();
		});
	});

	describe('Interface compatibility in function signatures', () => {
		it('should accept InProcessEventProvider for EventEmitter parameter', () => {
			const provider = new InProcessEventProvider();
			expect(() => useEmitter(provider)).not.toThrow();
		});

		it('should accept TestEventProvider for EventEmitter parameter', () => {
			const provider = new TestEventProvider();
			expect(() => useEmitter(provider)).not.toThrow();
		});

		it('should accept InProcessEventProvider for EventLifecycle parameter', async () => {
			const provider = new InProcessEventProvider();
			await expect(useLifecycle(provider)).resolves.toBeUndefined();
			await provider.stop();
		});

		it('should accept TestEventProvider for EventLifecycle parameter', async () => {
			const provider = new TestEventProvider();
			await expect(useLifecycle(provider)).resolves.toBeUndefined();
			await provider.stop();
		});

		it('should accept InProcessEventProvider for EventProvider parameter', () => {
			const provider = new InProcessEventProvider();
			expect(() => useProvider(provider)).not.toThrow();
		});

		it('should accept TestEventProvider for EventProvider parameter', () => {
			const provider = new TestEventProvider();
			expect(() => useProvider(provider)).not.toThrow();
		});
	});

	describe('PropagationMeta with trace fields', () => {
		it('should propagate trace context fields', async () => {
			const provider = new InProcessEventProvider();
			let receivedMeta: PropagationMeta | null = null;

			provider.subscribe('test.event', async (msg) => {
				receivedMeta = msg.meta;
			});

			const meta: PropagationMeta = {
				correlationId: 'req-123',
				traceId: 'trace-abc',
				spanId: 'span-xyz',
				parentSpanId: 'parent-123',
				userId: 'user-456',
				account_uuid: 'acc-789'
			};

			provider.emit('test.event', {}, meta);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedMeta).not.toBeNull();
			expect(receivedMeta!.correlationId).toBe('req-123');
			expect(receivedMeta!.traceId).toBe('trace-abc');
			expect(receivedMeta!.spanId).toBe('span-xyz');
			expect(receivedMeta!.parentSpanId).toBe('parent-123');
			expect(receivedMeta!.userId).toBe('user-456');
			expect(receivedMeta!.account_uuid).toBe('acc-789');

			await provider.stop();
		});
	});
});
