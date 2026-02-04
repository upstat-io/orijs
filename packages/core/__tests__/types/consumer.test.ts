/**
 * Tests for consumer interfaces.
 *
 * These tests verify that consumer interfaces provide correct type inference
 * and can be properly implemented by consumer classes.
 */

import { describe, expect, it } from 'bun:test';
import { Logger } from '@orijs/logging';
import type {
	EventContext,
	IEventConsumer,
	IWorkflowConsumer,
	WorkflowContext,
	StepContext
} from '../../src/types/consumer';

// Create a mock logger for tests
const mockLogger = new Logger('test');

// Helper to create mock EventContext with all required properties
function createEventContext<T>(config: {
	data: T;
	eventId?: string;
	eventName?: string;
	log?: Logger;
	timestamp?: number;
	correlationId?: string;
	emit?: EventContext<T>['emit'];
}): EventContext<T> {
	return {
		eventId: config.eventId ?? 'evt-test',
		data: config.data,
		log: config.log ?? mockLogger,
		eventName: config.eventName ?? 'test.event',
		timestamp: config.timestamp ?? Date.now(),
		correlationId: config.correlationId ?? 'corr-test',
		emit: config.emit ?? (() => ({ wait: async () => undefined as never }))
	};
}

// Helper to create mock WorkflowContext with all required properties
function createWorkflowContext<T>(config: {
	data: T;
	flowId?: string;
	results?: Record<string, unknown>;
	log?: Logger;
	meta?: Record<string, unknown>;
	correlationId?: string;
}): WorkflowContext<T> {
	return {
		flowId: config.flowId ?? 'wf-test',
		data: config.data,
		results: config.results ?? {},
		log: config.log ?? mockLogger,
		meta: config.meta ?? {},
		correlationId: config.correlationId ?? 'corr-test'
	};
}

describe('EventContext', () => {
	describe('type structure', () => {
		it('should have all required properties with correct types', () => {
			const ctx = createEventContext<{ userId: string }>({
				data: { userId: 'user-123' },
				eventId: 'evt-123',
				eventName: 'user.created',
				log: mockLogger,
				timestamp: Date.now()
			});

			expect(ctx.data.userId).toBe('user-123');
			expect(ctx.eventId).toBe('evt-123');
			expect(ctx.eventName).toBe('user.created');
			expect(ctx.timestamp).toBeGreaterThan(0);
		});

		it('should preserve payload type through generic', () => {
			interface UserPayload {
				userId: string;
				email: string;
				roles: string[];
			}

			const ctx = createEventContext<UserPayload>({
				data: { userId: 'u-1', email: 'test@example.com', roles: ['admin'] },
				eventId: 'evt-1',
				eventName: 'user.created',
				log: mockLogger,
				timestamp: Date.now()
			});

			// Type system ensures these properties exist
			expect(typeof ctx.data.userId).toBe('string');
			expect(typeof ctx.data.email).toBe('string');
			expect(Array.isArray(ctx.data.roles)).toBe(true);
		});

		it('should work with complex nested payload types', () => {
			interface OrderPayload {
				orderId: string;
				items: Array<{ sku: string; quantity: number }>;
				metadata: { source: string };
			}

			const ctx = createEventContext<OrderPayload>({
				data: {
					orderId: 'ord-1',
					items: [{ sku: 'SKU-001', quantity: 2 }],
					metadata: { source: 'web' }
				},
				eventId: 'evt-1',
				eventName: 'order.placed',
				log: mockLogger,
				timestamp: Date.now()
			});

			expect(ctx.data.items[0]!.sku).toBe('SKU-001');
			expect(ctx.data.metadata.source).toBe('web');
		});
	});

	describe('readonly enforcement', () => {
		it('should have readonly properties at type level', () => {
			// TypeScript enforces readonly - this test documents the expectation
			// The following would cause compile errors if uncommented:
			// const ctx: EventContext<{}> = { ... };
			// ctx.eventId = 'new-id'; // Error: Cannot assign to 'eventId' because it is a read-only property

			// Runtime test: create context and verify structure
			const ctx = createEventContext<{ id: string }>({
				data: { id: '1' },
				eventId: 'evt-1',
				eventName: 'test',
				log: mockLogger,
				timestamp: Date.now()
			});

			expect(Object.keys(ctx)).toContain('data');
			expect(Object.keys(ctx)).toContain('eventId');
			expect(Object.keys(ctx)).toContain('eventName');
			expect(Object.keys(ctx)).toContain('log');
			expect(Object.keys(ctx)).toContain('timestamp');
			expect(Object.keys(ctx)).toContain('correlationId');
			expect(Object.keys(ctx)).toContain('emit');
		});
	});
});

