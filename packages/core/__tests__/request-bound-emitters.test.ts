import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
	RequestBoundEventEmitter,
	RequestBoundWorkflowExecutor,
	RequestBoundSocketEmitter,
	type RequestBindingContext
} from '../src/controllers/request-bound-emitters.ts';
import type { SocketEmitter } from '../src/types/emitter.ts';
import { Event } from '../src/types/event-definition.ts';
import { Workflow } from '../src/types/workflow-definition.ts';
import { Type } from '@orijs/validation';
import { Logger } from '@orijs/logging';
import type { EventCoordinator } from '../src/event-coordinator.ts';
import type { WorkflowCoordinator } from '../src/workflow-coordinator.ts';
import type { EventProvider } from '@orijs/events';

describe('RequestBoundEventEmitter', () => {
	let mockEventCoordinator: EventCoordinator;
	let mockProvider: EventProvider;
	let context: RequestBindingContext;
	let logger: Logger;

	const TestEvent = Event.define({
		name: 'test.event',
		data: Type.Object({
			message: Type.String(),
			count: Type.Number()
		}),
		result: Type.Object({ received: Type.Boolean() })
	});

	beforeEach(() => {
		logger = new Logger('test');
		context = {
			correlationId: 'req-123',
			logger
		};

		mockProvider = {
			start: async () => {},
			stop: async () => {},
			emit: mock(() => Promise.resolve({ received: true })),
			subscribe: () => {}
		} as unknown as EventProvider;

		mockEventCoordinator = {
			getProvider: mock(() => mockProvider),
			getEventDefinition: mock(() => TestEvent)
		} as unknown as EventCoordinator;
	});

	describe('emit', () => {
		it('should emit event with valid payload and propagate correlationId', async () => {
			const emitter = new RequestBoundEventEmitter(mockEventCoordinator, context);

			const result = await emitter.emit(TestEvent, { message: 'hello', count: 42 });

			expect(result).toEqual({ received: true });
			expect(mockProvider.emit).toHaveBeenCalledWith(
				'test.event',
				{ message: 'hello', count: 42 },
				{ correlationId: 'req-123', causationId: 'req-123' }
			);
		});

		it('should throw when no event provider configured', async () => {
			mockEventCoordinator.getProvider = mock(() => null);
			const emitter = new RequestBoundEventEmitter(mockEventCoordinator, context);

			await expect(emitter.emit(TestEvent, { message: 'hello', count: 42 })).rejects.toThrow(
				/no event provider configured/
			);
		});

		it('should throw when event not registered', async () => {
			mockEventCoordinator.getEventDefinition = mock(() => undefined);
			const emitter = new RequestBoundEventEmitter(mockEventCoordinator, context);

			await expect(emitter.emit(TestEvent, { message: 'hello', count: 42 })).rejects.toThrow(
				/event not registered/
			);
		});

		it('should throw on invalid payload (missing required field)', async () => {
			const emitter = new RequestBoundEventEmitter(mockEventCoordinator, context);

			await expect(
				emitter.emit(TestEvent, { message: 'hello' } as any) // missing count
			).rejects.toThrow(/payload validation failed/);
		});

		it('should throw on invalid payload (wrong type)', async () => {
			const emitter = new RequestBoundEventEmitter(mockEventCoordinator, context);

			await expect(
				emitter.emit(TestEvent, { message: 'hello', count: 'not-a-number' } as any)
			).rejects.toThrow(/payload validation failed/);
		});
	});
});

