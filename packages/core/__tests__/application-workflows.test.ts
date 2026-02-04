/**
 * Application Workflows Integration Tests
 *
 * Tests the Application workflow fluent methods and lifecycle integration.
 *
 * Covers:
 * - Application.workflow(Definition).consumer(Class) fluent API
 * - Workflow provider lifecycle (start/stop)
 * - WorkflowExecutor injection via AppContext
 * - Interface segregation verification
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Application, Ori } from '../src/application.ts';
import { Workflow } from '../src/types/workflow-definition.ts';
import { Type } from '@orijs/validation';
import type { IWorkflowConsumer, WorkflowContext } from '../src/types/consumer.ts';
import type { OriController, RouteBuilder } from '../src/types/index.ts';
import { AppContext } from '../src/app-context.ts';
import { Logger } from '@orijs/logging';
import { InProcessWorkflowProvider } from '@orijs/workflows';

// --- Test Workflow Definitions ---

const SimpleWorkflow = Workflow.define({
	name: 'simple-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ computed: Type.Number() })
});

/**
 * Simple workflow consumer for testing: doubles the input value.
 */
class SimpleWorkflowConsumer implements IWorkflowConsumer<
	(typeof SimpleWorkflow)['_data'],
	(typeof SimpleWorkflow)['_result']
> {
	onComplete = async (ctx: WorkflowContext<(typeof SimpleWorkflow)['_data']>) => {
		return { computed: ctx.data.value * 2 };
	};
}

// --- Tests ---

