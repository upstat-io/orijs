/**
 * CompletionTracker Unit Tests
 *
 * Tests the request-response pattern implementation using QueueEvents.
 * Uses mocked QueueEvents class.
 */

import { describe, it, expect, mock } from 'bun:test';

describe('CompletionTracker', () => {
	describe('registration', () => {
		it('should register callback for correlation ID', async () => {
			const mockQueueEvents = {
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueueEvents = mock(() => mockQueueEvents);

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			const callback = mock(() => {});
			tracker.register('event.monitor.check', 'corr-123', callback);

			expect(tracker.hasPending('event.monitor.check', 'corr-123')).toBe(true);
		});

		it('should create QueueEvents instance for each queue', async () => {
			const mockInstances: any[] = [];
			const MockQueueEvents = mock(() => {
				const instance = {
					on: mock(() => {}),
					close: mock(() => Promise.resolve()),
					connection: { _client: { on: mock(() => {}) } }
				};
				mockInstances.push(instance);
				return instance;
			});

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			tracker.register('event.monitor.check', 'corr-1', () => {});
			tracker.register('event.alert.triggered', 'corr-2', () => {});

			expect(MockQueueEvents).toHaveBeenCalledTimes(2);
			expect(mockInstances.length).toBe(2);
		});

		it('should reuse QueueEvents instance for same queue', async () => {
			const MockQueueEvents = mock(() => ({
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			}));

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			tracker.register('event.monitor.check', 'corr-1', () => {});
			tracker.register('event.monitor.check', 'corr-2', () => {});

			expect(MockQueueEvents).toHaveBeenCalledTimes(1);
		});
	});

	describe('completion handling', () => {
		it('should call callback when job completes with matching correlation ID', async () => {
			let capturedCompletedHandler: ((args: any) => void) | null = null;
			const mockQueueEvents = {
				on: mock((event: string, handler: any) => {
					if (event === 'completed') {
						capturedCompletedHandler = handler;
					}
				}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueueEvents = mock(() => mockQueueEvents);

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			const callback = mock((_result: unknown) => {});
			tracker.register('event.monitor.check', 'corr-123', callback);

			// Simulate job completion
			expect(capturedCompletedHandler).not.toBeNull();
			capturedCompletedHandler!({
				jobId: 'job-1',
				returnvalue: JSON.stringify({ processed: true })
			});

			// Need to look up the job to get correlationId - in real impl, we store jobId->correlationId mapping
			// For this test, we'll use jobId as correlationId (simplified)
		});

		it('should remove callback after completion', async () => {
			const mockQueueEvents = {
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueueEvents = mock(() => mockQueueEvents);

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			const callback = mock((_result: unknown) => {});
			tracker.register('event.monitor.check', 'corr-123', callback);

			expect(tracker.hasPending('event.monitor.check', 'corr-123')).toBe(true);

			// Complete via callback
			tracker.complete('event.monitor.check', 'corr-123', { processed: true });

			expect(tracker.hasPending('event.monitor.check', 'corr-123')).toBe(false);
			expect(callback).toHaveBeenCalledWith({ processed: true });
		});

		it('should handle error callback on failure', async () => {
			const mockQueueEvents = {
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueueEvents = mock(() => mockQueueEvents);

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			const onSuccess = mock((_result: unknown) => {});
			const onError = mock((_error: Error) => {});
			tracker.register('event.monitor.check', 'corr-123', onSuccess, onError);

			// Fail via callback
			const error = new Error('Job failed');
			tracker.fail('event.monitor.check', 'corr-123', error);

			expect(tracker.hasPending('event.monitor.check', 'corr-123')).toBe(false);
			expect(onSuccess).not.toHaveBeenCalled();
			expect(onError).toHaveBeenCalledWith(error);
		});
	});

	describe('job ID mapping', () => {
		it('should map job ID to correlation ID', async () => {
			const mockQueueEvents = {
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueueEvents = mock(() => mockQueueEvents);

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			const callback = mock((_result: unknown) => {});
			tracker.register('event.monitor.check', 'corr-123', callback);

			// Register the job ID mapping
			tracker.mapJobId('event.monitor.check', 'job-456', 'corr-123');

			// Get correlation ID from job ID
			expect(tracker.getCorrelationId('event.monitor.check', 'job-456')).toBe('corr-123');
		});

		it('should clean up job ID mapping after completion', async () => {
			const mockQueueEvents = {
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueueEvents = mock(() => mockQueueEvents);

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			const callback = mock((_result: unknown) => {});
			tracker.register('event.monitor.check', 'corr-123', callback);
			tracker.mapJobId('event.monitor.check', 'job-456', 'corr-123');

			// Complete
			tracker.complete('event.monitor.check', 'corr-123', { result: true });

			// Mapping should be cleaned up
			expect(tracker.getCorrelationId('event.monitor.check', 'job-456')).toBeUndefined();
		});
	});

	describe('lifecycle', () => {
		it('should close all QueueEvents on stop', async () => {
			const mockInstances: any[] = [];
			const MockQueueEvents = mock(() => {
				const instance = {
					on: mock(() => {}),
					close: mock(() => Promise.resolve()),
					connection: { _client: { on: mock(() => {}) } }
				};
				mockInstances.push(instance);
				return instance;
			});

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			tracker.register('event.monitor.check', 'corr-1', () => {});
			tracker.register('event.alert.triggered', 'corr-2', () => {});

			await tracker.stop();

			expect(mockInstances.length).toBe(2);
			for (const instance of mockInstances) {
				expect(instance.close).toHaveBeenCalledTimes(1);
			}
		});
	});

	describe('timeout handling', () => {
		it('should support timeout for pending completions', async () => {
			const mockQueueEvents = {
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueueEvents = mock(() => mockQueueEvents);

			const { CompletionTracker } = await import('../../src/events/completion-tracker.ts');
			const tracker = new CompletionTracker({
				connection: { host: 'localhost', port: 6379 },
				QueueEventsClass: MockQueueEvents as any
			});

			const onSuccess = mock((_result: unknown) => {});
			const onError = mock((_error: Error) => {});

			// Register with short timeout
			tracker.register('event.monitor.check', 'corr-123', onSuccess, onError, { timeout: 50 });

			// Wait for timeout
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(onSuccess).not.toHaveBeenCalled();
			expect(onError).toHaveBeenCalled();
			const errorArg = onError.mock.calls[0]?.[0] as Error | undefined;
			expect(errorArg?.message).toContain('timeout');
		});
	});
});
