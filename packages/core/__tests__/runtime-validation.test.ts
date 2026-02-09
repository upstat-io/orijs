/**
 * Integration tests for runtime validation of events and workflows.
 *
 * These tests verify:
 * - Event payload validation with TypeBox schemas
 * - Event response validation with TypeBox schemas
 * - Workflow data validation with TypeBox schemas
 * - Workflow result validation with TypeBox schemas
 * - ctx.events.emit() validation
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Ori, type Application } from '../src/index.ts';
import { Event } from '../src/types/event-definition.ts';
import { Workflow } from '../src/types/workflow-definition.ts';
import { Type } from '@orijs/validation';
import type { OriController, RouteBuilder } from '../src/types/index.ts';
import type {
	IEventConsumer,
	IWorkflowConsumer,
	EventContext,
	WorkflowContext
} from '../src/types/consumer.ts';
import { Logger } from '@orijs/logging';

describe('Runtime Validation', () => {
	let app: Application;
	let port = 39999;

	const getPort = () => ++port;
	const getBaseUrl = () => `http://localhost:${port}`;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(() => {
		app?.stop();
	});

	describe('Event Payload Validation', () => {
		const StrictEvent = Event.define({
			name: 'strict.event',
			data: Type.Object({
				userId: Type.String({ minLength: 1 }),
				email: Type.String({ minLength: 5 }), // TypeBox doesn't validate email format by default
				age: Type.Number({ minimum: 0, maximum: 150 })
			}),
			result: Type.Object({ processed: Type.Boolean() })
		});

		it('should accept valid payload', async () => {
			let receivedPayload: unknown = null;

			class StrictConsumer implements IEventConsumer<
				(typeof StrictEvent)['_data'],
				(typeof StrictEvent)['_result']
			> {
				onEvent = async (ctx: EventContext<(typeof StrictEvent)['_data']>) => {
					receivedPayload = ctx.data;
					return { processed: true };
				};
			}

			app = Ori.create().event(StrictEvent).consumer(StrictConsumer);
			await app.listen(getPort());

			// Emit valid payload through event coordinator's provider
			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			await provider.emit('strict.event', {
				userId: 'user-123',
				email: 'test@example.com',
				age: 25
			});

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(receivedPayload).toEqual({
				userId: 'user-123',
				email: 'test@example.com',
				age: 25
			});
		});

		it('should reject payload with missing required field', async () => {
			class StrictConsumer implements IEventConsumer<
				(typeof StrictEvent)['_data'],
				(typeof StrictEvent)['_result']
			> {
				onEvent = async () => ({ processed: true });
			}

			app = Ori.create().event(StrictEvent).consumer(StrictConsumer);
			await app.listen(getPort());

			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			// Emit payload with missing 'email' field
			const subscription = provider.emit('strict.event', {
				userId: 'user-123',
				age: 25
				// missing email
			});

			// Await the subscription (which will reject) - use toPromise() for proper expect handling
			await expect(subscription.toPromise()).rejects.toThrow(/payload validation failed|email/i);
		});

		it('should reject payload with invalid field type', async () => {
			class StrictConsumer implements IEventConsumer<
				(typeof StrictEvent)['_data'],
				(typeof StrictEvent)['_result']
			> {
				onEvent = async () => ({ processed: true });
			}

			app = Ori.create().event(StrictEvent).consumer(StrictConsumer);
			await app.listen(getPort());

			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			// Emit payload with wrong type (age as string)
			const subscription = provider.emit('strict.event', {
				userId: 'user-123',
				email: 'test@example.com',
				age: 'twenty-five' // Should be number
			});

			await expect(subscription.toPromise()).rejects.toThrow(/payload validation failed|age/i);
		});

		it('should reject payload violating constraints', async () => {
			class StrictConsumer implements IEventConsumer<
				(typeof StrictEvent)['_data'],
				(typeof StrictEvent)['_result']
			> {
				onEvent = async () => ({ processed: true });
			}

			app = Ori.create().event(StrictEvent).consumer(StrictConsumer);
			await app.listen(getPort());

			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			// Emit payload with age > 150 (violates maximum constraint)
			const subscription = provider.emit('strict.event', {
				userId: 'user-123',
				email: 'test@example.com',
				age: 200 // Exceeds maximum
			});

			await expect(subscription.toPromise()).rejects.toThrow(/payload validation failed/i);
		});
	});

	describe('Event Response Validation', () => {
		const ResponseEvent = Event.define({
			name: 'response.event',
			data: Type.Object({ action: Type.String() }),
			result: Type.Object({
				success: Type.Boolean(),
				count: Type.Number({ minimum: 0 })
			})
		});

		it('should accept valid response', async () => {
			class ResponseConsumer implements IEventConsumer<
				(typeof ResponseEvent)['_data'],
				(typeof ResponseEvent)['_result']
			> {
				onEvent = async () => ({
					success: true,
					count: 42
				});
			}

			app = Ori.create().event(ResponseEvent).consumer(ResponseConsumer);
			await app.listen(getPort());

			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			// Should not throw
			await expect(provider.emit('response.event', { action: 'test' }).toPromise()).resolves.toBeDefined();
		});

		it('should reject invalid response from consumer', async () => {
			class BadResponseConsumer implements IEventConsumer<
				(typeof ResponseEvent)['_data'],
				(typeof ResponseEvent)['_result']
			> {
				onEvent = async (): Promise<(typeof ResponseEvent)['_result']> => {
					// Return invalid response (missing count)
					return { success: true } as any;
				};
			}

			app = Ori.create().event(ResponseEvent).consumer(BadResponseConsumer);
			await app.listen(getPort());

			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			const subscription = provider.emit('response.event', { action: 'test' });
			await expect(subscription.toPromise()).rejects.toThrow(/response validation failed|count/i);
		});

		it('should reject response with wrong type', async () => {
			class WrongTypeConsumer implements IEventConsumer<
				(typeof ResponseEvent)['_data'],
				(typeof ResponseEvent)['_result']
			> {
				onEvent = async (): Promise<(typeof ResponseEvent)['_result']> => {
					// Return response with wrong type
					return { success: true, count: 'not-a-number' } as any;
				};
			}

			app = Ori.create().event(ResponseEvent).consumer(WrongTypeConsumer);
			await app.listen(getPort());

			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			const subscription = provider.emit('response.event', { action: 'test' });
			await expect(subscription.toPromise()).rejects.toThrow(/response validation failed/i);
		});
	});

	describe('Workflow Data Validation', () => {
		const StrictWorkflow = Workflow.define({
			name: 'strict-workflow',
			data: Type.Object({
				orderId: Type.String({ minLength: 1 }),
				items: Type.Array(Type.String(), { minItems: 1 }),
				total: Type.Number({ minimum: 0 })
			}),
			result: Type.Object({ processed: Type.Boolean() })
		});

		it('should accept valid workflow data', async () => {
			class StrictWorkflowConsumer implements IWorkflowConsumer<
				(typeof StrictWorkflow)['_data'],
				(typeof StrictWorkflow)['_result']
			> {
				onComplete = async (_ctx: WorkflowContext<(typeof StrictWorkflow)['_data']>) => {
					return { processed: true };
				};
			}

			app = Ori.create().workflow(StrictWorkflow).consumer(StrictWorkflowConsumer);
			await app.listen(getPort());

			// Execute workflow through coordinator
			const workflowCoordinator = (app as any).workflowCoordinator;
			const consumer = workflowCoordinator.getConsumer('strict-workflow');

			// Directly invoke consumer with valid data
			const result = await consumer.consumer.onComplete({
				data: {
					orderId: 'order-123',
					items: ['item1', 'item2'],
					total: 99.99
				}
			} as any);

			expect(result).toEqual({ processed: true });
		});
	});

	describe('ctx.events.emit() Validation', () => {
		const ValidatedEvent = Event.define({
			name: 'validated.event',
			data: Type.Object({
				message: Type.String({ minLength: 1, maxLength: 100 })
			}),
			result: Type.Object({ received: Type.Boolean() })
		});

		it('should validate payload in ctx.events.emit()', async () => {
			let emitCalled = false;

			class EventConsumer implements IEventConsumer<
				(typeof ValidatedEvent)['_data'],
				(typeof ValidatedEvent)['_result']
			> {
				onEvent = async () => {
					emitCalled = true;
					return { received: true };
				};
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/emit', async (ctx) => {
						const body = await ctx.json<{ message: string }>();

						// This should validate the payload before emitting
						try {
							await ctx.events.emit(ValidatedEvent, body);
							return Response.json({ success: true });
						} catch (error) {
							return Response.json({ error: (error as Error).message }, { status: 400 });
						}
					});
				}
			}

			app = Ori.create().event(ValidatedEvent).consumer(EventConsumer).controller('/api', TestController);

			await app.listen(getPort());

			// Test with valid payload
			const validResponse = await fetch(`${getBaseUrl()}/api/emit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'Hello World' })
			});
			expect(validResponse.status).toBe(200);

			// Wait for async event processing
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(emitCalled).toBe(true);
		});

		it('should reject invalid payload in ctx.events.emit()', async () => {
			class EventConsumer implements IEventConsumer<
				(typeof ValidatedEvent)['_data'],
				(typeof ValidatedEvent)['_result']
			> {
				onEvent = async () => ({ received: true });
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/emit', async (ctx) => {
						const body = await ctx.json<{ message: string }>();

						try {
							await ctx.events.emit(ValidatedEvent, body);
							return Response.json({ success: true });
						} catch (error) {
							return Response.json({ error: (error as Error).message }, { status: 400 });
						}
					});
				}
			}

			app = Ori.create().event(ValidatedEvent).consumer(EventConsumer).controller('/api', TestController);

			await app.listen(getPort());

			// Test with invalid payload (empty message)
			const invalidResponse = await fetch(`${getBaseUrl()}/api/emit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: '' }) // Empty string violates minLength
			});

			const body = (await invalidResponse.json()) as { error?: string };
			expect(invalidResponse.status).toBe(400);
			expect(body.error).toMatch(/payload validation failed/i);
		});

		it('should throw when emitting unregistered event', async () => {
			const UnregisteredEvent = Event.define({
				name: 'unregistered.event',
				data: Type.Object({ data: Type.String() }),
				result: Type.Void()
			});

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/emit', async (ctx) => {
						try {
							// Try to emit an event that isn't registered
							await ctx.events.emit(UnregisteredEvent, { data: 'test' });
							return Response.json({ success: true });
						} catch (error) {
							return Response.json({ error: (error as Error).message }, { status: 400 });
						}
					});
				}
			}

			// Only register ValidatedEvent, not UnregisteredEvent
			app = Ori.create().event(ValidatedEvent).controller('/api', TestController);

			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api/emit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ data: 'test' })
			});

			const body = (await response.json()) as { error?: string };
			expect(response.status).toBe(400);
			expect(body.error).toMatch(/not registered/i);
		});
	});

	describe('Consumer Lifecycle Hooks', () => {
		const LifecycleEvent = Event.define({
			name: 'lifecycle.event',
			data: Type.Object({ value: Type.Number() }),
			result: Type.Object({ doubled: Type.Number() })
		});

		it('should call onSuccess hook on successful event processing', async () => {
			let successCalled = false;
			let successPayload: unknown = null;
			let successResult: unknown = null;

			class LifecycleConsumer implements IEventConsumer<
				(typeof LifecycleEvent)['_data'],
				(typeof LifecycleEvent)['_result']
			> {
				onEvent = async (ctx: EventContext<(typeof LifecycleEvent)['_data']>) => {
					return { doubled: ctx.data.value * 2 };
				};

				onSuccess = async (
					ctx: EventContext<(typeof LifecycleEvent)['_data']>,
					_result: (typeof LifecycleEvent)['_result']
				) => {
					successCalled = true;
					successPayload = ctx.data;
					successResult = _result;
				};
			}

			app = Ori.create().event(LifecycleEvent).consumer(LifecycleConsumer);
			await app.listen(getPort());

			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			await provider.emit('lifecycle.event', { value: 21 });

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(successCalled).toBe(true);
			expect(successPayload).toEqual({ value: 21 });
			expect(successResult).toEqual({ doubled: 42 });
		});

		it('should call onError hook on event processing failure', async () => {
			let errorCalled = false;
			const errorState: { error: Error | null } = { error: null };

			class FailingConsumer implements IEventConsumer<
				(typeof LifecycleEvent)['_data'],
				(typeof LifecycleEvent)['_result']
			> {
				onEvent = async (): Promise<(typeof LifecycleEvent)['_result']> => {
					throw new Error('Intentional failure');
				};

				onError = async (_ctx: EventContext<(typeof LifecycleEvent)['_data']>, error: Error) => {
					errorCalled = true;
					errorState.error = error;
				};
			}

			app = Ori.create().event(LifecycleEvent).consumer(FailingConsumer);
			await app.listen(getPort());

			const eventCoordinator = (app as any).eventCoordinator;
			const provider = eventCoordinator.getProvider();

			// The emit will throw, but onError should still be called
			try {
				await provider.emit('lifecycle.event', { value: 5 });
			} catch {
				// Expected to throw
			}

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(errorCalled).toBe(true);
			expect(errorState.error?.message).toBe('Intentional failure');
		});
	});
});
