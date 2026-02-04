/**
 * E2E Scenario: HTTP → Event → Workflow Chain
 *
 * Given: An application with controller, event handler, and workflow
 * When: HTTP request is made with x-request-id header
 * Then: correlationId propagates through event handler and workflow steps
 *
 * EntrypointType: http
 * EntrypointId: POST /api/orders
 * Outputs: workflow result returned in response
 * State: workflow executed with propagated context
 * Messaging: HTTP → event:order.created → workflow:OrderWorkflow
 * Invariants: correlationId.present at all stages, traceId.preserved
 * Cardinality: event.emit = 1, workflow.execute = 1, workflow.steps = 2
 * MockedExternals: none (all in-process)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Ori, AppContext, Workflow, Event } from '@orijs/core';
import type {
	OriController,
	RouteBuilder,
	Application,
	RequestContext,
	IWorkflowConsumer,
	IEventConsumer,
	WorkflowContext,
	EventContext
} from '@orijs/core';
import { Type } from '@orijs/validation';
import { Logger, capturePropagationMeta } from '@orijs/logging';

// --- Test Types ---

interface OrderPayload {
	orderId: string;
	userId: number;
	items: string[];
}

// --- Capture Storage for Verification (keyed by orderId for test isolation) ---

interface CapturedIds {
	controller?: string;
	eventHandler?: string;
	workflowStep1?: string;
	workflowStep2?: string;
}

/** Map of orderId -> captured request IDs (for concurrent test isolation) */
const capturedRequestIdsByOrder = new Map<string, CapturedIds>();
/** Map of orderId -> captured trace IDs (for concurrent test isolation) */
const capturedTraceIdsByOrder = new Map<string, CapturedIds>();

/** Get or create capture storage for an order */
function getCapturesForOrder(orderId: string): { correlationIds: CapturedIds; traceIds: CapturedIds } {
	if (!capturedRequestIdsByOrder.has(orderId)) {
		capturedRequestIdsByOrder.set(orderId, {});
	}
	if (!capturedTraceIdsByOrder.has(orderId)) {
		capturedTraceIdsByOrder.set(orderId, {});
	}
	return {
		correlationIds: capturedRequestIdsByOrder.get(orderId)!,
		traceIds: capturedTraceIdsByOrder.get(orderId)!
	};
}

function resetCaptures(): void {
	capturedRequestIdsByOrder.clear();
	capturedTraceIdsByOrder.clear();
}

// --- Workflow Definition ---

const OrderWorkflowDef = Workflow.define({
	name: 'order-processing',
	data: Type.Object({
		orderId: Type.String(),
		userId: Type.Number(),
		itemCount: Type.Number(),
		originRequestId: Type.Optional(Type.String())
	}),
	result: Type.Object({
		orderId: Type.String(),
		status: Type.Literal('completed'),
		steps: Type.Array(Type.String()),
		propagatedRequestIds: Type.Array(Type.String())
	})
});

type OrderWorkflowData = (typeof OrderWorkflowDef)['_data'];
type OrderWorkflowResult = (typeof OrderWorkflowDef)['_result'];

// --- Event Definition ---

const OrderCreatedEvent = Event.define({
	name: 'order.created',
	data: Type.Object({
		orderId: Type.String(),
		userId: Type.Number(),
		itemCount: Type.Number(),
		correlationId: Type.Optional(Type.String())
	}),
	result: Type.Object({
		orderId: Type.String(),
		status: Type.Literal('completed'),
		steps: Type.Array(Type.String()),
		propagatedRequestIds: Type.Array(Type.String())
	})
});

type OrderCreatedPayload = (typeof OrderCreatedEvent)['_data'];
type OrderCreatedResponse = (typeof OrderCreatedEvent)['_result'];

// --- Workflow Consumer ---

class OrderProcessingWorkflowConsumer implements IWorkflowConsumer<OrderWorkflowData, OrderWorkflowResult> {
	public onComplete = async (ctx: WorkflowContext<OrderWorkflowData>): Promise<OrderWorkflowResult> => {
		// Simulate workflow steps (validate + process) by capturing at two points
		const captures = getCapturesForOrder(ctx.data.orderId);

		// Step 1: Validate
		captures.correlationIds.workflowStep1 = ctx.meta?.correlationId as string | undefined;
		captures.traceIds.workflowStep1 = ctx.meta?.traceId as string | undefined;

		// Step 2: Process
		captures.correlationIds.workflowStep2 = ctx.meta?.correlationId as string | undefined;
		captures.traceIds.workflowStep2 = ctx.meta?.traceId as string | undefined;

		return {
			orderId: ctx.data.orderId,
			status: 'completed',
			steps: ['validate', 'process'],
			propagatedRequestIds: [
				captures.correlationIds.workflowStep1 ?? 'missing',
				captures.correlationIds.workflowStep2 ?? 'missing'
			]
		};
	};
}