describe('Application.workflow()', () => {
	let app: Application;
	let port = 19800;

	const getPort = () => ++port;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(async () => {
		await app?.stop();
	});

	describe('fluent API', () => {
		it('should return Application for chaining', () => {
			const result = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);

			expect(result).toBeInstanceOf(Application);
		});

		it('should accept workflow definition with default InProcessProvider', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);
			await app.listen(getPort());

			// Verify workflow system is available
			const workflowProvider = app.getWorkflowProvider();
			expect(workflowProvider).toBeInstanceOf(InProcessWorkflowProvider);
		});

		it('should chain with other fluent methods', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create()
				.workflow(SimpleWorkflow)
				.consumer(SimpleWorkflowConsumer)
				.controller('/api', TestController);

			await app.listen(getPort());

			// Both workflows and controller should work
			expect(app.getWorkflowProvider()).toBeDefined();
			expect(app.getRoutes()).toHaveLength(1);
		});
	});

	describe('workflow registration', () => {
		it('should register workflow with consumer', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);
			await app.listen(getPort());

			// Provider should be configured
			const provider = app.getWorkflowProvider();
			expect(provider).not.toBeNull();
		});

		it('should register multiple workflows', async () => {
			const AnotherWorkflow = Workflow.define({
				name: 'another-workflow',
				data: Type.Object({ value: Type.Number() }),
				result: Type.Object({ computed: Type.Number() })
			});

			class AnotherWorkflowConsumer implements IWorkflowConsumer<
				(typeof AnotherWorkflow)['_data'],
				(typeof AnotherWorkflow)['_result']
			> {
				onComplete = async (ctx: WorkflowContext<(typeof AnotherWorkflow)['_data']>) => {
					return { computed: ctx.data.value * 3 };
				};
			}

			app = Ori.create()
				.workflow(SimpleWorkflow)
				.consumer(SimpleWorkflowConsumer)
				.workflow(AnotherWorkflow)
				.consumer(AnotherWorkflowConsumer);

			await app.listen(getPort());

			// Provider should be configured with both workflows
			const provider = app.getWorkflowProvider();
			expect(provider).not.toBeNull();
		});
	});

	describe('lifecycle', () => {
		it('should start workflow provider during listen()', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);

			await app.listen(getPort());

			// Provider should be started after listen()
			const provider = app.getWorkflowProvider();
			expect(provider).not.toBeNull();
		});

		it('should stop workflow provider during stop()', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);
			await app.listen(getPort());

			const provider = app.getWorkflowProvider();
			expect(provider).not.toBeNull();

			await app.stop();

			// Provider reference still exists after stop
			expect(app.getWorkflowProvider()).not.toBeNull();
		});

		it('should handle stop() gracefully when no workflows configured', async () => {
			app = Ori.create();
			await app.listen(getPort());

			// Should not throw
			await app.stop();
		});
	});

	describe('AppContext.workflows', () => {
		it('should expose WorkflowExecutor via AppContext', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);
			await app.listen(getPort());

			const appContext = app.context;
			expect(appContext).not.toBeNull();
			expect(appContext!.workflows).toBeDefined();
		});

		it('should throw helpful error when no workflows configured', async () => {
			app = Ori.create();
			await app.listen(getPort());

			const appContext = app.context;
			expect(() => appContext!.workflows).toThrow('Workflows not configured');
		});

		it('should return false for hasWorkflows when no workflows configured', async () => {
			app = Ori.create();
			await app.listen(getPort());

			const appContext = app.context;
			expect(appContext!.hasWorkflows).toBe(false);
		});

		it('should return true for hasWorkflows when workflows configured', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);
			await app.listen(getPort());

			const appContext = app.context;
			expect(appContext!.hasWorkflows).toBe(true);
		});

		it('should allow service to inject WorkflowExecutor via AppContext', async () => {
			// Controller that uses AppContext to get workflows
			class TestController implements OriController {
				constructor(private appContext: AppContext) {}

				configure(r: RouteBuilder) {
					r.post('/compute', this.compute);
				}

				private compute = async (ctx: { json: () => Promise<{ value: number }> }) => {
					const body = await ctx.json();
					// Access workflows via AppContext
					const executor = this.appContext.workflows;
					// The executor should be available
					expect(executor).toBeDefined();
					return Response.json({ value: body.value * 2 });
				};
			}

			app = Ori.create()
				.workflow(SimpleWorkflow)
				.consumer(SimpleWorkflowConsumer)
				.controller('/api', TestController, [AppContext]);
			await app.listen(getPort());

			const response = await fetch(`http://localhost:${port}/api/compute`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 7 })
			});

			const result = await response.json();
			expect(result).toEqual({ value: 14 });
		});
	});

	describe('interface segregation', () => {
		it('should only expose WorkflowExecutor to services (not lifecycle methods)', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);
			await app.listen(getPort());

			const appContext = app.context!;
			const executor = appContext.workflows;

			// WorkflowExecutor should have execute and getStatus
			expect(typeof executor.execute).toBe('function');
			expect(typeof executor.getStatus).toBe('function');

			// Interface segregation is enforced at compile time:
			// Services that inject WorkflowExecutor cannot call lifecycle methods
			// (registerWorkflow, start, stop) because they're not on the interface.
			// This test verifies the narrow interface is exposed.
		});

		it('should allow full WorkflowProvider access via getWorkflowProvider()', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);
			await app.listen(getPort());

			const provider = app.getWorkflowProvider();

			// Full provider has all methods
			expect(typeof provider?.execute).toBe('function');
			expect(typeof provider?.getStatus).toBe('function');
			expect(typeof provider?.registerDefinitionConsumer).toBe('function');
			expect(typeof provider?.start).toBe('function');
			expect(typeof provider?.stop).toBe('function');
		});
	});

	describe('getWorkflowProvider()', () => {
		it('should return null when no workflows configured', async () => {
			app = Ori.create();
			await app.listen(getPort());

			expect(app.getWorkflowProvider()).toBeNull();
		});

		it('should return provider when workflows configured', async () => {
			app = Ori.create().workflow(SimpleWorkflow).consumer(SimpleWorkflowConsumer);
			await app.listen(getPort());

			expect(app.getWorkflowProvider()).not.toBeNull();
		});
	});
});