describe('IEventConsumer', () => {
	describe('basic implementation', () => {
		it('should allow implementation with arrow function handler', () => {
			interface TestPayload {
				userId: string;
			}
			interface TestResponse {
				processed: boolean;
			}

			const consumer: IEventConsumer<TestPayload, TestResponse> = {
				onEvent: async (ctx) => {
					expect(typeof ctx.data.userId).toBe('string');
					return { processed: true };
				}
			};

			expect(typeof consumer.onEvent).toBe('function');
		});

		it('should allow synchronous handler return', () => {
			const consumer: IEventConsumer<{ id: string }, { ok: boolean }> = {
				onEvent: (ctx) => {
					return { ok: ctx.data.id.length > 0 };
				}
			};

			// Simulate calling the handler
			const ctx = createEventContext<{ id: string }>({
				data: { id: 'test' },
				eventId: 'evt-1',
				eventName: 'test',
				log: mockLogger,
				timestamp: Date.now()
			});

			const result = consumer.onEvent(ctx);
			expect(result).toEqual({ ok: true });
		});

		it('should allow async handler return', async () => {
			const consumer: IEventConsumer<{ id: string }, { ok: boolean }> = {
				onEvent: async (ctx) => {
					await Promise.resolve();
					return { ok: ctx.data.id.length > 0 };
				}
			};

			const ctx = createEventContext<{ id: string }>({
				data: { id: 'test' },
				eventId: 'evt-1',
				eventName: 'test',
				log: mockLogger,
				timestamp: Date.now()
			});

			const result = await consumer.onEvent(ctx);
			expect(result).toEqual({ ok: true });
		});
	});

	describe('lifecycle hooks', () => {
		it('should allow optional onSuccess callback', async () => {
			let successCalled = false;
			let capturedResult: { sent: boolean } | undefined;

			const consumer: IEventConsumer<{ userId: string }, { sent: boolean }> = {
				onEvent: async () => {
					return { sent: true };
				},
				onSuccess: async (ctx, result) => {
					successCalled = true;
					capturedResult = result;
					expect(typeof ctx.data.userId).toBe('string');
				}
			};

			const ctx = createEventContext<{ userId: string }>({
				data: { userId: 'u-1' },
				eventId: 'evt-1',
				eventName: 'test',
				log: mockLogger,
				timestamp: Date.now()
			});

			const result = await consumer.onEvent(ctx);
			await consumer.onSuccess?.(ctx, result);

			expect(successCalled).toBe(true);
			expect(capturedResult).toEqual({ sent: true });
		});

		it('should allow optional onError callback', async () => {
			let errorCalled = false;
			let capturedError: Error | undefined;

			const consumer: IEventConsumer<{ userId: string }, { sent: boolean }> = {
				onEvent: async () => {
					throw new Error('Test error');
				},
				onError: async (ctx, error) => {
					errorCalled = true;
					capturedError = error;
					expect(typeof ctx.data.userId).toBe('string');
				}
			};

			const ctx = createEventContext<{ userId: string }>({
				data: { userId: 'u-1' },
				eventId: 'evt-1',
				eventName: 'test',
				log: mockLogger,
				timestamp: Date.now()
			});

			try {
				await consumer.onEvent(ctx);
			} catch (error) {
				await consumer.onError?.(ctx, error as Error);
			}

			expect(errorCalled).toBe(true);
			expect(capturedError?.message).toBe('Test error');
		});

		it('should allow synchronous lifecycle hooks', () => {
			let successCalled = false;

			const consumer: IEventConsumer<{ id: string }, { ok: boolean }> = {
				onEvent: () => ({ ok: true }),
				onSuccess: (_ctx, result) => {
					successCalled = true;
					expect(result.ok).toBe(true);
				}
			};

			const ctx = createEventContext<{ id: string }>({
				data: { id: '1' },
				eventId: 'evt-1',
				eventName: 'test',
				log: mockLogger,
				timestamp: Date.now()
			});

			const result = consumer.onEvent(ctx);
			consumer.onSuccess?.(ctx, result as { ok: boolean });

			expect(successCalled).toBe(true);
		});
	});

	describe('class implementation', () => {
		it('should allow class-based consumer implementation', async () => {
			interface UserCreatedPayload {
				userId: string;
				email: string;
			}
			interface WelcomeEmailResult {
				emailSent: boolean;
				messageId: string;
			}

			class UserCreatedConsumer implements IEventConsumer<UserCreatedPayload, WelcomeEmailResult> {
				onEvent = async (ctx: EventContext<UserCreatedPayload>): Promise<WelcomeEmailResult> => {
					return {
						emailSent: true,
						messageId: `msg-${ctx.data.userId}`
					};
				};

				onSuccess = async (
					_ctx: EventContext<UserCreatedPayload>,
					result: WelcomeEmailResult
				): Promise<void> => {
					expect(result.emailSent).toBe(true);
				};
			}

			const consumer = new UserCreatedConsumer();
			const ctx = createEventContext<UserCreatedPayload>({
				data: { userId: 'u-123', email: 'test@example.com' },
				eventId: 'evt-1',
				eventName: 'user.created',
				log: mockLogger,
				timestamp: Date.now()
			});

			const result = await consumer.onEvent(ctx);
			expect(result.emailSent).toBe(true);
			expect(result.messageId).toBe('msg-u-123');

			await consumer.onSuccess(ctx, result);
		});
	});
});