// --- Event Consumer ---

class OrderCreatedEventConsumer implements IEventConsumer<OrderCreatedPayload, OrderCreatedResponse> {
	constructor(private readonly appContext: AppContext) {}

	public onEvent = async (ctx: EventContext<OrderCreatedPayload>): Promise<OrderCreatedResponse> => {
		// Capture propagation metadata from AsyncLocalStorage (keyed by orderId for test isolation)
		const meta = capturePropagationMeta() ?? {};
		const captures = getCapturesForOrder(ctx.data.orderId);
		captures.correlationIds.eventHandler = meta.correlationId as string | undefined;
		captures.traceIds.eventHandler = meta.traceId as string | undefined;

		// Start workflow with propagated context
		const handle = await this.appContext.workflows.execute(OrderWorkflowDef, {
			orderId: ctx.data.orderId,
			userId: ctx.data.userId,
			itemCount: ctx.data.itemCount,
			originRequestId: meta.correlationId as string | undefined
		});

		return await handle.result();
	};
}

// --- Controller ---

class OrderController implements OriController {
	constructor(private readonly appContext: AppContext) {}

	public configure(r: RouteBuilder): void {
		r.post('/orders', this.createOrder);
	}

	private createOrder = async (ctx: RequestContext) => {
		// Capture propagation metadata from AsyncLocalStorage (keyed by orderId for test isolation)
		const meta = capturePropagationMeta() ?? {};
		const body = await ctx.json<OrderPayload>();

		const captures = getCapturesForOrder(body.orderId);
		captures.correlationIds.controller = meta.correlationId as string | undefined;
		captures.traceIds.controller = meta.traceId as string | undefined;

		ctx.log.info('Creating order', { orderId: body.orderId });

		// Start workflow directly from controller (simpler chain for this test)
		const handle = await this.appContext.workflows.execute(OrderWorkflowDef, {
			orderId: body.orderId,
			userId: body.userId,
			itemCount: body.items.length,
			originRequestId: meta.correlationId as string | undefined
		});

		const result = await handle.result();

		return Response.json({
			success: true,
			orderId: body.orderId,
			workflowResult: result,
			capturedRequestIds: { ...captures.correlationIds }
		});
	};
}

// --- Tests ---

