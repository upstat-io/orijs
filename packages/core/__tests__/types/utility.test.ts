/**
 * Tests for utility type extractors (Data, Result, EventConsumer, WorkflowConsumer, etc.)
 *
 * ## Testing Strategy for Utility Types
 *
 * Utility types extract inner types from EventDefinition and WorkflowDefinition.
 * Since TypeScript types are erased at runtime, we use multiple verification strategies:
 *
 * 1. **Type Assignment Tests** - Create variables with extracted types and verify
 *    they accept correctly-shaped data (if it compiles, the type is correct)
 *
 * 2. **@ts-expect-error Tests** - Verify that invalid types produce compile errors
 *    (e.g., Data<string> should fail because string is not a Definition)
 *
 * 3. **Functional Integration Tests** - Implement real consumer classes using the
 *    utility types to verify they work in realistic scenarios
 *
 * 4. **Type Constraint Tests** - Verify utility types reject invalid inputs at
 *    compile time using type constraints (not conditional types returning never)
 *
 * ## Type Carrier vs Type Extraction
 *
 * - **Type carriers** (_data, _result) are undefined at runtime
 *   but carry types for extraction via `typeof Definition['_data']`
 *
 * - **Utility types** (Data<T>, Result<T>, etc.) provide ergonomic access to
 *   these carried types with compile-time validation
 *
 * @see event-definition.test.ts for Event.define() factory tests
 * @see workflow-definition.test.ts for Workflow.define() factory tests
 * @see type-extractors.test.ts for pure type extractor tests (no consumer deps)
 */

import { describe, expect, it } from 'bun:test';
import { Type } from '@orijs/validation';
import { Logger } from '@orijs/logging';
import { Event } from '../../src/types/event-definition.ts';
import { Workflow } from '../../src/types/workflow-definition.ts';
import type {
	Data,
	Result,
	EventConsumer,
	EventCtx,
	WorkflowConsumer,
	WorkflowCtx
} from '../../src/types/utility.ts';

// Mock logger for test contexts
const mockLogger = new Logger('test');

describe('Event Utility Types', () => {
	// Define a test event
	const UserCreated = Event.define({
		name: 'user.created',
		data: Type.Object({
			userId: Type.String(),
			email: Type.String()
		}),
		result: Type.Object({
			welcomeEmailSent: Type.Boolean()
		})
	});

	describe('Data<T> for events', () => {
		it('should extract data type from EventDefinition', () => {
			// This is a compile-time check - if it compiles, the type is correct
			type ExtractedData = Data<typeof UserCreated>;

			// Runtime verification that the pattern works
			const data: ExtractedData = { userId: '123', email: 'test@example.com' };
			expect(data.userId).toBe('123');
			expect(data.email).toBe('test@example.com');
		});

		it('should produce compile error for non-definition types', () => {
			// Type-level test: Data<T> produces compile error for invalid types
			// Verified via @ts-expect-error - if error disappears, test fails

			// @ts-expect-error - Type does not satisfy constraint
			type _Invalid = Data<string>;

			expect(true).toBe(true);
		});
	});

	describe('Result<T> for events', () => {
		it('should extract result type from EventDefinition', () => {
			type ExtractedResult = Result<typeof UserCreated>;

			const result: ExtractedResult = { welcomeEmailSent: true };
			expect(result.welcomeEmailSent).toBe(true);
		});

		it('should handle void result', () => {
			const VoidEvent = Event.define({
				name: 'void.event',
				data: Type.Object({ id: Type.String() }),
				result: Type.Void()
			});

			type VoidResult = Result<typeof VoidEvent>;
			const fn = (): VoidResult => {
				// void function returns undefined
			};
			expect(fn()).toBeUndefined();
		});
	});

	describe('EventConsumer<T>', () => {
		it('should return IEventConsumer typed for the definition', () => {
			// EventConsumer<typeof UserCreated> should be IEventConsumer<{ userId: string, email: string }, { welcomeEmailSent: boolean }>
			type UserCreatedConsumer = EventConsumer<typeof UserCreated>;

			// Create a mock consumer to verify the type
			const consumer: UserCreatedConsumer = {
				onEvent: async (ctx) => {
					// ctx.data should be typed - verify userId is accessible as string
					expect(typeof ctx.data.userId).toBe('string');
					return { welcomeEmailSent: true };
				}
			};

			expect(consumer.onEvent).toBeDefined();
		});

		it('should support optional lifecycle hooks', () => {
			type UserCreatedConsumer = EventConsumer<typeof UserCreated>;

			const consumer: UserCreatedConsumer = {
				onEvent: async () => ({ welcomeEmailSent: true }),
				onSuccess: async (_ctx, result) => {
					// result should be typed - verify welcomeEmailSent is accessible as boolean
					expect(typeof result.welcomeEmailSent).toBe('boolean');
				},
				onError: async (_ctx, error) => {
					// error should be Error - verify message is accessible as string
					expect(typeof error.message).toBe('string');
				}
			};

			expect(consumer.onSuccess).toBeDefined();
			expect(consumer.onError).toBeDefined();
		});
	});

	describe('EventCtx<T>', () => {
		it('should return EventContext typed for the definition', () => {
			type UserCreatedContext = EventCtx<typeof UserCreated>;

			// Create a mock context to verify the type
			const ctx: UserCreatedContext = {
				data: { userId: '123', email: 'test@example.com' },
				eventId: 'evt-123',
				eventName: 'user.created',
				log: mockLogger,
				timestamp: Date.now(),
				correlationId: 'corr-123',
				emit: () => ({ wait: async () => undefined as never })
			};

			expect(ctx.data.userId).toBe('123');
			expect(ctx.eventName).toBe('user.created');
		});
	});
});

