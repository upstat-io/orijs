/**
 * ScheduledEventManager Unit Tests
 *
 * Tests scheduled/repeatable job management using BullMQ's repeatable jobs feature.
 * Uses mocked Queue class.
 */

import { describe, it, expect, mock } from 'bun:test';

describe('ScheduledEventManager', () => {
	describe('schedule creation', () => {
		it('should create repeatable job with cron pattern', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key-1' })),
				removeRepeatableByKey: mock(() => Promise.resolve()),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			await manager.schedule('monitor.check', {
				scheduleId: 'hourly-check',
				cron: '0 * * * *', // Every hour
				payload: { monitorId: '123' }
			});

			expect(mockQueue.add).toHaveBeenCalledWith(
				'event',
				expect.objectContaining({
					payload: { monitorId: '123' }
				}),
				expect.objectContaining({
					repeat: { pattern: '0 * * * *' },
					jobId: 'hourly-check'
				})
			);
		});

		it('should create repeatable job with interval (every X ms)', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key-1' })),
				removeRepeatableByKey: mock(() => Promise.resolve()),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			await manager.schedule('health.ping', {
				scheduleId: 'health-ping',
				every: 30000, // Every 30 seconds
				payload: {}
			});

			expect(mockQueue.add).toHaveBeenCalledWith(
				'event',
				expect.objectContaining({ payload: {} }),
				expect.objectContaining({
					repeat: { every: 30000 },
					jobId: 'health-ping'
				})
			);
		});

		it('should use queue per event type', async () => {
			const queuesByName = new Map<string, any>();
			const MockQueue = mock((name: string) => {
				const q = {
					name,
					add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key' })),
					removeRepeatableByKey: mock(() => Promise.resolve()),
					on: mock(() => {}),
					close: mock(() => Promise.resolve()),
					connection: { _client: { on: mock(() => {}) } }
				};
				queuesByName.set(name, q);
				return q;
			});

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			await manager.schedule('monitor.check', {
				scheduleId: 'check-1',
				every: 60000,
				payload: {}
			});

			await manager.schedule('alert.cleanup', {
				scheduleId: 'cleanup-1',
				cron: '0 0 * * *', // Daily
				payload: {}
			});

			expect(MockQueue).toHaveBeenCalledTimes(2);
			expect(queuesByName.get('scheduled.monitor.check')).toBeDefined();
			expect(queuesByName.get('scheduled.alert.cleanup')).toBeDefined();
		});
	});

	describe('schedule removal', () => {
		it('should remove scheduled job by scheduleId', async () => {
			let repeatJobKey = '';
			const mockQueue = {
				add: mock(() => {
					repeatJobKey = `repeat:scheduled:monitor.check:check-123:::30000`;
					return Promise.resolve({ id: 'job-1', repeatJobKey });
				}),
				removeRepeatableByKey: mock(() => Promise.resolve()),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			await manager.schedule('monitor.check', {
				scheduleId: 'check-123',
				every: 30000,
				payload: {}
			});

			await manager.unschedule('monitor.check', 'check-123');

			expect(mockQueue.removeRepeatableByKey).toHaveBeenCalledWith(repeatJobKey);
		});

		it('should handle removal of non-existent schedule gracefully', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key' })),
				removeRepeatableByKey: mock(() => Promise.resolve()),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			// Should not throw
			await manager.unschedule('monitor.check', 'non-existent');

			// Should not have called removeRepeatableByKey since no schedule exists
			expect(mockQueue.removeRepeatableByKey).not.toHaveBeenCalled();
		});
	});

	describe('schedule listing', () => {
		it('should return all active schedules for an event type', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key' })),
				removeRepeatableByKey: mock(() => Promise.resolve()),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			await manager.schedule('monitor.check', {
				scheduleId: 'check-1',
				every: 30000,
				payload: { monitor: 'a' }
			});

			await manager.schedule('monitor.check', {
				scheduleId: 'check-2',
				cron: '0 * * * *',
				payload: { monitor: 'b' }
			});

			const schedules = manager.getSchedules('monitor.check');

			expect(schedules.length).toBe(2);
			expect(schedules.find((s) => s.scheduleId === 'check-1')).toBeDefined();
			expect(schedules.find((s) => s.scheduleId === 'check-2')).toBeDefined();
		});

		it('should return empty array for event type with no schedules', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key' })),
				removeRepeatableByKey: mock(() => Promise.resolve()),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			const schedules = manager.getSchedules('unknown.event');
			expect(schedules).toEqual([]);
		});
	});

	describe('lifecycle', () => {
		it('should close all queues on stop', async () => {
			const mockQueues: any[] = [];
			const MockQueue = mock(() => {
				const q = {
					add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key' })),
					removeRepeatableByKey: mock(() => Promise.resolve()),
					on: mock(() => {}),
					close: mock(() => Promise.resolve()),
					connection: { _client: { on: mock(() => {}) } }
				};
				mockQueues.push(q);
				return q;
			});

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			await manager.schedule('event.a', { scheduleId: 'a', every: 1000, payload: {} });
			await manager.schedule('event.b', { scheduleId: 'b', every: 1000, payload: {} });

			await manager.stop();

			expect(mockQueues.length).toBe(2);
			for (const q of mockQueues) {
				expect(q.close).toHaveBeenCalledTimes(1);
			}
		});
	});

	describe('validation', () => {
		it('should require either cron or every', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key' })),
				removeRepeatableByKey: mock(() => Promise.resolve()),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			await expect(
				manager.schedule('event.test', {
					scheduleId: 'test',
					payload: {}
					// Missing both cron and every
				} as any)
			).rejects.toThrow('Either cron or every must be specified');
		});

		it('should not allow both cron and every', async () => {
			const mockQueue = {
				add: mock(() => Promise.resolve({ id: 'job-1', repeatJobKey: 'repeat-key' })),
				removeRepeatableByKey: mock(() => Promise.resolve()),
				on: mock(() => {}),
				close: mock(() => Promise.resolve()),
				connection: { _client: { on: mock(() => {}) } }
			};
			const MockQueue = mock(() => mockQueue);

			const { ScheduledEventManager } = await import('../../src/events/scheduled-event-manager.ts');
			const manager = new ScheduledEventManager({
				connection: { host: 'localhost', port: 6379 },
				QueueClass: MockQueue as any
			});

			await expect(
				manager.schedule('event.test', {
					scheduleId: 'test',
					payload: {},
					cron: '0 * * * *',
					every: 60000
				} as any)
			).rejects.toThrow('Cannot specify both cron and every');
		});
	});
});
