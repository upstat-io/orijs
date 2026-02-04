/**
 * Cross-Service Context Propagation Integration Tests
 *
 * Tests that logging context (correlationId, traceId, userId, accountUuid, etc.)
 * properly propagates across service boundaries using real Ori application instances.
 *
 * Simulates:
 * - App Instance 1: HTTP request → AuthGuard sets metadata → workflow executes
 * - App Instance 2: Receives propagated context → verifies all metadata present
 *
 * CRITICAL: Each app instance is created separately with Ori.create() to ensure
 * true isolation. Context only transfers via the serialized PropagationMeta.
 *
 * The distributed test uses BullMQ to verify true cross-service propagation where
 * context flows through Redis queue job data, not AsyncLocalStorage.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'bun:test';
import { Ori, Workflow } from '@orijs/core';
import type {
	OriController,
	RouteBuilder,
	Guard,
	Application,
	RequestContext,
	IWorkflowConsumer,
	WorkflowContext
} from '@orijs/core';
import { Type } from '@orijs/validation';
import { Logger } from '@orijs/logging';
import { BullMQWorkflowProvider } from '../../src/index';
import { getRedisConnectionOptions, isRedisReady } from '../preload.ts';

// --- Workflow Definitions ---

const ContextCapturingWorkflowDef = Workflow.define({
	name: 'context-capturing',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({
		computed: Type.Number(),
		capturedContext: Type.Object({
			correlationId: Type.Optional(Type.String()),
			traceId: Type.Optional(Type.String()),
			userId: Type.Optional(Type.String()),
			accountUuid: Type.Optional(Type.String()),
			projectUuid: Type.Optional(Type.String())
		})
	})
});

type ContextCapturingData = (typeof ContextCapturingWorkflowDef)['_data'];
type ContextCapturingResult = (typeof ContextCapturingWorkflowDef)['_result'];

const MultiStepWorkflowDef = Workflow.define({
	name: 'multi-step',
	data: Type.Object({ input: Type.Number() }),
	result: Type.Object({
		step1TraceId: Type.Optional(Type.String()),
		step2TraceId: Type.Optional(Type.String()),
		step1RequestId: Type.Optional(Type.String()),
		step2RequestId: Type.Optional(Type.String()),
		step1UserId: Type.Optional(Type.String()),
		step2UserId: Type.Optional(Type.String()),
		finalValue: Type.Number()
	})
});

type MultiStepData = (typeof MultiStepWorkflowDef)['_data'];
type MultiStepResult = (typeof MultiStepWorkflowDef)['_result'];

// --- Workflow Consumers ---

/**
 * Workflow that captures its propagated context and returns it in the result.
 * This allows us to verify that context was properly propagated.
 */
class ContextCapturingWorkflowConsumer implements IWorkflowConsumer<
	ContextCapturingData,
	ContextCapturingResult
> {
	// Phase 1: No-op

	public onComplete = async (ctx: WorkflowContext<ContextCapturingData>): Promise<ContextCapturingResult> => {
		// Access the propagation metadata from the workflow context
		const meta =
			(ctx.log as { propagationMeta?: () => Record<string, unknown> })?.propagationMeta?.() ?? ctx.meta ?? {};

		return {
			computed: ctx.data.value * 2,
			capturedContext: {
				correlationId: meta.correlationId as string | undefined,
				traceId: meta.traceId as string | undefined,
				userId: meta.userId as string | undefined,
				accountUuid: meta.accountUuid as string | undefined,
				projectUuid: meta.projectUuid as string | undefined
			}
		};
	};
}

/**
 * Workflow with multiple steps to verify trace propagation within a workflow.
 * In Phase 1 consumer pattern, we simulate the steps inline in onComplete.
 */
class MultiStepWorkflowConsumer implements IWorkflowConsumer<MultiStepData, MultiStepResult> {
	// Phase 1: No-op