describe('Workflow Utility Types', () => {
	// Define a test workflow
	const SendEmail = Workflow.define({
		name: 'send-email',
		data: Type.Object({
			to: Type.String(),
			subject: Type.String(),
			body: Type.String()
		}),
		result: Type.Object({
			messageId: Type.String(),
			sentAt: Type.String()
		})
	});

	describe('Data<T> for workflows', () => {
		it('should extract data type from WorkflowDefinition', () => {
			type ExtractedData = Data<typeof SendEmail>;

			const extractedData: ExtractedData = {
				to: 'user@example.com',
				subject: 'Hello',
				body: 'World'
			};
			expect(extractedData.to).toBe('user@example.com');
		});
	});

	describe('Result<T> for workflows', () => {
		it('should extract result type from WorkflowDefinition', () => {
			type ExtractedResult = Result<typeof SendEmail>;

			const result: ExtractedResult = {
				messageId: 'msg-123',
				sentAt: '2024-01-01T00:00:00Z'
			};
			expect(result.messageId).toBe('msg-123');
		});

		it('should handle void result', () => {
			const VoidWorkflow = Workflow.define({
				name: 'void-workflow',
				data: Type.Object({ id: Type.String() }),
				result: Type.Void()
			});

			type VoidResult = Result<typeof VoidWorkflow>;
			const fn = (): VoidResult => {
				// void function
			};
			expect(fn()).toBeUndefined();
		});
	});

	describe('WorkflowConsumer<T>', () => {
		it('should return IWorkflowConsumer typed for the definition', () => {
			type SendEmailConsumer = WorkflowConsumer<typeof SendEmail>;

			const consumer: SendEmailConsumer = {
				onComplete: async (ctx) => {
					// ctx.data should be typed - verify to is accessible as string
					expect(typeof ctx.data.to).toBe('string');
					return { messageId: 'msg-123', sentAt: new Date().toISOString() };
				}
			};

			expect(consumer.onComplete).toBeDefined();
		});

		it('should support optional error handler', () => {
			type SendEmailConsumer = WorkflowConsumer<typeof SendEmail>;

			const consumer: SendEmailConsumer = {
				onComplete: async () => ({ messageId: 'msg-123', sentAt: '' }),
				onError: async (_ctx, error) => {
					// error should be Error - verify message is accessible as string
					expect(typeof error.message).toBe('string');
				}
			};

			expect(consumer.onError).toBeDefined();
		});
	});

	describe('WorkflowCtx<T>', () => {
		it('should return WorkflowContext typed for the definition', () => {
			type SendEmailContext = WorkflowCtx<typeof SendEmail>;

			const ctx: SendEmailContext = {
				data: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
				flowId: 'wf-123',
				log: mockLogger,
				results: {},
				meta: {},
				correlationId: 'corr-123'
			};

			expect(ctx.data.to).toBe('user@example.com');
			expect(ctx.flowId).toBe('wf-123');
		});
	});
});

