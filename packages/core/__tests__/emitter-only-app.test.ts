/**
 * Unit Tests: Emitter-Only App Pattern
 *
 * These tests verify that apps can register events and workflows for emission only
 * (without consumers) and continue chaining with .use() providers.
 *
 * This is the pattern used by ori-backend-public-server:
 * ```ts
 * Ori.create()
 *   .use(addEvents)
 *   .event(ExampleEvent)  // No .consumer() - emitter only
 *   .use(addWorkflows)    // Continue chaining
 *   .workflow(ExampleWorkflowDef)  // No .consumer() - emitter only
 *   .use(addRepositories) // Continue chaining
 *   .controller(...)
 *   .listen(port);
 * ```
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Application, Ori } from '../src/index.ts';
import { Event } from '../src/types/event-definition.ts';
import { Workflow } from '../src/types/workflow-definition.ts';
import { Type } from '@orijs/validation';
import type { OriController, RouteBuilder } from '../src/types/index.ts';
import { Logger } from '@orijs/logging';

// Test event definition
const TestEvent = Event.define({
	name: 'test.event',
	data: Type.Object({ userId: Type.String() }),
	result: Type.Object({ processed: Type.Boolean() })
});

// Test workflow definition
const TestWorkflow = Workflow.define({
	name: 'test-workflow',
	data: Type.Object({ input: Type.String() }),
	result: Type.Object({ output: Type.String() })
});

// Simple controller for testing
class TestController implements OriController {
	configure(r: RouteBuilder) {
		r.get('/', () => Response.json({ ok: true }));
	}
}

// Simple service for testing
class TestService {
	getValue() {
		return 'test';
	}
}

// Provider functions like those in real apps
function addTestService(app: Application): Application {
	return app.provider(TestService);
}

function addTestController(app: Application): Application {
	return app.controller('/api', TestController);
}

describe('Emitter-Only App Pattern', () => {
	let app: Application;
	let port = 51000;

	const getPort = () => ++port;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(async () => {
		await app?.stop();
	});

	describe('Event emitter-only with .use() chaining', () => {
		it('should allow .use() after .event() without consumer', async () => {
			// This is the exact pattern from ori-backend-public-server
			app = Ori.create()
				.event(TestEvent) // No .consumer() - emitter only
				.use(addTestService); // Should be able to chain .use()

			await app.listen(getPort());

			// Event should be registered
			const eventCoordinator = (app as any).eventCoordinator;
			expect(eventCoordinator.getEventDefinition('test.event')).toBeDefined();

			// Service should be registered
			const container = (app as any).container;
			expect(container.has(TestService)).toBe(true);
		});

		it('should allow .controller() after .event() without consumer', async () => {
			const usedPort = getPort();

			app = Ori.create()
				.event(TestEvent) // No .consumer()
				.controller('/api', TestController);

			await app.listen(usedPort);

			// Controller should work
			const response = await fetch(`http://localhost:${usedPort}/api`);
			expect(response.status).toBe(200);
		});

		it('should allow .provider() after .event() without consumer', async () => {
			app = Ori.create()
				.event(TestEvent) // No .consumer()
				.provider(TestService);

			await app.listen(getPort());

			// Service should be registered
			const container = (app as any).container;
			expect(container.has(TestService)).toBe(true);
		});

		it('should allow multiple .use() calls after .event() without consumer', async () => {
			app = Ori.create()
				.event(TestEvent) // No .consumer()
				.use(addTestService)
				.use(addTestController);

			const usedPort = getPort();
			await app.listen(usedPort);

			// Both should be registered
			const container = (app as any).container;
			expect(container.has(TestService)).toBe(true);

			const response = await fetch(`http://localhost:${usedPort}/api`);
			expect(response.status).toBe(200);
		});
	});

	describe('Workflow emitter-only with .use() chaining', () => {
		it('should allow .use() after .workflow() without consumer', async () => {
			app = Ori.create()
				.workflow(TestWorkflow) // No .consumer() - emitter only
				.use(addTestService);

			await app.listen(getPort());

			// Workflow should be registered
			const workflowCoordinator = (app as any).workflowCoordinator;
			expect(workflowCoordinator.getWorkflowDefinition('test-workflow')).toBeDefined();

			// Service should be registered
			const container = (app as any).container;
			expect(container.has(TestService)).toBe(true);
		});

		it('should allow .controller() after .workflow() without consumer', async () => {
			const usedPort = getPort();

			app = Ori.create()
				.workflow(TestWorkflow) // No .consumer()
				.controller('/api', TestController);

			await app.listen(usedPort);

			// Controller should work
			const response = await fetch(`http://localhost:${usedPort}/api`);
			expect(response.status).toBe(200);
		});

		it('should allow .provider() after .workflow() without consumer', async () => {
			app = Ori.create()
				.workflow(TestWorkflow) // No .consumer()
				.provider(TestService);

			await app.listen(getPort());

			// Service should be registered
			const container = (app as any).container;
			expect(container.has(TestService)).toBe(true);
		});
	});

	describe('Mixed emitter-only pattern (real app simulation)', () => {
		it('should support full emitter-only app pattern like ori-backend-public-server', async () => {
			// This simulates the exact structure of ori-backend-public-server/src/app.ts
			const usedPort = getPort();

			app = Ori.create()
				.use(addTestService) // addMappers, addQueryBuilders, etc.
				.event(TestEvent) // .event(ExampleEvent) - emitter only
				.use(addTestController) // .use(addWorkflows)
				.workflow(TestWorkflow) // .workflow(ExampleWorkflowDef) - emitter only
				.controller('/health', TestController); // .controller(...)

			await app.listen(usedPort);

			// Event should be registered for emission
			const eventCoordinator = (app as any).eventCoordinator;
			expect(eventCoordinator.getEventDefinition('test.event')).toBeDefined();

			// Workflow should be registered for execution
			const workflowCoordinator = (app as any).workflowCoordinator;
			expect(workflowCoordinator.getWorkflowDefinition('test-workflow')).toBeDefined();

			// Controllers should work
			const response = await fetch(`http://localhost:${usedPort}/api`);
			expect(response.status).toBe(200);
		});

		it('should allow chaining .event() then .workflow() without consumers', async () => {
			app = Ori.create()
				.event(TestEvent) // No .consumer()
				.workflow(TestWorkflow); // No .consumer()

			await app.listen(getPort());

			// Both should be registered
			const eventCoordinator = (app as any).eventCoordinator;
			const workflowCoordinator = (app as any).workflowCoordinator;

			expect(eventCoordinator.getEventDefinition('test.event')).toBeDefined();
			expect(workflowCoordinator.getWorkflowDefinition('test-workflow')).toBeDefined();
		});

		it('should allow chaining .workflow() then .event() without consumers', async () => {
			app = Ori.create()
				.workflow(TestWorkflow) // No .consumer()
				.event(TestEvent); // No .consumer()

			await app.listen(getPort());

			// Both should be registered
			const eventCoordinator = (app as any).eventCoordinator;
			const workflowCoordinator = (app as any).workflowCoordinator;

			expect(eventCoordinator.getEventDefinition('test.event')).toBeDefined();
			expect(workflowCoordinator.getWorkflowDefinition('test-workflow')).toBeDefined();
		});
	});

	describe('Type safety (compile-time verification)', () => {
		it('should maintain Application type after .event() for chaining', () => {
			// This test verifies that the return type allows chaining
			// If this compiles, the types are correct
			const result = Ori.create().event(TestEvent);

			// Should be able to access Application methods
			expect(typeof result.use).toBe('function');
			expect(typeof result.provider).toBe('function');
			expect(typeof result.controller).toBe('function');
			expect(typeof result.listen).toBe('function');
			expect(typeof result.event).toBe('function');
			expect(typeof result.workflow).toBe('function');

			// Should also have consumer method (optional)
			expect(typeof result.consumer).toBe('function');
		});

		it('should maintain Application type after .workflow() for chaining', () => {
			// This test verifies that the return type allows chaining
			// If this compiles, the types are correct
			const result = Ori.create().workflow(TestWorkflow);

			// Should be able to access Application methods
			expect(typeof result.use).toBe('function');
			expect(typeof result.provider).toBe('function');
			expect(typeof result.controller).toBe('function');
			expect(typeof result.listen).toBe('function');
			expect(typeof result.event).toBe('function');
			expect(typeof result.workflow).toBe('function');

			// Should also have consumer method (optional)
			expect(typeof result.consumer).toBe('function');
		});
	});
});