describe('WorkflowContext', () => {
	describe('type structure', () => {
		it('should have all required properties', () => {
			const ctx = createWorkflowContext<{ orderId: string }>({
				data: { orderId: 'ord-123' },
				flowId: 'wf-123',
				log: mockLogger
			});

			expect(ctx.data.orderId).toBe('ord-123');
			expect(ctx.flowId).toBe('wf-123');
		});

		it('should preserve data type through generic', () => {
			interface CheckoutData {
				orderId: string;
				userId: string;
				items: Array<{ productId: string; quantity: number }>;
			}

			const ctx = createWorkflowContext<CheckoutData>({
				data: {
					orderId: 'ord-1',
					userId: 'u-1',
					items: [{ productId: 'prod-1', quantity: 2 }]
				},
				flowId: 'wf-1',
				log: mockLogger
			});

			expect(typeof ctx.data.orderId).toBe('string');
			expect(typeof ctx.data.userId).toBe('string');
			expect(ctx.data.items[0]!.productId).toBe('prod-1');
		});
	});
});

// NOTE: WorkflowBuilder tests were removed - steps are now defined in WorkflowDefinition via .steps(),
// not in a builder passed to configure(). See StepBuilder tests in workflow-definition.test.ts.

describe('IWorkflowConsumer', () => {
	describe('basic implementation', () => {
		it('should allow implementation with required methods', () => {
			interface OrderData {
				orderId: string;
			}
			interface OrderResult {
				success: boolean;
			}

			// Simple workflow consumer without steps
			const consumer: IWorkflowConsumer<OrderData, OrderResult> = {
				onComplete: async (ctx) => {
					expect(typeof ctx.data.orderId).toBe('string');
					return { success: true };
				}
			};

			expect(typeof consumer.onComplete).toBe('function');
		});

		it('should allow synchronous onComplete', () => {
			const consumer: IWorkflowConsumer<{ id: string }, { done: boolean }> = {
				onComplete: (ctx) => {
					return { done: ctx.data.id.length > 0 };
				}
			};

			const ctx = createWorkflowContext<{ id: string }>({
				data: { id: 'test' },
				flowId: 'wf-1',
				log: mockLogger
			});

			const result = consumer.onComplete(ctx);
			expect(result).toEqual({ done: true });
		});

		it('should allow async onComplete', async () => {
			const consumer: IWorkflowConsumer<{ id: string }, { done: boolean }> = {
				onComplete: async (ctx) => {
					await Promise.resolve();
					return { done: ctx.data.id.length > 0 };
				}
			};

			const ctx = createWorkflowContext<{ id: string }>({
				data: { id: 'test' },
				flowId: 'wf-1',
				log: mockLogger
			});

			const result = await consumer.onComplete(ctx);
			expect(result).toEqual({ done: true });
		});
	});

	describe('steps property', () => {
		it('should allow optional steps property with step handlers', () => {
			interface OrderData {
				orderId: string;
				amount: number;
			}
			interface OrderResult {
				success: boolean;
			}
			interface OrderSteps {
				validate: { valid: boolean };
				charge: { chargeId: string };
			}

			const consumer: IWorkflowConsumer<OrderData, OrderResult, OrderSteps> = {
				steps: {
					validate: {
						execute: async (_ctx) => ({ valid: true })
					},
					charge: {
						execute: async (_ctx) => ({ chargeId: 'ch-123' }),
						rollback: async (_ctx) => {
							// Refund logic
						}
					}
				},
				onComplete: async (ctx) => {
					expect(typeof ctx.data.orderId).toBe('string');
					return { success: true };
				}
			};

			expect(consumer.steps).toBeDefined();
			expect(consumer.steps?.validate?.execute).toBeDefined();
			expect(consumer.steps?.charge?.execute).toBeDefined();
			expect(consumer.steps?.charge?.rollback).toBeDefined();
		});

		it('should allow step handlers to be executed', async () => {
			interface TestData {
				id: string;
			}
			interface TestSteps {
				process: { processed: boolean };
			}

			const mockStepContext: StepContext<TestData> = {
				flowId: 'wf-test',
				data: { id: 'test-123' },
				results: {},
				log: mockLogger,
				meta: {},
				stepName: 'process'
			};

			const consumer: IWorkflowConsumer<TestData, { done: boolean }, TestSteps> = {
				steps: {
					process: {
						execute: async (ctx) => {
							expect(ctx.data.id).toBe('test-123');
							return { processed: true };
						}
					}
				},
				onComplete: async () => ({ done: true })
			};

			const result = await consumer.steps?.process?.execute(mockStepContext);
			expect(result).toEqual({ processed: true });
		});
	});

	describe('error handling', () => {
		it('should allow optional onError callback', async () => {
			let errorCalled = false;

			const consumer: IWorkflowConsumer<{ id: string }, { ok: boolean }> = {
				onComplete: async () => {
					throw new Error('Workflow failed');
				},
				onError: async (ctx, error) => {
					errorCalled = true;
					expect(typeof ctx.data.id).toBe('string');
					expect(error.message).toBe('Workflow failed');
				}
			};

			const ctx = createWorkflowContext<{ id: string }>({
				data: { id: 'test' },
				flowId: 'wf-1',
				log: mockLogger
			});

			try {
				await consumer.onComplete(ctx);
			} catch (error) {
				await consumer.onError?.(ctx, error as Error);
			}

			expect(errorCalled).toBe(true);
		});
	});

	describe('class implementation', () => {
		it('should allow class-based workflow implementation', async () => {
			interface ProcessOrderData {
				orderId: string;
				items: Array<{ sku: string; quantity: number }>;
			}
			interface ProcessOrderResult {
				processed: boolean;
				totalItems: number;
			}

			class ProcessOrderWorkflow implements IWorkflowConsumer<ProcessOrderData, ProcessOrderResult> {
				onComplete = async (ctx: WorkflowContext<ProcessOrderData>): Promise<ProcessOrderResult> => {
					const totalItems = ctx.data.items.reduce((sum, item) => sum + item.quantity, 0);
					return { processed: true, totalItems };
				};

				onError = async (_ctx: WorkflowContext<ProcessOrderData>, error: Error): Promise<void> => {
					expect(error).toBeDefined();
				};
			}

			const workflow = new ProcessOrderWorkflow();
			const ctx = createWorkflowContext<ProcessOrderData>({
				data: {
					orderId: 'ord-123',
					items: [
						{ sku: 'A', quantity: 2 },
						{ sku: 'B', quantity: 3 }
					]
				},
				flowId: 'wf-1',
				log: mockLogger
			});

			const result = await workflow.onComplete(ctx);
			expect(result.processed).toBe(true);
			expect(result.totalItems).toBe(5);
		});

		it('should allow class-based workflow with steps', async () => {
			interface OrderData {
				orderId: string;
			}
			interface OrderResult {
				orderId: string;
				chargeId: string;
			}
			interface OrderSteps {
				validate: { valid: boolean };
				charge: { chargeId: string };
			}

			class OrderWorkflow implements IWorkflowConsumer<OrderData, OrderResult, OrderSteps> {
				steps = {
					validate: {
						execute: async (ctx: StepContext<OrderData>) => {
							return { valid: ctx.data.orderId.length > 0 };
						}
					},
					charge: {
						execute: async (_ctx: StepContext<OrderData>) => {
							return { chargeId: 'ch-123' };
						},
						rollback: async (_ctx: StepContext<OrderData>) => {
							// Refund logic
						}
					}
				};

				onComplete = async (ctx: WorkflowContext<OrderData>): Promise<OrderResult> => {
					const chargeResult = ctx.results['charge'] as { chargeId: string };
					return { orderId: ctx.data.orderId, chargeId: chargeResult.chargeId };
				};
			}

			const workflow = new OrderWorkflow();
			expect(workflow.steps.validate).toBeDefined();
			expect(workflow.steps.charge).toBeDefined();
			expect(workflow.steps.charge.rollback).toBeDefined();
		});
	});
});