describe('Type Safety - Compile-time checks', () => {
	/**
	 * These tests verify type safety at compile time using @ts-expect-error.
	 * If the code compiles, the types are working correctly.
	 * @ts-expect-error directives verify that invalid code produces compile errors.
	 */

	it('should enforce correct data types', () => {
		const UserCreated = Event.define({
			name: 'user.created',
			data: Type.Object({ userId: Type.String() }),
			result: Type.Void()
		});

		type DataType = (typeof UserCreated)['_data'];

		// This should compile
		const validData: DataType = { userId: '123' };
		expect(validData.userId).toBe('123');

		// These produce compile errors - verified via @ts-expect-error
		// @ts-expect-error - Type 'number' is not assignable to type 'string'
		const _invalidData: DataType = { userId: 123 };

		// @ts-expect-error - Property 'userId' is missing in type '{}'
		const _missingField: DataType = {};

		expect(true).toBe(true); // Runtime assertion for test validity
	});

	it('should enforce correct result types', () => {
		const UserCreated = Event.define({
			name: 'user.created',
			data: Type.Object({ userId: Type.String() }),
			result: Type.Object({ sent: Type.Boolean() })
		});

		type ResultType = (typeof UserCreated)['_result'];

		// This should compile
		const validResult: ResultType = { sent: true };
		expect(validResult.sent).toBe(true);

		// This produces compile error - verified via @ts-expect-error
		// @ts-expect-error - Type 'string' is not assignable to type 'boolean'
		const _invalidResult: ResultType = { sent: 'yes' };

		expect(true).toBe(true); // Runtime assertion for test validity
	});
});

