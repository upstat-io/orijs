/**
 * BullMQEventProvider Functional Tests
 *
 * Tests the composition pattern - BullMQEventProvider delegates to
 * QueueManager, CompletionTracker, and ScheduledEventManager.
 *
 * Uses mocked dependencies for isolation testing.
 */

import { describe, it, expect, mock } from 'bun:test';

describe('BullMQEventProvider', () => {
	describe('emit', () => {
		it('should emit event via QueueManager', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueue: mock(() => ({ add: mock(() => Promise.resolve({ id: 'job-1' })) })),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				hasPending: mock(() => false),
				complete: mock(() => {}),
				fail: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				schedule: mock(() => Promise.resolve()),
				unschedule: mock(() => Promise.resolve()),
				getSchedules: mock(() => []),
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.emit('monitor.check', { monitorId: '123' }, { request_id: 'req-1' });

			// Should have called addJob on QueueManager
			expect(mockQueueManager.addJob).toHaveBeenCalledTimes(1);
			expect(mockQueueManager.addJob).toHaveBeenCalledWith(
				'monitor.check',
				expect.objectContaining({
					payload: { monitorId: '123' },
					meta: { request_id: 'req-1' }
				}),
				{} // Empty options object when no delay or idempotencyKey
			);
		});

		it('should support emit with delay option', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.emit('alert.notify', { alertId: '456' }, {}, { delay: 5000 });

			expect(mockQueueManager.addJob).toHaveBeenCalledWith('alert.notify', expect.anything(), {
				delay: 5000
			});
		});

		it('should register completion tracking for request-response', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			const subscription = provider.emit<{ processed: boolean }>('monitor.check', { monitorId: '123' }, {});

			// Subscribe to result (request-response pattern)
			subscription.subscribe((_result) => {
				// Result callback
			});

			// Wait for async job addition to complete
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should have registered with CompletionTracker
			expect(mockCompletionTracker.register).toHaveBeenCalledTimes(1);
			expect(mockCompletionTracker.mapJobId).toHaveBeenCalledWith(
				'event.monitor.check',
				'job-123',
				expect.any(String)
			);
		});

		it('should clean up completion tracker when job creation fails', async () => {
			const jobCreationError = new Error('Redis connection failed');
			const mockQueueManager = {
				addJob: mock(() => Promise.reject(jobCreationError)),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				fail: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			const subscription = provider.emit('test.event', { data: 'test' }, {});

			// Wait for async job addition to fail
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should have called completionTracker.fail to clean up
			expect(mockCompletionTracker.fail).toHaveBeenCalledTimes(1);
			expect(mockCompletionTracker.fail).toHaveBeenCalledWith(
				'event.test.event',
				subscription.correlationId,
				jobCreationError
			);

			// mapJobId should NOT have been called since job creation failed
			expect(mockCompletionTracker.mapJobId).not.toHaveBeenCalled();
		});

		it('should propagate job creation error to subscription catch callback', async () => {
			const jobCreationError = new Error('Redis connection failed');
			let capturedError: Error | null = null;

			const mockQueueManager = {
				addJob: mock(() => Promise.reject(jobCreationError)),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			// Simulate real completion tracker behavior - call error callback on fail
			const mockCompletionTracker = {
				register: mock((_queueName: string, _correlationId: string, _onSuccess: any, onError: any) => {
					// Store error callback to be called when fail() is invoked
					mockCompletionTracker._errorCallback = onError;
				}),
				mapJobId: mock(() => {}),
				fail: mock((_queueName: string, _correlationId: string, error: Error) => {
					// Simulate real behavior: call stored error callback
					if (mockCompletionTracker._errorCallback) {
						mockCompletionTracker._errorCallback(error);
					}
				}),
				_errorCallback: null as ((error: Error) => void) | null,
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			const subscription = provider.emit('test.event', { data: 'test' }, {});

			// Register error callback
			subscription.catch((error) => {
				capturedError = error;
			});

			// Wait for async job addition to fail
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Error should have propagated to catch callback
			expect(capturedError).not.toBeNull();
			expect(capturedError!.message).toBe('Redis connection failed');
		});

		it('should pass default timeout to completion tracker', async () => {
			let capturedTimeout: number | undefined;

			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(
					(
						_queueName: string,
						_correlationId: string,
						_onSuccess: any,
						_onError: any,
						options?: { timeout?: number }
					) => {
						capturedTimeout = options?.timeout;
					}
				),
				mapJobId: mock(() => {}),
				fail: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.emit('test.event', { data: 'test' }, {});

			// Should have passed default timeout (30000ms)
			expect(capturedTimeout).toBe(30000);
		});

		it('should use custom default timeout from provider options', async () => {
			let capturedTimeout: number | undefined;

			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(
					(
						_queueName: string,
						_correlationId: string,
						_onSuccess: any,
						_onError: any,
						options?: { timeout?: number }
					) => {
						capturedTimeout = options?.timeout;
					}
				),
				mapJobId: mock(() => {}),
				fail: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				defaultTimeout: 60000, // Custom 60 second timeout
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.emit('test.event', { data: 'test' }, {});

			// Should have passed custom default timeout
			expect(capturedTimeout).toBe(60000);
		});

		it('should use per-emit timeout when specified in options', async () => {
			let capturedTimeout: number | undefined;

			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(
					(
						_queueName: string,
						_correlationId: string,
						_onSuccess: any,
						_onError: any,
						options?: { timeout?: number }
					) => {
						capturedTimeout = options?.timeout;
					}
				),
				mapJobId: mock(() => {}),
				fail: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				defaultTimeout: 60000, // Provider default: 60 seconds
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			// Emit with explicit timeout that overrides default
			provider.emit('test.event', { data: 'test' }, {}, { timeout: 5000 });

			// Should have passed per-emit timeout, not default
			expect(capturedTimeout).toBe(5000);
		});

		it('should allow disabling timeout with timeout: 0', async () => {
			let capturedTimeout: number | undefined;

			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(
					(
						_queueName: string,
						_correlationId: string,
						_onSuccess: any,
						_onError: any,
						options?: { timeout?: number }
					) => {
						capturedTimeout = options?.timeout;
					}
				),
				mapJobId: mock(() => {}),
				fail: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			// Emit with timeout: 0 to disable timeout
			provider.emit('test.event', { data: 'test' }, {}, { timeout: 0 });

			// Should have passed 0 (CompletionTracker treats 0 as no timeout)
			expect(capturedTimeout).toBe(0);
		});
	});

	describe('TTL (configureEvent)', () => {
		it('should store TTL via configureEvent', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				cleanJobs: mock(() => Promise.resolve([])),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.configureEvent('health.check', { ttl: 120_000 });

			// Verify TTL is used: emit should include removeOnFail
			provider.emit('health.check', { version: 1 }, {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockQueueManager.addJob).toHaveBeenCalledWith(
				'health.check',
				expect.anything(),
				expect.objectContaining({
					removeOnFail: { age: 120 }
				})
			);
		});

		it('should merge removeOnFail for TTL events in emit', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				cleanJobs: mock(() => Promise.resolve([])),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.configureEvent('short.lived', { ttl: 30_000 });

			// Emit with delay + TTL — both should be in job options
			provider.emit('short.lived', { data: 'test' }, {}, { delay: 5000 });

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockQueueManager.addJob).toHaveBeenCalledWith(
				'short.lived',
				expect.anything(),
				{
					delay: 5000,
					removeOnFail: { age: 30 }
				}
			);
		});

		it('should not add removeOnFail when no TTL configured', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				cleanJobs: mock(() => Promise.resolve([])),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			// No configureEvent call — no TTL

			provider.emit('normal.event', { data: 'test' }, {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockQueueManager.addJob).toHaveBeenCalledWith(
				'normal.event',
				expect.anything(),
				{} // No removeOnFail
			);
		});

		it('should start sweep interval when TTL events exist', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				cleanJobs: mock(() => Promise.resolve([])),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				sweepIntervalMs: 50, // Short interval for testing
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.configureEvent('ttl.event', { ttl: 60_000 });

			await provider.start();

			// Wait for at least one sweep cycle
			await new Promise((resolve) => setTimeout(resolve, 100));

			// cleanJobs should have been called for 'wait' and 'failed'
			expect(mockQueueManager.cleanJobs).toHaveBeenCalled();
			const calls = mockQueueManager.cleanJobs.mock.calls;
			const waitCalls = calls.filter((c: unknown[]) => c[3] === 'wait');
			const failedCalls = calls.filter((c: unknown[]) => c[3] === 'failed');
			expect(waitCalls.length).toBeGreaterThan(0);
			expect(failedCalls.length).toBeGreaterThan(0);

			await provider.stop();
		});

		it('should clear sweep interval on stop', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				cleanJobs: mock(() => Promise.resolve([])),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				sweepIntervalMs: 50,
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.configureEvent('ttl.event', { ttl: 60_000 });

			await provider.start();
			await provider.stop();

			// Record call count after stop
			const callCountAfterStop = mockQueueManager.cleanJobs.mock.calls.length;

			// Wait to verify no more sweep calls happen
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(mockQueueManager.cleanJobs.mock.calls.length).toBe(callCountAfterStop);
		});
	});

	describe('subscribe', () => {
		it('should register handler via QueueManager', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			const handler = mock(async (_msg: any) => {
				return { processed: true };
			});

			provider.subscribe('monitor.check', handler);

			expect(mockQueueManager.registerWorker).toHaveBeenCalledTimes(1);
			expect(mockQueueManager.registerWorker).toHaveBeenCalledWith('monitor.check', expect.any(Function));
		});

		it('should wrap handler to extract EventMessage from job data', async () => {
			let capturedWorkerHandler: ((job: any) => Promise<any>) | null = null;

			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock((_eventName: string, handler: any) => {
					capturedWorkerHandler = handler;
				}),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			const handler = mock(async (msg: any) => {
				return { processed: true, monitorId: msg.payload.monitorId };
			});

			provider.subscribe('monitor.check', handler);

			// Simulate job being processed
			expect(capturedWorkerHandler).not.toBeNull();
			const mockJob = {
				id: 'job-1',
				data: {
					eventName: 'monitor.check',
					payload: { monitorId: '123' },
					meta: { request_id: 'req-1' },
					correlationId: 'corr-1',
					timestamp: Date.now()
				}
			};

			const result = await capturedWorkerHandler!(mockJob);

			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({
					eventName: 'monitor.check',
					payload: { monitorId: '123' },
					meta: { request_id: 'req-1' },
					correlationId: 'corr-1'
				})
			);
			expect(result).toEqual({ processed: true, monitorId: '123' });
		});
	});

	describe('scheduleEvent', () => {
		it('should delegate to ScheduledEventManager', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				schedule: mock(() => Promise.resolve()),
				unschedule: mock(() => Promise.resolve()),
				getSchedules: mock(() => []),
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			await provider.scheduleEvent('monitor.check', {
				scheduleId: 'hourly-check',
				cron: '0 * * * *',
				payload: { checkAll: true }
			});

			expect(mockScheduledManager.schedule).toHaveBeenCalledWith('monitor.check', {
				scheduleId: 'hourly-check',
				cron: '0 * * * *',
				payload: { checkAll: true }
			});
		});

		it('should support unschedule', async () => {
			const mockQueueManager = {
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				schedule: mock(() => Promise.resolve()),
				unschedule: mock(() => Promise.resolve()),
				getSchedules: mock(() => []),
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			await provider.unscheduleEvent('monitor.check', 'hourly-check');

			expect(mockScheduledManager.unschedule).toHaveBeenCalledWith('monitor.check', 'hourly-check');
		});
	});

	describe('lifecycle', () => {
		it('should start all components', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			await provider.start();

			expect(provider.isStarted()).toBe(true);
		});

		it('should stop all components in correct order', async () => {
			const stopOrder: string[] = [];

			const mockQueueManager = {
				stop: mock(() => {
					stopOrder.push('queueManager');
					return Promise.resolve();
				})
			};

			const mockCompletionTracker = {
				stop: mock(() => {
					stopOrder.push('completionTracker');
					return Promise.resolve();
				})
			};

			const mockScheduledManager = {
				stop: mock(() => {
					stopOrder.push('scheduledManager');
					return Promise.resolve();
				})
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			await provider.start();
			await provider.stop();

			// Queue manager (workers) stops first, then completion tracker, then scheduled manager
			expect(stopOrder).toEqual(['queueManager', 'completionTracker', 'scheduledManager']);
			expect(provider.isStarted()).toBe(false);
		});
	});

	describe('default construction', () => {
		it('should create default components when not provided', async () => {
			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');

			// Should not throw when creating with just connection
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 }
			});

			expect(provider).toBeDefined();
		});
	});

	describe('idempotency', () => {
		it('should pass idempotencyKey as jobId to QueueManager', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			const idempotencyKey = 'unique-event-key-123';
			provider.emit('order.created', { orderId: '456' }, {}, { idempotencyKey });

			// Should have passed idempotencyKey as jobId in job options
			expect(mockQueueManager.addJob).toHaveBeenCalledWith('order.created', expect.anything(), {
				jobId: idempotencyKey
			});
		});

		it('should combine idempotencyKey with delay in job options', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			const idempotencyKey = 'unique-key';
			provider.emit(
				'order.created',
				{ orderId: '789' },
				{},
				{
					idempotencyKey,
					delay: 5000
				}
			);

			// Should have both jobId and delay in options
			expect(mockQueueManager.addJob).toHaveBeenCalledWith('order.created', expect.anything(), {
				jobId: idempotencyKey,
				delay: 5000
			});
		});

		it('should not pass jobId when no idempotencyKey provided', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			provider.emit('order.created', { orderId: '456' }, {});

			// Job options should be empty object (no jobId)
			expect(mockQueueManager.addJob).toHaveBeenCalledWith('order.created', expect.anything(), {});
		});

		it('should pass empty object when only delay is 0', async () => {
			const mockQueueManager = {
				addJob: mock(() => Promise.resolve({ id: 'job-123' })),
				registerWorker: mock(() => {}),
				getQueueName: mock((eventName: string) => `event.${eventName}`),
				stop: mock(() => Promise.resolve())
			};

			const mockCompletionTracker = {
				register: mock(() => {}),
				mapJobId: mock(() => {}),
				stop: mock(() => Promise.resolve())
			};

			const mockScheduledManager = {
				stop: mock(() => Promise.resolve())
			};

			const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
			const provider = new BullMQEventProvider({
				connection: { host: 'localhost', port: 6379 },
				queueManager: mockQueueManager as any,
				completionTracker: mockCompletionTracker as any,
				scheduledEventManager: mockScheduledManager as any
			});

			// delay: 0 should not be included (falsy)
			provider.emit('order.created', { orderId: '456' }, {}, { delay: 0 });

			expect(mockQueueManager.addJob).toHaveBeenCalledWith('order.created', expect.anything(), {});
		});
	});
});
