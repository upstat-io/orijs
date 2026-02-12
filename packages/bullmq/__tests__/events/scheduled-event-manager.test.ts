/**
 * ScheduledEventManager Unit Tests
 *
 * Tests scheduled/repeatable job management using BullMQ's Job Scheduler API (v5).
 * Uses mocked Queue class.
 */

import { describe, it, expect, mock } from 'bun:test';

describe('ScheduledEventManager', () => {
	describe('schedule creation', () => {
		it('should create job scheduler with cron pattern', async () => {
			const mockQueue = {
				upsertJobScheduler: mock(() => Promise.resolve({})),
				removeJobScheduler: mock(() => Promise.resolve(true)),
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

			expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
				'hourly-check',
				{ pattern: '0 * * * *' },
				{
					name: 'event',
					data: expect.objectContaining({
						payload: { monitorId: '123' }
					})
				}
			);
		});

		it('should create job scheduler with interval (every X ms)', async () => {
			const mockQueue = {
				upsertJobScheduler: mock(() => Promise.resolve({})),
				removeJobScheduler: mock(() => Promise.resolve(true)),
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

			expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
				'health-ping',
				{ every: 30000 },
				{
					name: 'event',
					data: expect.objectContaining({ payload: {} })
				}
			);
		});

		it('should use queue per event type', async () => {
			const queuesByName = new Map<string, any>();
			const MockQueue = mock((name: string) => {
				const q = {
					name,
					upsertJobScheduler: mock(() => Promise.resolve({})),
					removeJobScheduler: mock(() => Promise.resolve(true)),
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
		it('should remove job scheduler by scheduleId', async () => {
			const mockQueue = {
				upsertJobScheduler: mock(() => Promise.resolve({})),
				removeJobScheduler: mock(() => Promise.resolve(true)),
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

			expect(mockQueue.removeJobScheduler).toHaveBeenCalledWith('check-123');
		});

		it('should handle removal of non-existent schedule gracefully', async () => {
			const mockQueue = {
				upsertJobScheduler: mock(() => Promise.resolve({})),
				removeJobScheduler: mock(() => Promise.resolve(true)),
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

			// Should not have called removeJobScheduler since no schedule exists
			expect(mockQueue.removeJobScheduler).not.toHaveBeenCalled();
		});
	});

	describe('schedule listing', () => {
		it('should return all active schedules for an event type', async () => {
			const mockQueue = {
				upsertJobScheduler: mock(() => Promise.resolve({})),
				removeJobScheduler: mock(() => Promise.resolve(true)),
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
				upsertJobScheduler: mock(() => Promise.resolve({})),
				removeJobScheduler: mock(() => Promise.resolve(true)),
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
					upsertJobScheduler: mock(() => Promise.resolve({})),
					removeJobScheduler: mock(() => Promise.resolve(true)),
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
				upsertJobScheduler: mock(() => Promise.resolve({})),
				removeJobScheduler: mock(() => Promise.resolve(true)),
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
				upsertJobScheduler: mock(() => Promise.resolve({})),
				removeJobScheduler: mock(() => Promise.resolve(true)),
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