describe('Functional Integration - Consumer Class Implementations', () => {
	/**
	 * These tests demonstrate real-world usage patterns where utility types
	 * are used to implement full consumer classes with type safety.
	 */

	const OrderPlaced = Event.define({
		name: 'order.placed',
		data: Type.Object({
			orderId: Type.String(),
			customerId: Type.String(),
			items: Type.Array(
				Type.Object({
					productId: Type.String(),
					quantity: Type.Number()
				})
			),
			totalAmount: Type.Number()
		}),
		result: Type.Object({
			confirmationNumber: Type.String(),
			estimatedDelivery: Type.String()
		})
	});

	it('should allow implementing a full consumer class with EventConsumer<T>', () => {
		// Real-world pattern: class implementing EventConsumer<T>
		class OrderPlacedConsumer implements EventConsumer<typeof OrderPlaced> {
			private processedOrders: string[] = [];

			onEvent = async (ctx: EventCtx<typeof OrderPlaced>): Promise<Result<typeof OrderPlaced>> => {
				// Access strongly-typed data
				const { orderId, customerId, items, totalAmount } = ctx.data;

				// Business logic
				this.processedOrders.push(orderId);
				const itemCount = items.reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0);

				// Return strongly-typed result
				return {
					confirmationNumber: `CONF-${orderId}-${customerId}`,
					estimatedDelivery: `${itemCount} items, $${totalAmount} - 3-5 business days`
				};
			};

			onSuccess = async (_ctx: EventCtx<typeof OrderPlaced>, result: Result<typeof OrderPlaced>) => {
				// Access typed result
				expect(result.confirmationNumber).toContain('CONF-');
			};

			onError = async (_ctx: EventCtx<typeof OrderPlaced>, error: Error) => {
				console.error(`Order processing failed: ${error.message}`);
			};

			getProcessedOrders(): string[] {
				return this.processedOrders;
			}
		}

		const consumer = new OrderPlacedConsumer();

		// Simulate event handling
		const mockCtx: EventCtx<typeof OrderPlaced> = {
			data: {
				orderId: 'ORD-001',
				customerId: 'CUST-123',
				items: [
					{ productId: 'PROD-A', quantity: 2 },
					{ productId: 'PROD-B', quantity: 1 }
				],
				totalAmount: 99.99
			},
			eventId: 'evt-001',
			eventName: 'order.placed',
			log: mockLogger,
			timestamp: Date.now(),
			correlationId: 'corr-001',
			emit: () => ({ wait: async () => undefined as never })
		};

		// Execute and verify
		const resultPromise = consumer.onEvent(mockCtx);
		expect(resultPromise).toBeInstanceOf(Promise);

		resultPromise.then((result) => {
			expect(result.confirmationNumber).toBe('CONF-ORD-001-CUST-123');
			expect(result.estimatedDelivery).toContain('3 items');
			expect(consumer.getProcessedOrders()).toContain('ORD-001');
		});
	});

	it('should allow implementing workflow consumer with WorkflowConsumer<T>', () => {
		const ProcessRefund = Workflow.define({
			name: 'process-refund',
			data: Type.Object({
				orderId: Type.String(),
				reason: Type.String(),
				amount: Type.Number()
			}),
			result: Type.Object({
				refundId: Type.String(),
				status: Type.Union([Type.Literal('approved'), Type.Literal('rejected')]),
				processedAt: Type.String()
			})
		});

		// Real-world pattern: class implementing WorkflowConsumer<T>
		class ProcessRefundWorkflow implements WorkflowConsumer<typeof ProcessRefund> {
			onComplete = async (ctx: WorkflowCtx<typeof ProcessRefund>): Promise<Result<typeof ProcessRefund>> => {
				const { orderId, reason, amount } = ctx.data;

				// Business logic
				const approved = amount < 1000 && reason !== 'fraud';

				return {
					refundId: `REF-${orderId}-${Date.now()}`,
					status: approved ? 'approved' : 'rejected',
					processedAt: new Date().toISOString()
				};
			};

			onError = async (_ctx: WorkflowCtx<typeof ProcessRefund>, error: Error) => {
				console.error(`Refund processing failed: ${error.message}`);
			};
		}

		const workflow = new ProcessRefundWorkflow();

		const mockCtx: WorkflowCtx<typeof ProcessRefund> = {
			data: {
				orderId: 'ORD-001',
				reason: 'defective',
				amount: 50.0
			},
			flowId: 'wf-001',
			log: mockLogger,
			results: {},
			meta: {},
			correlationId: 'corr-001'
		};

		const resultPromise = workflow.onComplete(mockCtx);
		expect(resultPromise).toBeInstanceOf(Promise);

		resultPromise.then((result) => {
			expect(result.status).toBe('approved');
			expect(result.refundId).toContain('REF-ORD-001');
		});
	});

	it('should extract and use Data/Result types in helper functions', () => {
		// Pattern: Using extracted types in utility functions
		function validateOrderData(data: Data<typeof OrderPlaced>): boolean {
			return data.items.length > 0 && data.totalAmount > 0;
		}

		function formatConfirmation(result: Result<typeof OrderPlaced>): string {
			return `Order confirmed: ${result.confirmationNumber}, delivery: ${result.estimatedDelivery}`;
		}

		const validData: Data<typeof OrderPlaced> = {
			orderId: 'ORD-002',
			customerId: 'CUST-456',
			items: [{ productId: 'PROD-C', quantity: 5 }],
			totalAmount: 149.99
		};

		const result: Result<typeof OrderPlaced> = {
			confirmationNumber: 'CONF-002',
			estimatedDelivery: '2-3 days'
		};

		expect(validateOrderData(validData)).toBe(true);
		expect(formatConfirmation(result)).toContain('CONF-002');
	});
});
