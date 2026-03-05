import { describe, test, expect } from 'bun:test';
import { EventRegistry } from '../src/event-registry';
import { createEventSystem } from '../src/events';
import type { EventProvider, EventHandlerFn, EmitOptions } from '../src/event-provider.types';
import type { EventSubscription } from '../src/event-subscription';
import { createSubscription } from '../src/event-subscription';
import type { PropagationMeta } from '@orijs/logging';

function createMockProvider(subscribeDelay = 0): EventProvider & { subscribeCalls: string[] } {
	const subscribeCalls: string[] = [];
	return {
		subscribeCalls,
		subscribe<TPayload, TReturn>(eventName: string, _handler: EventHandlerFn<TPayload, TReturn>): Promise<void> | void {
			subscribeCalls.push(eventName);
			if (subscribeDelay > 0) {
				return new Promise((resolve) => setTimeout(resolve, subscribeDelay));
			}
		},
		emit<TReturn>(_eventName: string, _payload: unknown, _meta: PropagationMeta, _options?: EmitOptions): EventSubscription<TReturn> {
			return createSubscription<TReturn>();
		},
		async cancel() { return false; },
		async start() {},
		async stop() {}
	};
}

describe('createEventSystem subscription tracking', () => {
	const registry = EventRegistry.create()
		.event('test.a')
		.event('test.b')
		.event('test.c')
		.build();

	test('should await all subscriptions during start()', async () => {
		let resolveA: () => void;
		let resolveB: () => void;

		const provider: EventProvider = {
			subscribe<TPayload, TReturn>(eventName: string, _handler: EventHandlerFn<TPayload, TReturn>) {
				const promise = new Promise<void>((resolve) => {
					if (eventName === 'test.a') resolveA = resolve;
					if (eventName === 'test.b') resolveB = resolve;
				});
				return promise;
			},
			emit<TReturn>() { return createSubscription<TReturn>(); },
			async cancel() { return false; },
			async start() {},
			async stop() {}
		};

		const events = createEventSystem(registry, { provider });

		events.onEvent('test.a', async () => {});
		events.onEvent('test.b', async () => {});

		let startResolved = false;
		const startPromise = events.start().then(() => { startResolved = true; });

		// Give microtasks a chance to run
		await new Promise((r) => setTimeout(r, 10));
		expect(startResolved).toBe(false);

		resolveA!();
		await new Promise((r) => setTimeout(r, 10));
		expect(startResolved).toBe(false);

		resolveB!();
		await startPromise;
		expect(startResolved).toBe(true);
	});

	test('should throw AggregateError when subscription fails during start()', async () => {
		const provider: EventProvider = {
			subscribe<TPayload, TReturn>(_eventName: string, _handler: EventHandlerFn<TPayload, TReturn>) {
				return Promise.reject(new Error('Connection refused'));
			},
			emit<TReturn>() { return createSubscription<TReturn>(); },
			async cancel() { return false; },
			async start() {},
			async stop() {}
		};

		const events = createEventSystem(registry, { provider });
		events.onEvent('test.a', async () => {});

		await expect(events.start()).rejects.toBeInstanceOf(AggregateError);
	});

	test('should capture post-start registration failures via onRegistrationError', async () => {
		const errors: Array<{ event: string; error: Error }> = [];
		const provider = createMockProvider(0);

		// Override subscribe to fail
		provider.subscribe = <TPayload, TReturn>(_eventName: string, _handler: EventHandlerFn<TPayload, TReturn>) => {
			return Promise.reject(new Error('Late subscribe failed'));
		};

		const events = createEventSystem(registry, {
			provider,
			onRegistrationError: (eventName, error) => {
				errors.push({ event: eventName, error });
			}
		});

		await events.start();

		// Post-start registration
		events.onEvent('test.c', async () => {});

		// Give microtasks a chance to run
		await new Promise((r) => setTimeout(r, 50));

		expect(errors).toHaveLength(1);
		expect(errors[0]!.event).toBe('test.c');
		expect(errors[0]!.error.message).toBe('Late subscribe failed');
	});

	test('should deduplicate concurrent start() calls', async () => {
		let startCount = 0;
		const provider: EventProvider = {
			subscribe<TPayload, TReturn>(_eventName: string, _handler: EventHandlerFn<TPayload, TReturn>) {},
			emit<TReturn>() { return createSubscription<TReturn>(); },
			async cancel() { return false; },
			async start() { startCount++; await new Promise((r) => setTimeout(r, 10)); },
			async stop() {}
		};

		const events = createEventSystem(registry, { provider });

		// Call start() twice concurrently
		await Promise.all([events.start(), events.start()]);

		expect(startCount).toBe(1);
	});
});
