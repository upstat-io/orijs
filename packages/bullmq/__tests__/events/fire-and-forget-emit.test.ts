/**
 * Fire-and-forget emit contract.
 *
 * `EventConfig.result` documents `Type.Void()` as the fire-and-forget marker
 * (core/src/types/event-definition.ts) and the emitter contract states such a
 * promise resolves once the event is successfully queued
 * (core/src/types/emitter.ts). The provider honours that through the
 * `expectsResult` delivery hint: when it is false, no completion entry is
 * registered and the subscription settles on the enqueue outcome alone.
 *
 * Regression: a provider that registers completion tracking for every emission
 * couples every fire-and-forget caller to consumer availability and to the
 * tracker's timeout.
 */

import { describe, expect, it, mock } from 'bun:test';

function buildMocks(addJob?: () => Promise<{ id: string }>) {
	const queueManager = {
		addJob: mock(addJob ?? (() => Promise.resolve({ id: 'job-1' }))),
		registerWorker: mock(() => {}),
		getQueue: mock(() => ({ add: mock(() => Promise.resolve({ id: 'job-1' })) })),
		getQueueName: mock((eventName: string) => `event.${eventName}`),
		stop: mock(() => Promise.resolve())
	};
	const completionTracker = {
		register: mock(() => {}),
		mapJobId: mock(() => {}),
		hasPending: mock(() => false),
		complete: mock(() => {}),
		fail: mock(() => {}),
		stop: mock(() => Promise.resolve())
	};
	const scheduledEventManager = {
		schedule: mock(() => Promise.resolve()),
		unschedule: mock(() => Promise.resolve()),
		getSchedules: mock(() => []),
		stop: mock(() => Promise.resolve())
	};
	return { queueManager, completionTracker, scheduledEventManager };
}

async function buildProvider(mocks: ReturnType<typeof buildMocks>) {
	const { BullMQEventProvider } = await import('../../src/events/bullmq-event-provider.ts');
	return new BullMQEventProvider({
		connection: { host: 'localhost', port: 6379 },
		queueManager: mocks.queueManager as never,
		completionTracker: mocks.completionTracker as never,
		scheduledEventManager: mocks.scheduledEventManager as never
	});
}

describe('fire-and-forget emit', () => {
	it('should register no completion entry when the caller expects no result', async () => {
		const mocks = buildMocks();
		const provider = await buildProvider(mocks);

		provider.emit('monitor.deleted', { monitorUuid: 'm-1' }, {}, { expectsResult: false });

		expect(mocks.completionTracker.register).toHaveBeenCalledTimes(0);
		expect(mocks.queueManager.addJob).toHaveBeenCalledTimes(1);
	});

	it('should resolve once the job is queued when no consumer ever runs', async () => {
		const mocks = buildMocks();
		const provider = await buildProvider(mocks);

		const subscription = provider.emit(
			'monitor.deleted',
			{ monitorUuid: 'm-1' },
			{},
			{ expectsResult: false }
		);

		// No completion is ever delivered; the enqueue alone must settle it.
		expect(await subscription).toBeUndefined();
	});

	it('should surface the enqueue failure when the job cannot be queued', async () => {
		const mocks = buildMocks(() => Promise.reject(new Error('queue unavailable')));
		const provider = await buildProvider(mocks);

		const subscription = provider.emit(
			'monitor.deleted',
			{ monitorUuid: 'm-1' },
			{},
			{ expectsResult: false }
		);

		// The subscription is thenable rather than a Promise; adopt it explicitly.
		await expect(Promise.resolve(subscription)).rejects.toThrow('queue unavailable');
		// The tracker registered nothing, so it cannot be the rejection path.
		expect(mocks.completionTracker.fail).toHaveBeenCalledTimes(0);
	});

	it('should ignore an explicit timeout when the caller expects no result', async () => {
		const mocks = buildMocks();
		const provider = await buildProvider(mocks);

		provider.emit(
			'monitor.deleted',
			{ monitorUuid: 'm-1' },
			{},
			{ expectsResult: false, timeout: 5000 }
		);

		expect(mocks.completionTracker.register).toHaveBeenCalledTimes(0);
	});

	it('should still register completion tracking when the caller expects a result', async () => {
		const mocks = buildMocks();
		const provider = await buildProvider(mocks);

		provider.emit('alert.evaluate', { alertUuid: 'a-1' }, {}, { expectsResult: true });

		expect(mocks.completionTracker.register).toHaveBeenCalledTimes(1);
	});

	it('should register completion tracking when no delivery hint is supplied', async () => {
		const mocks = buildMocks();
		const provider = await buildProvider(mocks);

		// Callers that predate the hint keep request-response semantics.
		provider.emit('alert.evaluate', { alertUuid: 'a-1' }, {});

		expect(mocks.completionTracker.register).toHaveBeenCalledTimes(1);
	});
});