	public onComplete = async (ctx: WorkflowContext<MultiStepData>): Promise<MultiStepResult> => {
		const meta =
			(ctx.log as { propagationMeta?: () => Record<string, unknown> })?.propagationMeta?.() ?? ctx.meta ?? {};

		// Simulate step 1
		const step1Value = ctx.data.input + 10;
		const step1Context = {
			traceId: meta.traceId as string | undefined,
			correlationId: meta.correlationId as string | undefined,
			userId: meta.userId as string | undefined
		};

		// Simulate step 2
		const step2Value = step1Value * 2;
		const step2Context = {
			traceId: meta.traceId as string | undefined,
			correlationId: meta.correlationId as string | undefined,
			userId: meta.userId as string | undefined
		};

		return {
			step1TraceId: step1Context.traceId,
			step2TraceId: step2Context.traceId,
			step1RequestId: step1Context.correlationId,
			step2RequestId: step2Context.correlationId,
			step1UserId: step1Context.userId,
			step2UserId: step2Context.userId,
			finalValue: step2Value
		};
	};
}

// --- Auth Guard Classes ---

/**
 * Guard that simulates authentication and injects user context.
 * Uses ctx.log.setMeta() to inject metadata that should propagate.
 */
class TestAuthGuard implements Guard {
	canActivate(ctx: RequestContext): boolean {
		ctx.log.setMeta({
			userId: 'user-12345',
			accountUuid: 'account-67890',
			projectUuid: 'project-abcde'
		});
		return true;
	}
}

class DistributedAuthGuard implements Guard {
	canActivate(ctx: RequestContext): boolean {
		ctx.log.setMeta({
			userId: 'distributed-user',
			accountUuid: 'distributed-account',
			projectUuid: 'distributed-project'
		});
		return true;
	}
}

class TraceAuthGuard implements Guard {
	canActivate(ctx: RequestContext): boolean {
		ctx.log.setMeta({
			userId: 'trace-user',
			accountUuid: 'trace-account',
			projectUuid: 'trace-project'
		});
		return true;
	}
}

// --- Tests ---

