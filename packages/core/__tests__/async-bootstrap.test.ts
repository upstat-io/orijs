/**
 * Tests that bootstrap() correctly awaits async subscriptions
 * and that listen() awaits bootstrap().
 */

import { describe, test, expect, afterEach } from 'bun:test';
import type { Application } from '../src/application.ts';
import { Ori } from '../src/application.ts';
import { Event } from '../src/types/event-definition.ts';
import { Type } from '@orijs/validation';
import type { IEventConsumer, EventContext } from '../src/types/consumer.ts';
import type { OriController, RouteBuilder } from '../src/types/index.ts';
import { Logger } from '@orijs/logging';

let app: Application;
let portCounter = 31000;

const getPort = () => ++portCounter;

afterEach(async () => {
	Logger.reset();
	if (app) {
		await app.stop();
	}
});

describe('Async bootstrap', () => {
	test('should complete bootstrap before listen() resolves', async () => {
		const events: string[] = [];

		class TestController implements OriController {
			configure(r: RouteBuilder) {
				r.get('/health', () => Response.json({ ok: true }));
			}
		}

		app = Ori.create()
			.disableSignalHandling()
			.logger({ level: 'error' })
			.controller('/api', TestController);

		app.context.onStartup(() => {
			events.push('startup');
		});

		const port = getPort();
		await app.listen(port);

		// After listen() resolves, phase should be 'ready'
		expect(app.context.phase).toBe('ready');
		events.push('after-listen');

		// Startup hook should have run before listen() resolved
		expect(events).toEqual(['startup', 'after-listen']);

		// Server should be accepting requests
		const response = await fetch(`http://localhost:${port}/api/health`);
		expect(response.status).toBe(200);
	});

	test('should register event consumers before server accepts requests', async () => {
		let handlerCalled = false;

		const BootstrapEvent = Event.define({
			name: 'bootstrap.test',
			data: Type.Object({ value: Type.String() }),
			result: Type.Void()
		});

		class BootstrapConsumer implements IEventConsumer<(typeof BootstrapEvent)['_data'], void> {
			onEvent = async (_ctx: EventContext<(typeof BootstrapEvent)['_data']>) => {
				handlerCalled = true;
			};
		}

		class HealthController implements OriController {
			configure(r: RouteBuilder) {
				r.get('/health', () => Response.json({ ok: true }));
			}
		}

		app = Ori.create()
			.disableSignalHandling()
			.logger({ level: 'error' })
			.event(BootstrapEvent)
			.consumer(BootstrapConsumer)
			.controller('/api', HealthController);

		const port = getPort();
		await app.listen(port);

		// After listen() resolves, event consumers should be registered
		const provider = app.getEventProvider();
		expect(provider).not.toBeNull();

		// Emit event — handler should be called because consumers are registered
		provider!.emit('bootstrap.test', { value: 'test' });
		await new Promise((r) => setTimeout(r, 50));

		expect(handlerCalled).toBe(true);
	});

	test('should await listen() fully before handling requests', async () => {
		class TestController implements OriController {
			configure(r: RouteBuilder) {
				r.get('/data', () => Response.json({ ready: true }));
			}
		}

		app = Ori.create()
			.disableSignalHandling()
			.logger({ level: 'error' })
			.controller('/api', TestController);

		const port = getPort();

		// listen() is a single await — no requests before it resolves
		await app.listen(port);

		// Server should be ready now
		const response = await fetch(`http://localhost:${port}/api/data`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ ready: true });
	});
});
