/**
 * Tests for definition-based event and workflow registration.
 *
 * These tests verify the new fluent API pattern:
 * - .event(Definition).consumer(ConsumerClass, deps)
 * - .workflow(Definition).consumer(ConsumerClass, deps)
 * - ctx.events.emit(Definition, payload)
 * - ctx.workflows.execute(Definition, data)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { type Application, Ori } from '../src/index.ts';
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

describe('Definition-Based Registration', () => {
	let app: Application;
	// Use a unique port range to avoid conflicts with other test files
	let port = 49999;

	const getPort = () => ++port;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(async () => {
		await app?.stop();
	});

	describe('Event Registration', () => {
		// Define test events
		const UserCreated = Event.define({
			name: 'user.created',
			data: Type.Object({ userId: Type.String(), email: Type.String() }),
			result: Type.Object({ welcomeEmailSent: Type.Boolean() })
		});

		const OrderPlaced = Event.define({
			name: 'order.placed',
			data: Type.Object({ orderId: Type.String(), amount: Type.Number() }),
			result: Type.Void()
		});

		it('should register event definition without consumer (emitter-only)', async () => {
			app = Ori.create().event(UserCreated);
			await app.listen(getPort());

			// Event should be registered for emission
			const eventCoordinator = (app as any).eventCoordinator;
			expect(eventCoordinator.getEventDefinition('user.created')).toBeDefined();
		});

		it('should register event definition with consumer', async () => {
			// Define consumer class
			class UserCreatedConsumer implements IEventConsumer<
				(typeof UserCreated)['_data'],
				(typeof UserCreated)['_result']
			> {
				onEvent = async (_ctx: EventContext<(typeof UserCreated)['_data']>) => {
					return { welcomeEmailSent: true };
				};
			}

			app = Ori.create().event(UserCreated).consumer(UserCreatedConsumer);

			// Check before listen() - consumers are in pendingConsumers
			const eventCoordinator = (app as any).eventCoordinator;
			expect(eventCoordinator.hasConsumer('user.created')).toBe(true);

			await app.listen(getPort());

			// After listen(), pendingConsumers is cleared but definition exists
			expect(eventCoordinator.getEventDefinition('user.created')).toBeDefined();
		});

		it('should register event consumer with dependencies', async () => {
			// Mock email service
			class EmailService {
				async sendWelcome(_email: string): Promise<boolean> {
					return true;
				}
			}

			class UserCreatedConsumer implements IEventConsumer<
				(typeof UserCreated)['_data'],
				(typeof UserCreated)['_result']
			> {
				constructor(private emailService: EmailService) {}

				onEvent = async (ctx: EventContext<(typeof UserCreated)['_data']>) => {
					await this.emailService.sendWelcome(ctx.data.email);
					return { welcomeEmailSent: true };
				};
			}

			app = Ori.create()
				.provider(EmailService)
				.event(UserCreated)
				.consumer(UserCreatedConsumer, [EmailService]);

			// Verify consumer is pending before listen()
			const eventCoordinator = (app as any).eventCoordinator;
			expect(eventCoordinator.hasConsumer('user.created')).toBe(true);

			await app.listen(getPort());

			// After listen(), definition should be registered
			expect(eventCoordinator.getEventDefinition('user.created')).toBeDefined();
		});

		it('should allow chaining after event registration', async () => {
			class OrderHandler implements IEventConsumer<(typeof OrderPlaced)['_data'], void> {
				onEvent = async () => {};
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			// Chain: event -> controller -> event -> another chain item
			app = Ori.create()
				.event(UserCreated) // No consumer
				.event(OrderPlaced)
				.consumer(OrderHandler)
				.controller('/api', TestController);

			// Check before listen() - consumer should be pending
			const eventCoordinator = (app as any).eventCoordinator;
			expect(eventCoordinator.hasConsumer('order.placed')).toBe(true);

			// Store port locally to avoid race condition with parallel tests
			const usedPort = getPort();
			await app.listen(usedPort);

			// Both events should be registered after listen()
			expect(eventCoordinator.getEventDefinition('user.created')).toBeDefined();
			expect(eventCoordinator.getEventDefinition('order.placed')).toBeDefined();

			// Controller should work
			const response = await fetch(`http://localhost:${usedPort}/api`);
			expect(response.status).toBe(200);
		});

		it('should return undefined for unregistered event definition', async () => {
			// Register UserCreated but NOT some other event
			app = Ori.create().event(UserCreated);

			const eventCoordinator = (app as any).eventCoordinator;

			// Verify unregistered event is not found (returns undefined, not null)
			expect(eventCoordinator.getEventDefinition('unregistered.event')).toBeUndefined();
		});
	});

	describe('Workflow Registration', () => {
		// Define test workflows
		const SendEmail = Workflow.define({
			name: 'send-email',
			data: Type.Object({ to: Type.String(), subject: Type.String(), body: Type.String() }),
			result: Type.Object({ messageId: Type.String(), sentAt: Type.String() })
		});

		const ProcessOrder = Workflow.define({
			name: 'process-order',
			data: Type.Object({ orderId: Type.String(), items: Type.Array(Type.String()) }),
			result: Type.Object({ processed: Type.Boolean() })
		});

		it('should register workflow definition without consumer', async () => {
			app = Ori.create().workflow(SendEmail);
			await app.listen(getPort());

			// Workflow should be registered
			const workflowCoordinator = (app as any).workflowCoordinator;
			expect(workflowCoordinator.getWorkflowDefinition('send-email')).toBeDefined();
		});

		it('should register workflow definition with consumer', async () => {
			class SendEmailWorkflow implements IWorkflowConsumer<
				(typeof SendEmail)['_data'],
				(typeof SendEmail)['_result']
			> {
				onComplete = async (_ctx: WorkflowContext<(typeof SendEmail)['_data']>) => {
					return { messageId: 'msg-123', sentAt: new Date().toISOString() };
				};
			}

			app = Ori.create().workflow(SendEmail).consumer(SendEmailWorkflow);

			await app.listen(getPort());

			// Verify consumer is registered
			const workflowCoordinator = (app as any).workflowCoordinator;
			expect(workflowCoordinator.getConsumer('send-email')).toBeDefined();
		});

		it('should register workflow consumer with dependencies', async () => {
			class SmtpClient {
				async send(_to: string, _subject: string, _body: string) {
					return { id: 'smtp-123' };
				}
			}

			class SendEmailWorkflow implements IWorkflowConsumer<
				(typeof SendEmail)['_data'],
				(typeof SendEmail)['_result']
			> {
				constructor(private smtp: SmtpClient) {}

				onComplete = async (ctx: WorkflowContext<(typeof SendEmail)['_data']>) => {
					const result = await this.smtp.send(ctx.data.to, ctx.data.subject, ctx.data.body);
					return { messageId: result.id, sentAt: new Date().toISOString() };
				};
			}

			app = Ori.create().provider(SmtpClient).workflow(SendEmail).consumer(SendEmailWorkflow, [SmtpClient]);

			await app.listen(getPort());

			// Verify consumer with dependencies is registered
			const workflowCoordinator = (app as any).workflowCoordinator;
			expect(workflowCoordinator.getConsumer('send-email')).toBeDefined();
		});

		it('should allow chaining after workflow registration', async () => {
			class SendEmailWorkflow implements IWorkflowConsumer<
				(typeof SendEmail)['_data'],
				(typeof SendEmail)['_result']
			> {
				onComplete = async () => ({ messageId: 'msg-1', sentAt: new Date().toISOString() });
			}

			class ProcessOrderWorkflow implements IWorkflowConsumer<
				(typeof ProcessOrder)['_data'],
				(typeof ProcessOrder)['_result']
			> {
				onComplete = async () => ({ processed: true });
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			// Chain multiple workflows and controller
			app = Ori.create()
				.workflow(SendEmail)
				.consumer(SendEmailWorkflow)
				.workflow(ProcessOrder)
				.consumer(ProcessOrderWorkflow)
				.controller('/api', TestController);

			// Store port locally to avoid race condition with parallel tests
			const usedPort = getPort();
			await app.listen(usedPort);

			// Both workflows should be registered
			const workflowCoordinator = (app as any).workflowCoordinator;
			expect(workflowCoordinator.getConsumer('send-email')).toBeDefined();
			expect(workflowCoordinator.getConsumer('process-order')).toBeDefined();

			// Controller should work
			const response = await fetch(`http://localhost:${usedPort}/api`);
			expect(response.status).toBe(200);
		});
	});

	describe('Mixed Registration', () => {
		const UserCreated = Event.define({
			name: 'user.created',
			data: Type.Object({ userId: Type.String() }),
			result: Type.Void()
		});

		const SendWelcome = Workflow.define({
			name: 'send-welcome',
			data: Type.Object({ userId: Type.String(), email: Type.String() }),
			result: Type.Object({ sent: Type.Boolean() })
		});

		it('should support mixed event and workflow registration', async () => {
			class UserCreatedConsumer implements IEventConsumer<(typeof UserCreated)['_data'], void> {
				onEvent = async () => {};
			}

			class SendWelcomeWorkflow implements IWorkflowConsumer<
				(typeof SendWelcome)['_data'],
				(typeof SendWelcome)['_result']
			> {
				onComplete = async () => ({ sent: true });
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create()
				.event(UserCreated)
				.consumer(UserCreatedConsumer)
				.workflow(SendWelcome)
				.consumer(SendWelcomeWorkflow)
				.controller('/api', TestController);

			// Check pending registrations before listen()
			const eventCoordinator = (app as any).eventCoordinator;
			const workflowCoordinator = (app as any).workflowCoordinator;
			expect(eventCoordinator.hasConsumer('user.created')).toBe(true);

			// Store port locally to avoid race condition with parallel tests
			const usedPort = getPort();
			await app.listen(usedPort);

			// Verify both registered after listen()
			expect(eventCoordinator.getEventDefinition('user.created')).toBeDefined();
			expect(workflowCoordinator.getConsumer('send-welcome')).toBeDefined();

			// Controller should work
			const response = await fetch(`http://localhost:${usedPort}/api`);
			expect(response.status).toBe(200);
		});
	});

	describe('Event Definition Properties', () => {
		it('should freeze event definitions', () => {
			const TestEvent = Event.define({
				name: 'test.event',
				data: Type.Object({ id: Type.String() }),
				result: Type.Void()
			});

			expect(Object.isFrozen(TestEvent)).toBe(true);

			// Should not be able to modify
			expect(() => {
				(TestEvent as any).name = 'modified';
			}).toThrow();
		});

		it('should include TypeBox schemas for runtime validation', () => {
			const TestEvent = Event.define({
				name: 'test.event',
				data: Type.Object({ id: Type.String() }),
				result: Type.Object({ success: Type.Boolean() })
			});

			expect(TestEvent.name).toBe('test.event');
			expect(TestEvent.dataSchema).toBeDefined();
			expect(TestEvent.resultSchema).toBeDefined();

			// Verify schema structure
			expect(TestEvent.dataSchema.type).toBe('object');
			expect(TestEvent.resultSchema.type).toBe('object');
		});
	});

	describe('Workflow Definition Properties', () => {
		it('should freeze workflow definitions after steps() is called', () => {
			// Workflow.define() returns a builder (not frozen) to allow .steps() call
			const TestWorkflowBuilder = Workflow.define({
				name: 'test.workflow',
				data: Type.Object({ id: Type.String() }),
				result: Type.Void()
			});

			// Builder has .steps() method
			expect(typeof TestWorkflowBuilder.steps).toBe('function');

			// Call .steps() to get a frozen definition
			const TestWorkflow = TestWorkflowBuilder.steps((s) => s);

			expect(Object.isFrozen(TestWorkflow)).toBe(true);

			// Should not be able to modify frozen definition
			expect(() => {
				(TestWorkflow as any).name = 'modified';
			}).toThrow();
		});

		it('should include TypeBox schemas for runtime validation', () => {
			const TestWorkflow = Workflow.define({
				name: 'test.workflow',
				data: Type.Object({ orderId: Type.String() }),
				result: Type.Object({ completed: Type.Boolean() })
			});

			expect(TestWorkflow.name).toBe('test.workflow');
			expect(TestWorkflow.dataSchema).toBeDefined();
			expect(TestWorkflow.resultSchema).toBeDefined();

			// Verify schema structure
			expect(TestWorkflow.dataSchema.type).toBe('object');
			expect(TestWorkflow.resultSchema.type).toBe('object');
		});
	});

	describe('Duplicate Detection', () => {
		it('should throw on duplicate event registration', async () => {
			const DuplicateEvent = Event.define({
				name: 'duplicate.event',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			class Consumer1 implements IEventConsumer<(typeof DuplicateEvent)['_data'], void> {
				onEvent = async () => {};
			}

			// First registration should succeed
			app = Ori.create().event(DuplicateEvent).consumer(Consumer1);

			// Second registration with same event name should throw during setup
			expect(() => {
				app.event(DuplicateEvent);
			}).toThrow(/already registered|duplicate/i);
		});

		it('should throw on duplicate workflow registration', async () => {
			const DuplicateWorkflow = Workflow.define({
				name: 'duplicate-workflow',
				data: Type.Object({ to: Type.String() }),
				result: Type.Void()
			});

			class Workflow1 implements IWorkflowConsumer<(typeof DuplicateWorkflow)['_data'], void> {
				onComplete = async () => {};
			}

			// First registration should succeed
			app = Ori.create().workflow(DuplicateWorkflow).consumer(Workflow1);

			// Second registration with same workflow name should throw during setup
			expect(() => {
				app.workflow(DuplicateWorkflow);
			}).toThrow(/already registered|duplicate/i);
		});
	});
});