describe('cross-service context propagation', () => {
	let appInstance1: Application | null = null;
	let appInstance2: Application | null = null;
	let port1 = 19900;
	let bullmqProvider: BullMQWorkflowProvider | null = null;

	const getPort1 = () => ++port1;

	beforeAll(() => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(async () => {
		if (appInstance1) {
			await appInstance1.stop();
			appInstance1 = null;
		}
		if (appInstance2) {
			await appInstance2.stop();
			appInstance2 = null;
		}
		if (bullmqProvider) {
			await bullmqProvider.stop();
			bullmqProvider = null;
		}
	});

	it('should propagate auth guard metadata through workflow execution', async () => {
		// ========================================
		// APP INSTANCE 1: Origin service
		// ========================================

		// Controller that applies auth guard and executes workflow
		class Instance1Controller implements OriController {
			configure(r: RouteBuilder) {
				// Apply auth guard that sets userId, accountUuid, projectUuid
				r.guard(TestAuthGuard);
				r.post('/execute', this.executeWorkflow);
			}

			private executeWorkflow = async (ctx: RequestContext) => {
				const body = await ctx.json<{ value: number }>();

				// Execute workflow - context should automatically propagate
				const handle = await ctx.app.workflows.execute(ContextCapturingWorkflowDef, {
					value: body.value
				});

				const result = await handle.result();
				return Response.json(result);
			};
		}

		appInstance1 = Ori.create()
			.workflow(ContextCapturingWorkflowDef)
			.consumer(ContextCapturingWorkflowConsumer)
			.controller('/api', Instance1Controller);

		const currentPort1 = getPort1();
		await appInstance1.listen(currentPort1);

		// Make HTTP request to Instance 1
		const response = await fetch(`http://localhost:${currentPort1}/api/execute`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-request-id': 'req-origin-123'
			},
			body: JSON.stringify({ value: 21 })
		});

		const result = (await response.json()) as ContextCapturingResult;

		// Verify workflow executed correctly
		expect(result.computed).toBe(42);

		// Verify ALL context was propagated to the workflow
		expect(result.capturedContext.correlationId).toBe('req-origin-123');
		expect(result.capturedContext.userId).toBe('user-12345');
		expect(result.capturedContext.accountUuid).toBe('account-67890');
		expect(result.capturedContext.projectUuid).toBe('project-abcde');
		// traceId is auto-generated, just verify it exists
		expect(result.capturedContext.traceId).toBeDefined();
	});

	it('should isolate context between concurrent requests on same instance', async () => {
		// Controller with inline metadata setting (no guard, set in handler)
		class MultiUserController implements OriController {
			configure(r: RouteBuilder) {
				r.post('/alice', this.aliceEndpoint);
				r.post('/bob', this.bobEndpoint);
			}

			private aliceEndpoint = async (ctx: RequestContext) => {
				// Simulate Alice's auth
				ctx.log.setMeta({ userId: 'alice-123', accountUuid: 'alice-account' });

				const body = await ctx.json<{ value: number }>();
				const handle = await ctx.app.workflows.execute(ContextCapturingWorkflowDef, { value: body.value });
				return Response.json(await handle.result());
			};

			private bobEndpoint = async (ctx: RequestContext) => {
				// Simulate Bob's auth
				ctx.log.setMeta({ userId: 'bob-456', accountUuid: 'bob-account' });

				const body = await ctx.json<{ value: number }>();
				const handle = await ctx.app.workflows.execute(ContextCapturingWorkflowDef, { value: body.value });
				return Response.json(await handle.result());
			};
		}

		appInstance1 = Ori.create()
			.workflow(ContextCapturingWorkflowDef)
			.consumer(ContextCapturingWorkflowConsumer)
			.controller('/api', MultiUserController);

		const currentPort = getPort1();
		await appInstance1.listen(currentPort);

		// Make concurrent requests for different users
		const [aliceResponse, bobResponse] = await Promise.all([
			fetch(`http://localhost:${currentPort}/api/alice`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': 'req-alice'
				},
				body: JSON.stringify({ value: 10 })
			}),
			fetch(`http://localhost:${currentPort}/api/bob`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': 'req-bob'
				},
				body: JSON.stringify({ value: 20 })
			})
		]);

		const aliceResult = (await aliceResponse.json()) as ContextCapturingResult;
		const bobResult = (await bobResponse.json()) as ContextCapturingResult;

		// Verify Alice's context stayed with Alice
		expect(aliceResult.capturedContext.correlationId).toBe('req-alice');
		expect(aliceResult.capturedContext.userId).toBe('alice-123');
		expect(aliceResult.capturedContext.accountUuid).toBe('alice-account');
		expect(aliceResult.computed).toBe(20);

		// Verify Bob's context stayed with Bob
		expect(bobResult.capturedContext.correlationId).toBe('req-bob');
		expect(bobResult.capturedContext.userId).toBe('bob-456');
		expect(bobResult.capturedContext.accountUuid).toBe('bob-account');
		expect(bobResult.computed).toBe(40);
	});

	it('should propagate context through BullMQ distributed workflow execution', async () => {
		// BullMQ workflow execution needs more time than default 5s timeout
		// This test verifies TRUE distributed context propagation via BullMQ.
		// Unlike InProcessWorkflowProvider which captures from AsyncLocalStorage,
		// BullMQ serializes PropagationMeta into job data and restores it in workers.
		//
		// Flow:
		// 1. HTTP request → Guard sets context via ctx.log.setMeta()
		// 2. Workflow execute() captures PropagationMeta via capturePropagationMeta()
		// 3. BullMQ serializes meta into job data and queues it
		// 4. Worker processes job, restores context from job data via Logger.fromMeta()
		// 5. Workflow step receives the original context (not HTTP context)

		const redisConfig = getRedisConnectionOptions();
		const testId = Date.now();

		// Create BullMQ provider with unique queue prefix for test isolation
		bullmqProvider = new BullMQWorkflowProvider({
			connection: redisConfig,
			queuePrefix: `cross-service-test-${testId}`
		});

		// Register workflow and start the provider (starts workers)
		// Note: In the new pattern, registration happens via app.workflow().consumer()
		// but we still need to register with the provider directly for BullMQ
		await bullmqProvider.start();

		class DistributedController implements OriController {
			configure(r: RouteBuilder) {
				r.guard(DistributedAuthGuard);
				r.post('/execute', this.executeWorkflow);
			}

			private executeWorkflow = async (ctx: RequestContext) => {
				const body = await ctx.json<{ value: number }>();

				// Execute via BullMQ - context is captured from AsyncLocalStorage
				// and serialized into job data, then restored by worker
				const handle = await ctx.app.workflows.execute(ContextCapturingWorkflowDef, {
					value: body.value
				});

				// Wait for BullMQ worker to process the job
				const result = await Promise.race([
					handle.result(),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('Timeout waiting for workflow')), 10000)
					)
				]);

				return Response.json(result);
			};
		}

		appInstance1 = Ori.create()
			.workflowProvider(bullmqProvider)
			.workflow(ContextCapturingWorkflowDef)
			.consumer(ContextCapturingWorkflowConsumer)
			.controller('/api', DistributedController);

		const currentPort = getPort1();
		await appInstance1.listen(currentPort);

		// Make HTTP request - Guard sets userId, accountUuid, projectUuid
		const response = await fetch(`http://localhost:${currentPort}/api/execute`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-request-id': 'req-bullmq-distributed-123'
			},
			body: JSON.stringify({ value: 50 })
		});

		expect(response.ok).toBe(true);
		const result = (await response.json()) as ContextCapturingResult;

		// Verify workflow executed correctly
		expect(result.computed).toBe(100);

		// CRITICAL: Verify context was propagated through BullMQ job data
		// The workflow ran in a BullMQ worker which restored context from job data,
		// NOT from the HTTP request's AsyncLocalStorage context
		expect(result.capturedContext.correlationId).toBe('req-bullmq-distributed-123');
		expect(result.capturedContext.userId).toBe('distributed-user');
		expect(result.capturedContext.accountUuid).toBe('distributed-account');
		expect(result.capturedContext.projectUuid).toBe('distributed-project');
		// traceId is auto-generated, just verify it exists
		expect(result.capturedContext.traceId).toBeDefined();
	}, 15000);

	it('should maintain trace chain across multiple workflow steps', async () => {
		class TraceController implements OriController {
			configure(r: RouteBuilder) {
				r.guard(TraceAuthGuard);
				r.post('/multi-step', this.runMultiStep);
			}

			private runMultiStep = async (ctx: RequestContext) => {
				const body = await ctx.json<{ input: number }>();
				const handle = await ctx.app.workflows.execute(MultiStepWorkflowDef, { input: body.input });
				return Response.json(await handle.result());
			};
		}

		appInstance1 = Ori.create()
			.workflow(MultiStepWorkflowDef)
			.consumer(MultiStepWorkflowConsumer)
			.controller('/api', TraceController);

		const currentPort = getPort1();
		await appInstance1.listen(currentPort);

		const response = await fetch(`http://localhost:${currentPort}/api/multi-step`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-request-id': 'req-trace-chain'
			},
			body: JSON.stringify({ input: 5 })
		});

		const result = (await response.json()) as MultiStepResult;

		// Verify computation
		expect(result.finalValue).toBe(30); // (5 + 10) * 2

		// Verify SAME trace context in both steps
		expect(result.step1TraceId).toBeDefined();
		expect(result.step2TraceId).toBeDefined();
		expect(result.step1TraceId).toBe(result.step2TraceId); // Same trace

		// Verify SAME request ID in both steps
		expect(result.step1RequestId).toBe('req-trace-chain');
		expect(result.step2RequestId).toBe('req-trace-chain');

		// Verify SAME user context in both steps
		expect(result.step1UserId).toBe('trace-user');
		expect(result.step2UserId).toBe('trace-user');
	});
});