describe('RequestBoundWorkflowExecutor', () => {
	let mockWorkflowCoordinator: WorkflowCoordinator;
	let context: RequestBindingContext;
	let logger: Logger;

	const TestWorkflow = Workflow.define({
		name: 'test-workflow',
		data: Type.Object({
			orderId: Type.String(),
			amount: Type.Number()
		}),
		result: Type.Object({ success: Type.Boolean(), processedAt: Type.String() })
	});

	beforeEach(() => {
		logger = new Logger('test');
		context = {
			correlationId: 'req-456',
			logger
		};

		mockWorkflowCoordinator = {
			getConsumer: mock(() => ({
				definition: TestWorkflow,
				consumer: {
					configure: () => {},
					onComplete: async (_ctx: any) => ({
						success: true,
						processedAt: new Date().toISOString()
					})
				}
			})),
			getWorkflowDefinition: mock(() => TestWorkflow)
		} as unknown as WorkflowCoordinator;
	});

	describe('execute', () => {
		it('should execute workflow with valid data and return handle', async () => {
			const executor = new RequestBoundWorkflowExecutor(mockWorkflowCoordinator, context);

			const handle = await executor.execute(TestWorkflow, { orderId: 'ORD-001', amount: 99.99 });

			expect(handle.id).toContain('test-workflow');

			// Wait for async execution
			const result = await handle.result();
			expect(result.success).toBe(true);
			expect(result.processedAt).toBeDefined();

			const status = await handle.status();
			expect(status).toBe('completed');
		});

		it('should throw when workflow not registered', async () => {
			mockWorkflowCoordinator.getConsumer = mock(() => undefined);
			mockWorkflowCoordinator.getWorkflowDefinition = mock(() => undefined);
			const executor = new RequestBoundWorkflowExecutor(mockWorkflowCoordinator, context);

			await expect(executor.execute(TestWorkflow, { orderId: 'ORD-001', amount: 99.99 })).rejects.toThrow(
				/workflow not registered/
			);
		});

		it('should return NullWorkflowHandle when no consumer registered (definition only)', async () => {
			mockWorkflowCoordinator.getConsumer = mock(() => undefined);
			// Definition exists but no consumer
			mockWorkflowCoordinator.getWorkflowDefinition = mock(() => TestWorkflow);
			const executor = new RequestBoundWorkflowExecutor(mockWorkflowCoordinator, context);

			const handle = await executor.execute(TestWorkflow, { orderId: 'ORD-001', amount: 99.99 });

			expect(handle.id).toContain('null-test-workflow');

			const status = await handle.status();
			expect(status).toBe('failed');

			await expect(handle.result()).rejects.toThrow(/no workflow provider configured/);

			const cancelled = await handle.cancel();
			expect(cancelled).toBe(false);
		});

		it('should throw on invalid data (missing required field)', async () => {
			const executor = new RequestBoundWorkflowExecutor(mockWorkflowCoordinator, context);

			await expect(
				executor.execute(TestWorkflow, { orderId: 'ORD-001' } as any) // missing amount
			).rejects.toThrow(/data validation failed/);
		});

		it('should throw on invalid data (wrong type)', async () => {
			const executor = new RequestBoundWorkflowExecutor(mockWorkflowCoordinator, context);

			await expect(
				executor.execute(TestWorkflow, { orderId: 'ORD-001', amount: 'not-a-number' } as any)
			).rejects.toThrow(/data validation failed/);
		});

		it('should handle consumer onComplete throwing error', async () => {
			mockWorkflowCoordinator.getConsumer = mock(() => ({
				definition: TestWorkflow,
				consumer: {
					configure: () => {},
					onComplete: async () => {
						throw new Error('Consumer processing failed');
					}
				}
			}));
			const executor = new RequestBoundWorkflowExecutor(mockWorkflowCoordinator, context);

			const handle = await executor.execute(TestWorkflow, { orderId: 'ORD-001', amount: 99.99 });

			// Wait for async execution to fail
			await expect(handle.result()).rejects.toThrow(/Consumer processing failed/);

			const status = await handle.status();
			expect(status).toBe('failed');
		});

		it('should propagate correlationId in workflow context', async () => {
			let capturedMeta: any;
			mockWorkflowCoordinator.getConsumer = mock(() => ({
				definition: TestWorkflow,
				consumer: {
					configure: () => {},
					onComplete: async (ctx: any) => {
						capturedMeta = ctx.meta;
						return { success: true, processedAt: new Date().toISOString() };
					}
				}
			}));
			const executor = new RequestBoundWorkflowExecutor(mockWorkflowCoordinator, context);

			const handle = await executor.execute(TestWorkflow, { orderId: 'ORD-001', amount: 99.99 });
			await handle.result();

			expect(capturedMeta.correlationId).toBe('req-456');
		});

		it('should not support cancellation in direct invocation mode', async () => {
			const executor = new RequestBoundWorkflowExecutor(mockWorkflowCoordinator, context);

			const handle = await executor.execute(TestWorkflow, { orderId: 'ORD-001', amount: 99.99 });

			const cancelled = await handle.cancel();
			expect(cancelled).toBe(false);
		});
	});
});

describe('RequestBoundSocketEmitter', () => {
	let mockEmitter: SocketEmitter;
	let context: RequestBindingContext;
	let logger: Logger;

	beforeEach(() => {
		logger = new Logger('test');
		context = {
			correlationId: 'req-789',
			logger
		};

		mockEmitter = {
			publish: mock(() => Promise.resolve()),
			send: mock(() => true),
			broadcast: mock(() => {}),
			emit: mock(() => Promise.resolve())
		};
	});

	describe('correlationId', () => {
		it('should expose correlationId from request context', () => {
			const boundEmitter = new RequestBoundSocketEmitter(mockEmitter, context);

			expect(boundEmitter.correlationId).toBe('req-789');
		});
	});

	describe('publish', () => {
		it('should delegate to underlying emitter', () => {
			const boundEmitter = new RequestBoundSocketEmitter(mockEmitter, context);

			boundEmitter.publish('user:123', JSON.stringify({ type: 'update' }));

			expect(mockEmitter.publish).toHaveBeenCalledWith('user:123', JSON.stringify({ type: 'update' }));
		});

		it('should handle binary messages', () => {
			const boundEmitter = new RequestBoundSocketEmitter(mockEmitter, context);
			const binaryData = new ArrayBuffer(8);

			boundEmitter.publish('binary-topic', binaryData);

			expect(mockEmitter.publish).toHaveBeenCalledWith('binary-topic', binaryData);
		});
	});

	describe('send', () => {
		it('should delegate to underlying emitter', () => {
			const boundEmitter = new RequestBoundSocketEmitter(mockEmitter, context);

			boundEmitter.send('socket-456', 'direct message');

			expect(mockEmitter.send).toHaveBeenCalledWith('socket-456', 'direct message');
		});
	});

	describe('broadcast', () => {
		it('should delegate to underlying emitter', () => {
			const boundEmitter = new RequestBoundSocketEmitter(mockEmitter, context);

			boundEmitter.broadcast(JSON.stringify({ type: 'announcement' }));

			expect(mockEmitter.broadcast).toHaveBeenCalledWith(JSON.stringify({ type: 'announcement' }));
		});
	});
});
