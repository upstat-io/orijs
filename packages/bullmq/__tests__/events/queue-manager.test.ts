/**
 * QueueManager Unit Tests
 *
 * Tests the queue management logic (per-event-type queue creation, worker registration).
 * Uses mocked BullMQ Queue/Worker classes.
 */

import { describe, it, expect, mock } from 'bun:test';

describe('QueueManager', () => {
	describe('queue creation', () => {
		it('should create queue with event-type naming convention', async () => {
			// Mock BullMQ Queue class
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1' })),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			// Get queue for an event type
			manager.getQueue('monitor.check');

			expect(MockQueue).toHaveBeenCalledTimes(1);
			expect(MockQueue).toHaveBeenCalledWith(
				'event.monitor.check',
				expect.objectContaining({
					connection: { host: 'localhost', port: 6379 }
				})
			);
		});

		it('should reuse existing queue for same event type', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1' })),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			// Get same queue twice
			const queue1 = manager.getQueue('monitor.check');
			const queue2 = manager.getQueue('monitor.check');

			expect(MockQueue).toHaveBeenCalledTimes(1);
			expect(queue1).toBe(queue2);
		});

		it('should create separate queues for different event types', async () => {
			const mockQueues: any[] = [];
			const MockQueue = mock(() => {
				const q = {
					add: mock(() => Promise.resolve({ id: `job-${mockQueues.length}` })),
					on: mock(() => {}),
					close: mock(() => Promise.resolve()),
					connection: { _client: { on: mock(() => {}) } },
					blockingConnection: { _client: { on: mock(() => {}) } }
				};
				mockQueues.push(q);
				return q;
			});

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			const queue1 = manager.getQueue('monitor.check');
			const queue2 = manager.getQueue('alert.triggered');

			expect(MockQueue).toHaveBeenCalledTimes(2);
			expect(queue1).not.toBe(queue2);
		});
	});

	describe('worker registration', () => {
		it('should create worker with correct queue name', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1' })),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const mockWorker = {
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				waitUntilReady: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockWorker = mock(() => mockWorker);

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any,
				WorkerClass: MockWorker as any
			});

			const handler = mock(async () => {});
			await manager.registerWorker('monitor.check', handler);

			expect(MockWorker).toHaveBeenCalledTimes(1);
			expect(MockWorker).toHaveBeenCalledWith(
				'event.monitor.check',
				expect.any(Function),
				expect.objectContaining({
					connection: { host: 'localhost', port: 6379 }
				})
			);
		});

		it('should call handler when job is processed', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1' })),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			let capturedProcessor: ((job: any) => Promise<any>) | null = null;
			const mockWorker = {
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				waitUntilReady: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockWorker = mock((_queueName: string, processor: any) => {
				capturedProcessor = processor;
				return mockWorker;
			});

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any,
				WorkerClass: MockWorker as any
			});

			const handler = mock(async (_job: any) => ({ processed: true }));
			await manager.registerWorker('monitor.check', handler);

			// Simulate job processing
			expect(capturedProcessor).not.toBeNull();
			const mockJob = { id: 'job-1', data: { payload: { test: true } } };
			const result = await capturedProcessor!(mockJob);

			expect(handler).toHaveBeenCalledWith(mockJob);
			expect(result).toEqual({ processed: true });
		});
	});

	describe('lifecycle', () => {
		it('should close all queues and workers on stop', async () => {
			const mockQueues: any[] = [];
			const mockWorkers: any[] = [];

			const MockQueue = mock(() => {
				const q = {
					add: mock(() => Promise.resolve({ id: 'job-1' })),
					on: mock(() => {}),
					close: mock(() => Promise.resolve()),
					connection: { _client: { on: mock(() => {}) } },
					blockingConnection: { _client: { on: mock(() => {}) } }
				};
				mockQueues.push(q);
				return q;
			});

			const MockWorker = mock(() => {
				const w = {
					on: mock(() => {}),
					close: mock(() => Promise.resolve()),
					waitUntilReady: mock(() => Promise.resolve()),
					connection: { _client: { on: mock(() => {}) } },
					blockingConnection: { _client: { on: mock(() => {}) } }
				};
				mockWorkers.push(w);
				return w;
			});

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any,
				WorkerClass: MockWorker as any
			});

			// Create some queues and workers
			manager.getQueue('monitor.check');
			manager.getQueue('alert.triggered');
			await manager.registerWorker('monitor.check', async () => {});
			await manager.registerWorker('alert.triggered', async () => {});

			// Stop the manager
			await manager.stop();

			// Verify all were closed
			expect(mockQueues.length).toBe(2);
			expect(mockWorkers.length).toBe(2);
			for (const q of mockQueues) {
				expect(q.close).toHaveBeenCalledTimes(1);
			}
			for (const w of mockWorkers) {
				expect(w.close).toHaveBeenCalledTimes(1);
			}
		});
	});

	describe('job submission', () => {
		it('should add job to queue with correct data and default retry options', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-123' })),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			const jobData = {
				payload: { monitorId: '123' },
				meta: { request_id: 'req-1' },
				correlationId: 'corr-1'
			};

			const job = await manager.addJob('monitor.check', jobData);

			// Should include default retry configuration
			expect(mockQueue.add).toHaveBeenCalledWith('event', jobData, {
				attempts: 3,
				backoff: { type: 'exponential', delay: 1000 }
			});
			expect(job.id).toBe('job-123');
		});

		it('should merge job options with default retry options', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-123' })),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			const jobData = { payload: {} };
			const jobOptions = { delay: 5000 };

			await manager.addJob('monitor.check', jobData, jobOptions);

			// Should include both delay and default retry options
			expect(mockQueue.add).toHaveBeenCalledWith('event', jobData, {
				attempts: 3,
				backoff: { type: 'exponential', delay: 1000 },
				delay: 5000
			});
		});

		it('should allow overriding default retry options', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-123' })),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } },
				blockingConnection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { QueueManager } = await import('../../src/events/queue-manager.ts');
			const manager = new QueueManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any,
				defaultRetry: { attempts: 5, backoffType: 'fixed', backoffDelay: 2000 }
			});

			const jobData = { payload: {} };
			await manager.addJob('monitor.check', jobData);

			expect(mockQueue.add).toHaveBeenCalledWith('event', jobData, {
				attempts: 5,
				backoff: { type: 'fixed', delay: 2000 }
			});
		});
	});
});