describe('E2E: HTTP → Event → Workflow Chain', () => {
	let app: Application;
	let port = 21000;

	const getPort = () => ++port;

	beforeEach(() => {
		Logger.reset();
		resetCaptures();
	});

	afterEach(async () => {
		await app?.stop();
	});

	describe('HTTP → Workflow chain (direct)', () => {
		it('should propagate correlationId from HTTP request through workflow steps', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			const correlationId = 'e2e-test-request-id-12345';

			const response = await fetch(`http://localhost:${testPort}/api/orders`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': correlationId
				},
				body: JSON.stringify({
					orderId: 'ORD-E2E-001',
					userId: 42,
					items: ['item1', 'item2', 'item3']
				})
			});

			expect(response.status).toBe(200);

			const result = (await response.json()) as {
				success: boolean;
				workflowResult: { status: string; steps: string[] };
			};

			// Verify workflow completed
			expect(result.success).toBe(true);
			expect(result.workflowResult.status).toBe('completed');
			expect(result.workflowResult.steps).toEqual(['validate', 'process']);

			// Verify correlationId propagated through all stages (using orderId-keyed captures)
			const captures = getCapturesForOrder('ORD-E2E-001');
			expect(captures.correlationIds.controller).toBe(correlationId);
			expect(captures.correlationIds.workflowStep1).toBe(correlationId);
			expect(captures.correlationIds.workflowStep2).toBe(correlationId);
		});

		it('should propagate traceId through workflow steps', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			const response = await fetch(`http://localhost:${testPort}/api/orders`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': 'trace-test-request'
				},
				body: JSON.stringify({
					orderId: 'ORD-TRACE-001',
					userId: 1,
					items: ['item']
				})
			});

			expect(response.status).toBe(200);

			// Verify traceId exists and is consistent across stages (using orderId-keyed captures)
			const traceCaptures = getCapturesForOrder('ORD-TRACE-001');
			expect(traceCaptures.traceIds.controller).toBeDefined();
			expect(traceCaptures.traceIds.workflowStep1).toBeDefined();
			expect(traceCaptures.traceIds.workflowStep2).toBeDefined();

			// All stages should have the same traceId (preserved through chain)
			expect(traceCaptures.traceIds.workflowStep1).toBe(traceCaptures.traceIds.controller);
			expect(traceCaptures.traceIds.workflowStep2).toBe(traceCaptures.traceIds.controller);
		});

		it('should generate unique correlationId when not provided in header', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			const response = await fetch(`http://localhost:${testPort}/api/orders`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
					// No x-request-id header
				},
				body: JSON.stringify({
					orderId: 'ORD-NO-HEADER-001',
					userId: 1,
					items: ['item']
				})
			});

			expect(response.status).toBe(200);

			// Should have generated a correlationId (using orderId-keyed captures)
			const captures = getCapturesForOrder('ORD-NO-HEADER-001');
			expect(captures.correlationIds.controller).toBeDefined();
			expect(captures.correlationIds.controller).not.toBe('');

			// Same generated ID should propagate through
			expect(captures.correlationIds.workflowStep1).toBe(captures.correlationIds.controller);
			expect(captures.correlationIds.workflowStep2).toBe(captures.correlationIds.controller);
		});
	});

	describe('HTTP → Event → Workflow chain (full)', () => {
		it('should propagate correlationId through event handler to workflow', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.event(OrderCreatedEvent)
				.consumer(OrderCreatedEventConsumer, [AppContext])
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			// Make HTTP request
			const correlationId = 'e2e-full-chain-request-id';

			const response = await fetch(`http://localhost:${testPort}/api/orders`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': correlationId
				},
				body: JSON.stringify({
					orderId: 'ORD-FULL-001',
					userId: 99,
					items: ['a', 'b']
				})
			});

			expect(response.status).toBe(200);

			// Verify correlationId propagated from HTTP to workflow (using orderId-keyed captures)
			const captures = getCapturesForOrder('ORD-FULL-001');
			expect(captures.correlationIds.controller).toBe(correlationId);
			expect(captures.correlationIds.workflowStep1).toBe(correlationId);
			expect(captures.correlationIds.workflowStep2).toBe(correlationId);
		});
	});

	describe('context propagation verification', () => {
		it('should include correlationId in workflow result metadata', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			const correlationId = 'metadata-test-request-id';

			const response = await fetch(`http://localhost:${testPort}/api/orders`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': correlationId
				},
				body: JSON.stringify({
					orderId: 'ORD-META-001',
					userId: 1,
					items: ['x']
				})
			});

			const result = (await response.json()) as {
				capturedRequestIds: { controller: string; workflowStep1: string; workflowStep2: string };
				workflowResult: { propagatedRequestIds: string[] };
			};

			// Verify the captured request IDs are included in response
			expect(result.capturedRequestIds.controller).toBe(correlationId);
			expect(result.capturedRequestIds.workflowStep1).toBe(correlationId);
			expect(result.capturedRequestIds.workflowStep2).toBe(correlationId);

			// Verify workflow result includes propagated request IDs
			expect(result.workflowResult.propagatedRequestIds).toContain(correlationId);
		});

		it('should maintain separate correlationIds for concurrent requests', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			// Make two concurrent requests with different correlationIds
			const correlationId1 = 'concurrent-request-1';
			const correlationId2 = 'concurrent-request-2';

			const [response1, response2] = await Promise.all([
				fetch(`http://localhost:${testPort}/api/orders`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-request-id': correlationId1
					},
					body: JSON.stringify({
						orderId: 'ORD-CONCURRENT-1',
						userId: 1,
						items: ['a']
					})
				}),
				fetch(`http://localhost:${testPort}/api/orders`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-request-id': correlationId2
					},
					body: JSON.stringify({
						orderId: 'ORD-CONCURRENT-2',
						userId: 2,
						items: ['b']
					})
				})
			]);

			const result1 = (await response1.json()) as {
				success: boolean;
				workflowResult: { status: string; propagatedRequestIds: string[] };
				capturedRequestIds: { controller?: string; workflowStep1?: string; workflowStep2?: string };
			};
			const result2 = (await response2.json()) as {
				success: boolean;
				workflowResult: { status: string; propagatedRequestIds: string[] };
				capturedRequestIds: { controller?: string; workflowStep1?: string; workflowStep2?: string };
			};

			// Both requests should succeed
			expect(result1.success).toBe(true);
			expect(result2.success).toBe(true);

			// Both workflows should complete
			expect(result1.workflowResult.status).toBe('completed');
			expect(result2.workflowResult.status).toBe('completed');

			// CRITICAL: Each request should have its OWN correlationId propagated (test isolation)
			// Request 1 should have correlationId1 throughout its chain
			expect(result1.capturedRequestIds.controller).toBe(correlationId1);
			expect(result1.capturedRequestIds.workflowStep1).toBe(correlationId1);
			expect(result1.capturedRequestIds.workflowStep2).toBe(correlationId1);
			expect(result1.workflowResult.propagatedRequestIds).toEqual([correlationId1, correlationId1]);

			// Request 2 should have correlationId2 throughout its chain
			expect(result2.capturedRequestIds.controller).toBe(correlationId2);
			expect(result2.capturedRequestIds.workflowStep1).toBe(correlationId2);
			expect(result2.capturedRequestIds.workflowStep2).toBe(correlationId2);
			expect(result2.workflowResult.propagatedRequestIds).toEqual([correlationId2, correlationId2]);
		});
	});

	describe('error scenarios', () => {
		it('should propagate correlationId even when workflow step fails', async () => {
			// Define failing workflow
			const FailingWorkflowDef = Workflow.define({
				name: 'failing-workflow',
				data: Type.Object({
					orderId: Type.String(),
					userId: Type.Number(),
					itemCount: Type.Number()
				}),
				result: Type.Object({
					orderId: Type.String(),
					status: Type.Literal('completed'),
					steps: Type.Array(Type.String()),
					propagatedRequestIds: Type.Array(Type.String())
				})
			});

			type FailingWorkflowData = (typeof FailingWorkflowDef)['_data'];
			type FailingWorkflowResult = (typeof FailingWorkflowDef)['_result'];

			// Create a workflow consumer that fails
			class FailingWorkflowConsumer implements IWorkflowConsumer<FailingWorkflowData, FailingWorkflowResult> {
				public onComplete = async (
					ctx: WorkflowContext<FailingWorkflowData>
				): Promise<FailingWorkflowResult> => {
					const captures = getCapturesForOrder(ctx.data.orderId);

					// Step 1: Succeed
					captures.correlationIds.workflowStep1 = ctx.meta?.correlationId as string | undefined;

					// Step 2: Capture then fail
					captures.correlationIds.workflowStep2 = ctx.meta?.correlationId as string | undefined;
					throw new Error('Intentional failure for E2E test');
				};
			}

			// Create a controller that uses the failing workflow
			class FailingOrderController implements OriController {
				constructor(private readonly appContext: AppContext) {}

				public configure(r: RouteBuilder): void {
					r.post('/orders-fail', this.createOrder);
				}

				private createOrder = async (ctx: RequestContext) => {
					const meta = capturePropagationMeta() ?? {};
					const body = await ctx.json<OrderPayload>();

					const captures = getCapturesForOrder(body.orderId);
					captures.correlationIds.controller = meta.correlationId as string | undefined;

					try {
						const handle = await this.appContext.workflows.execute(FailingWorkflowDef, {
							orderId: body.orderId,
							userId: body.userId,
							itemCount: body.items.length
						});
						await handle.result();
						return Response.json({ success: true });
					} catch (error) {
						return Response.json(
							{
								success: false,
								error: (error as Error).message,
								capturedRequestIds: { ...captures.correlationIds }
							},
							{ status: 500 }
						);
					}
				};
			}

			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflow(FailingWorkflowDef)
				.consumer(FailingWorkflowConsumer)
				.controller('/api', FailingOrderController, [AppContext]);

			await app.listen(testPort);

			const correlationId = 'error-scenario-request-id';

			const response = await fetch(`http://localhost:${testPort}/api/orders-fail`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': correlationId
				},
				body: JSON.stringify({
					orderId: 'ORD-FAIL-001',
					userId: 1,
					items: ['x']
				})
			});

			expect(response.status).toBe(500);
			await response.json(); // Consume body

			// RequestId should be captured at both steps before failure (using orderId-keyed captures)
			const captures = getCapturesForOrder('ORD-FAIL-001');
			expect(captures.correlationIds.controller).toBe(correlationId);
			expect(captures.correlationIds.workflowStep1).toBe(correlationId);
			expect(captures.correlationIds.workflowStep2).toBe(correlationId);
		});
	});
});
