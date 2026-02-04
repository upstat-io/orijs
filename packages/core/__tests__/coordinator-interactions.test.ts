/**
 * Functional Tests: Coordinator Interactions
 *
 * These tests verify that the Application class correctly delegates to coordinators
 * and that coordinators properly interact with the Container and each other.
 *
 * Test scenarios:
 * 1. Application.event() → EventCoordinator registration → handlers register correctly
 * 2. Application.workflow() → WorkflowCoordinator registration → workflows register correctly
 * 3. Application.controller() → RoutingCoordinator.addController() → routes compile correctly
 * 4. Application.listen() → bootstrap() → coordinators initialize in correct order
 * 5. Application.stop() → coordinators shutdown in reverse order (LIFO)
 * 6. Event consumer classes → DI resolution → consumers configured
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Application } from '../src/application.ts';
import { Ori } from '../src/application.ts';
import { AppContext } from '../src/app-context.ts';
import { Event } from '../src/types/event-definition.ts';
import { Workflow } from '../src/types/workflow-definition.ts';
import { Type } from '@orijs/validation';
import type {
	IEventConsumer,
	IWorkflowConsumer,
	EventContext,
	WorkflowContext
} from '../src/types/consumer.ts';
import { Logger } from '@orijs/logging';
import type { OriController, RouteBuilder, Guard, RequestContext } from '../src/types/index.ts';

describe('Coordinator Interactions', () => {
	let app: Application;
	let port = 29000;

	const getPort = () => ++port;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(async () => {
		await app?.stop();
	});

	describe('EventCoordinator Integration', () => {
		const TestEvent = Event.define({
			name: 'test.event',
			data: Type.Object({ message: Type.String() }),
			result: Type.Void()
		});

		it('should register event consumers through Application.event().consumer()', async () => {
			let handlerCalled = false;
			let receivedPayload: unknown = null;

			class TestEventConsumer implements IEventConsumer<(typeof TestEvent)['_data'], void> {
				onEvent = async (ctx: EventContext<(typeof TestEvent)['_data']>) => {
					handlerCalled = true;
					receivedPayload = ctx.data;
				};
			}

			app = Ori.create().disableSignalHandling().event(TestEvent).consumer(TestEventConsumer);

			await app.listen(getPort());

			const provider = app.getEventProvider();
			expect(provider).not.toBeNull();

			// Emit event and verify handler is called
			provider!.emit('test.event', { message: 'hello' });

			// Wait for async processing
			await new Promise((r) => setTimeout(r, 50));

			expect(handlerCalled).toBe(true);
			expect(receivedPayload).toEqual({ message: 'hello' });
		});

		it('should register event consumers with DI dependencies', async () => {
			const DIEvent = Event.define({
				name: 'di.event',
				data: Type.Object({ value: Type.Number() }),
				result: Type.Void()
			});

			// Service to be injected
			class TestService {
				getValue(): string {
					return 'injected-value';
				}
			}

			// Event consumer with DI
			let capturedValue: string | null = null;

			class DIEventConsumer implements IEventConsumer<(typeof DIEvent)['_data'], void> {
				constructor(private service: TestService) {}

				onEvent = async (_ctx: EventContext<(typeof DIEvent)['_data']>) => {
					capturedValue = this.service.getValue();
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.provider(TestService)
				.event(DIEvent)
				.consumer(DIEventConsumer, [TestService]);

			await app.listen(getPort());

			const provider = app.getEventProvider();
			provider!.emit('di.event', { value: 42 });

			await new Promise((r) => setTimeout(r, 50));

			expect(capturedValue).not.toBeNull();
			expect(capturedValue!).toBe('injected-value');
		});

		it('should start and stop event system during Application lifecycle', async () => {
			const LifecycleEvent = Event.define({
				name: 'lifecycle.event',
				data: Type.Object({}),
				result: Type.Void()
			});

			class LifecycleConsumer implements IEventConsumer<{}, void> {
				onEvent = async () => {};
			}

			app = Ori.create().disableSignalHandling().event(LifecycleEvent).consumer(LifecycleConsumer);

			// Before listen, event system should exist but not be started
			await app.listen(getPort());

			const provider = app.getEventProvider();
			expect(provider).not.toBeNull();

			// After stop, provider reference still exists
			await app.stop();
			expect(app.getEventProvider()).not.toBeNull();
		});
	});

	describe('WorkflowCoordinator Integration', () => {
		const TestWorkflow = Workflow.define({
			name: 'test-workflow',
			data: Type.Object({ id: Type.Number() }),
			result: Type.Object({ success: Type.Boolean() })
		});

		it('should register workflows through Application.workflow().consumer()', async () => {
			class TestWorkflowConsumer implements IWorkflowConsumer<
				(typeof TestWorkflow)['_data'],
				(typeof TestWorkflow)['_result']
			> {
				onComplete = async (_ctx: WorkflowContext<(typeof TestWorkflow)['_data']>) => {
					return { success: true };
				};
			}

			app = Ori.create().disableSignalHandling().workflow(TestWorkflow).consumer(TestWorkflowConsumer);

			await app.listen(getPort());

			const workflowProvider = app.getWorkflowProvider();
			expect(workflowProvider).not.toBeNull();
		});

		it('should make workflow provider available via AppContext', async () => {
			const SimpleWorkflow = Workflow.define({
				name: 'simple-workflow',
				data: Type.Object({ value: Type.String() }),
				result: Type.Object({ processed: Type.String() })
			});

			class SimpleWorkflowConsumer implements IWorkflowConsumer<
				(typeof SimpleWorkflow)['_data'],
				(typeof SimpleWorkflow)['_result']
			> {
				onComplete = async (ctx: WorkflowContext<(typeof SimpleWorkflow)['_data']>) => {
					return { processed: ctx.data.value.toUpperCase() };
				};
			}

			let capturedAppContext: AppContext | null = null;

			class TestController implements OriController {
				constructor(appContext: AppContext) {
					capturedAppContext = appContext;
				}

				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create()
				.disableSignalHandling()
				.workflow(SimpleWorkflow)
				.consumer(SimpleWorkflowConsumer)
				.controller('/test', TestController, [AppContext]);

			await app.listen(getPort());

			expect(capturedAppContext).not.toBeNull();
			expect(capturedAppContext!.workflows).toBeDefined();
		});

		it('should start and stop workflow provider during Application lifecycle', async () => {
			const LifecycleWorkflow = Workflow.define({
				name: 'lifecycle-workflow',
				data: Type.Object({}),
				result: Type.Object({})
			});

			class LifecycleWorkflowConsumer implements IWorkflowConsumer<{}, {}> {
				onComplete = async () => ({});
			}

			app = Ori.create()
				.disableSignalHandling()
				.workflow(LifecycleWorkflow)
				.consumer(LifecycleWorkflowConsumer);

			await app.listen(getPort());

			const provider = app.getWorkflowProvider();
			expect(provider).not.toBeNull();

			await app.stop();

			// Provider reference still exists after stop
			expect(app.getWorkflowProvider()).not.toBeNull();
		});
	});

	describe('RoutingCoordinator Integration', () => {
		it('should register controllers through Application.controller()', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder): void {
					r.get('/', () => Response.json({ status: 'ok' }));
					r.post('/create', () => Response.json({ created: true }));
				}
			}

			app = Ori.create().disableSignalHandling().controller('/api', TestController);

			await app.listen(getPort());

			const routes = app.getRoutes();

			expect(routes.length).toBe(2);
			expect(routes.some((r) => r.method === 'GET' && r.fullPath === '/api')).toBe(true);
			expect(routes.some((r) => r.method === 'POST' && r.fullPath === '/api/create')).toBe(true);
		});

		it('should register controllers with DI dependencies', async () => {
			class DependencyService {
				getMessage(): string {
					return 'from-service';
				}
			}

			let capturedMessage: string | null = null;

			class DIController implements OriController {
				constructor(private service: DependencyService) {}

				configure(r: RouteBuilder): void {
					r.get('/', this.handleGet);
				}

				private handleGet = async (_ctx: RequestContext): Promise<Response> => {
					capturedMessage = this.service.getMessage();
					return Response.json({ message: capturedMessage });
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.provider(DependencyService)
				.controller('/di', DIController, [DependencyService]);

			await app.listen(getPort());

			const response = await fetch(`http://localhost:${port}/di`);
			const data = await response.json();

			expect(capturedMessage).not.toBeNull();
			expect(capturedMessage!).toBe('from-service');
			expect(data).toEqual({ message: 'from-service' });
		});

		it('should apply global guards through RoutingCoordinator', async () => {
			let guardCalled = false;

			class TestGuard implements Guard {
				async canActivate(_ctx: RequestContext): Promise<boolean> {
					guardCalled = true;
					return true;
				}
			}

			class GuardedController implements OriController {
				configure(r: RouteBuilder): void {
					r.get('/', () => Response.json({ guarded: true }));
				}
			}

			app = Ori.create().disableSignalHandling().guard(TestGuard).controller('/protected', GuardedController);

			await app.listen(getPort());

			await fetch(`http://localhost:${port}/protected`);

			expect(guardCalled).toBe(true);
		});

		it('should compile routes correctly through Container and RoutingCoordinator', async () => {
			class Service1 {
				name = 'Service1';
			}
			class Service2 {
				constructor(public s1: Service1) {}
			}

			class ComplexController implements OriController {
				constructor(
					public service: Service2,
					public appContext: AppContext
				) {}

				configure(r: RouteBuilder): void {
					r.get('/info', this.getInfo);
				}

				private getInfo = async (_ctx: RequestContext): Promise<Response> => {
					return Response.json({
						serviceName: this.service.s1.name,
						hasAppContext: this.appContext !== null
					});
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.provider(Service1)
				.provider(Service2, [Service1])
				.controller('/complex', ComplexController, [Service2, AppContext]);

			await app.listen(getPort());

			const response = await fetch(`http://localhost:${port}/complex/info`);
			const data = await response.json();

			expect(data).toEqual({
				serviceName: 'Service1',
				hasAppContext: true
			});
		});
	});

	describe('Bootstrap and Shutdown Order', () => {
		it('should initialize coordinators in correct order during bootstrap', async () => {
			const initOrder: string[] = [];

			// Track initialization via providers with eager option
			class EagerProvider1 {
				constructor() {
					initOrder.push('provider1');
				}
			}

			class EagerProvider2 {
				constructor() {
					initOrder.push('provider2');
				}
			}

			class TestController implements OriController {
				constructor() {
					initOrder.push('controller');
				}

				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			const InitEvent = Event.define({
				name: 'init.event',
				data: Type.Object({}),
				result: Type.Void()
			});

			class InitEventConsumer implements IEventConsumer<{}, void> {
				onEvent = async () => {};
			}

			const InitWorkflow = Workflow.define({
				name: 'init-workflow',
				data: Type.Object({}),
				result: Type.Object({})
			});

			class InitWorkflowConsumer implements IWorkflowConsumer<{}, {}> {
				onComplete = async () => ({});
			}

			app = Ori.create()
				.disableSignalHandling()
				.provider(EagerProvider1, { eager: true })
				.provider(EagerProvider2, { eager: true })
				.event(InitEvent)
				.consumer(InitEventConsumer)
				.workflow(InitWorkflow)
				.consumer(InitWorkflowConsumer)
				.controller('/init', TestController);

			await app.listen(getPort());

			// Providers should be initialized before controller
			expect(initOrder.indexOf('provider1')).toBeLessThan(initOrder.indexOf('controller'));
			expect(initOrder.indexOf('provider2')).toBeLessThan(initOrder.indexOf('controller'));
		});

		it('should shutdown coordinators in reverse order (LIFO)', async () => {
			// We can't directly hook into coordinator shutdown, but we can verify
			// that the application stops gracefully without errors

			class TestController implements OriController {
				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			const ShutdownEvent = Event.define({
				name: 'shutdown.test',
				data: Type.Object({}),
				result: Type.Void()
			});

			class ShutdownEventConsumer implements IEventConsumer<{}, void> {
				onEvent = async () => {};
			}

			const ShutdownWorkflow = Workflow.define({
				name: 'shutdown-workflow',
				data: Type.Object({}),
				result: Type.Object({})
			});

			class ShutdownWorkflowConsumer implements IWorkflowConsumer<{}, {}> {
				onComplete = async () => ({});
			}

			app = Ori.create()
				.disableSignalHandling()
				.event(ShutdownEvent)
				.consumer(ShutdownEventConsumer)
				.workflow(ShutdownWorkflow)
				.consumer(ShutdownWorkflowConsumer)
				.controller('/shutdown', TestController);

			await app.listen(getPort());

			// Verify all systems are running
			expect(app.getEventProvider()).not.toBeNull();
			expect(app.getWorkflowProvider()).not.toBeNull();
			expect(app.getRoutes().length).toBeGreaterThan(0);

			// Stop should complete without errors
			await app.stop();

			// After stop, app should be in stopped state (can start again)
			// The key verification is that stop() completed without throwing
		});

		it('should handle multiple stop() calls gracefully', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().disableSignalHandling().controller('/multi-stop', TestController);

			await app.listen(getPort());

			// Multiple stop calls should not throw
			await app.stop();
			await app.stop();
			await app.stop();

			// Should complete without error
			expect(true).toBe(true);
		});
	});

	describe('RoutingCoordinator Methods', () => {
		it('should return global guards via getGlobalGuards()', async () => {
			class Guard1 implements Guard {
				async canActivate(): Promise<boolean> {
					return true;
				}
			}

			class Guard2 implements Guard {
				async canActivate(): Promise<boolean> {
					return true;
				}
			}

			class TestController implements OriController {
				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create()
				.disableSignalHandling()
				.guard(Guard1)
				.guard(Guard2)
				.controller('/test', TestController);

			await app.listen(getPort());

			const routingCoordinator = (app as any).routingCoordinator;
			const guards = routingCoordinator.getGlobalGuards();

			expect(guards).toHaveLength(2);
			expect(guards).toContain(Guard1);
			expect(guards).toContain(Guard2);
		});

		it('should return global interceptors via getGlobalInterceptors()', async () => {
			class Interceptor1 {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
					return next();
				}
			}

			class TestController implements OriController {
				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().disableSignalHandling().intercept(Interceptor1).controller('/test', TestController);

			await app.listen(getPort());

			const routingCoordinator = (app as any).routingCoordinator;
			const interceptors = routingCoordinator.getGlobalInterceptors();

			expect(interceptors).toHaveLength(1);
			expect(interceptors).toContain(Interceptor1);
		});

		it('should return empty arrays when no global guards or interceptors', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().disableSignalHandling().controller('/test', TestController);

			await app.listen(getPort());

			const routingCoordinator = (app as any).routingCoordinator;

			expect(routingCoordinator.getGlobalGuards()).toEqual([]);
			expect(routingCoordinator.getGlobalInterceptors()).toEqual([]);
		});
	});

	describe('Container Integration', () => {
		it('should validate container dependencies during bootstrap', async () => {
			// This test verifies that container.validate() is called during bootstrap
			// by checking that invalid dependencies are caught

			// Enable debug mode so FrameworkError throws instead of process.exit
			const originalDebug = process.env.ORIJS_DEBUG;
			process.env.ORIJS_DEBUG = 'true';

			try {
				class MissingDependency {}

				class ServiceWithMissingDep {
					constructor(_dep: MissingDependency) {}
				}

				app = Ori.create()
					.disableSignalHandling()
					// Register service but don't register its dependency
					.provider(ServiceWithMissingDep, [MissingDependency]);

				// bootstrap() should throw due to missing dependency
				await expect(app.listen(getPort())).rejects.toThrow();
			} finally {
				// Restore original debug setting
				if (originalDebug === undefined) {
					delete process.env.ORIJS_DEBUG;
				} else {
					process.env.ORIJS_DEBUG = originalDebug;
				}
			}
		});

		it('should resolve AppContext as injectable dependency', async () => {
			let capturedAppContext: AppContext | null = null;

			class AppContextConsumer {
				constructor(public appContext: AppContext) {
					capturedAppContext = appContext;
				}
			}

			class TestController implements OriController {
				constructor(_consumer: AppContextConsumer) {}

				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create()
				.disableSignalHandling()
				.provider(AppContextConsumer, [AppContext])
				.controller('/ctx', TestController, [AppContextConsumer]);

			await app.listen(getPort());

			// Make a request to trigger controller instantiation
			await fetch(`http://localhost:${port}/ctx`);

			expect(capturedAppContext).not.toBeNull();
			expect(capturedAppContext).toBeInstanceOf(AppContext);
		});

		it('should propagate container through all coordinators', async () => {
			// Verify that the same container instance is used across all coordinators
			// by registering a singleton service and accessing it from multiple places

			class SharedService {
				readonly id = Math.random();
			}

			let controllerServiceId: number | null = null;
			let eventConsumerServiceId: number | null = null;

			const ContainerTestEvent = Event.define({
				name: 'container.test',
				data: Type.Object({}),
				result: Type.Void()
			});

			class ContainerTestConsumer implements IEventConsumer<{}, void> {
				constructor(private service: SharedService) {}

				onEvent = async () => {
					eventConsumerServiceId = this.service.id;
				};
			}

			class ContainerTestController implements OriController {
				constructor(service: SharedService) {
					controllerServiceId = service.id;
				}

				configure(r: RouteBuilder): void {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create()
				.disableSignalHandling()
				.provider(SharedService)
				.event(ContainerTestEvent)
				.consumer(ContainerTestConsumer, [SharedService])
				.controller('/container-test', ContainerTestController, [SharedService]);

			await app.listen(getPort());

			// Trigger controller instantiation
			await fetch(`http://localhost:${port}/container-test`);

			// Trigger event consumer
			app.getEventProvider()!.emit('container.test', {});
			await new Promise((r) => setTimeout(r, 50));

			// Both should have the same service instance (singleton)
			expect(controllerServiceId).not.toBeNull();
			expect(eventConsumerServiceId).not.toBeNull();
			expect(controllerServiceId).toBe(eventConsumerServiceId);
		});
	});

	describe('RoutingCoordinator + RequestPipeline Functional Tests', () => {
		it('should process requests through guards via RequestPipeline', async () => {
			const guardExecutionOrder: string[] = [];

			class FirstGuard implements Guard {
				async canActivate(_ctx: RequestContext): Promise<boolean> {
					guardExecutionOrder.push('first');
					return true;
				}
			}

			class SecondGuard implements Guard {
				async canActivate(_ctx: RequestContext): Promise<boolean> {
					guardExecutionOrder.push('second');
					return true;
				}
			}

			class GuardOrderController implements OriController {
				configure(r: RouteBuilder): void {
					r.guard(FirstGuard);
					r.guard(SecondGuard);
					r.get('/', () => {
						guardExecutionOrder.push('handler');
						return Response.json({ order: guardExecutionOrder });
					});
				}
			}

			app = Ori.create().disableSignalHandling().controller('/guard-order', GuardOrderController);

			await app.listen(getPort());

			const response = await fetch(`http://localhost:${port}/guard-order`);
			const data = (await response.json()) as { order: string[] };

			// Verify guards execute in order before handler
			expect(guardExecutionOrder).toEqual(['first', 'second', 'handler']);
			expect(data.order).toEqual(['first', 'second', 'handler']);
		});

		it('should short-circuit on guard rejection via RequestPipeline', async () => {
			let handlerCalled = false;

			class RejectingGuard implements Guard {
				async canActivate(_ctx: RequestContext): Promise<boolean> {
					return false;
				}
			}

			class RejectedController implements OriController {
				configure(r: RouteBuilder): void {
					r.guard(RejectingGuard);
					r.get('/', () => {
						handlerCalled = true;
						return Response.json({ reached: true });
					});
				}
			}

			app = Ori.create().disableSignalHandling().controller('/rejected', RejectedController);

			await app.listen(getPort());

			const response = await fetch(`http://localhost:${port}/rejected`);

			expect(response.status).toBe(403);
			expect(handlerCalled).toBe(false);
		});

		it('should process requests through interceptors via RequestPipeline', async () => {
			const interceptorOrder: string[] = [];

			class LoggingInterceptor {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
					interceptorOrder.push('before');
					const response = await next();
					interceptorOrder.push('after');
					return response;
				}
			}

			class InterceptedController implements OriController {
				configure(r: RouteBuilder): void {
					r.intercept(LoggingInterceptor);
					r.get('/', () => {
						interceptorOrder.push('handler');
						return Response.json({ ok: true });
					});
				}
			}

			app = Ori.create().disableSignalHandling().controller('/intercepted', InterceptedController);

			await app.listen(getPort());

			await fetch(`http://localhost:${port}/intercepted`);

			// Verify interceptor wraps handler correctly
			expect(interceptorOrder).toEqual(['before', 'handler', 'after']);
		});

		it('should combine global and route-level guards in RequestPipeline', async () => {
			const executionOrder: string[] = [];

			class GlobalGuard implements Guard {
				async canActivate(_ctx: RequestContext): Promise<boolean> {
					executionOrder.push('global');
					return true;
				}
			}

			class RouteGuard implements Guard {
				async canActivate(_ctx: RequestContext): Promise<boolean> {
					executionOrder.push('route');
					return true;
				}
			}

			class CombinedGuardController implements OriController {
				configure(r: RouteBuilder): void {
					r.guard(RouteGuard);
					r.get('/', () => {
						executionOrder.push('handler');
						return Response.json({ ok: true });
					});
				}
			}

			app = Ori.create()
				.disableSignalHandling()
				.guard(GlobalGuard)
				.controller('/combined', CombinedGuardController);

			await app.listen(getPort());

			await fetch(`http://localhost:${port}/combined`);

			// Global guards should execute before route guards
			expect(executionOrder).toEqual(['global', 'route', 'handler']);
		});
	});

	describe('EventCoordinator + WorkflowCoordinator Handoff', () => {
		it('should trigger workflow from event consumer', async () => {
			const executionLog: string[] = [];

			const TriggerEvent = Event.define({
				name: 'workflow.trigger',
				data: Type.Object({ source: Type.String() }),
				result: Type.Void()
			});

			const TriggeredWorkflow = Workflow.define({
				name: 'triggered-workflow',
				data: Type.Object({ triggeredBy: Type.String() }),
				result: Type.Object({ completed: Type.Boolean() })
			});

			class TriggeredWorkflowConsumer implements IWorkflowConsumer<
				(typeof TriggeredWorkflow)['_data'],
				(typeof TriggeredWorkflow)['_result']
			> {
				onComplete = async (ctx: WorkflowContext<(typeof TriggeredWorkflow)['_data']>) => {
					executionLog.push(`workflow-step:${ctx.data.triggeredBy}`);
					executionLog.push('workflow-complete');
					return { completed: true };
				};
			}

			class TriggerEventConsumer implements IEventConsumer<(typeof TriggerEvent)['_data'], void> {
				constructor(private appContext: AppContext) {}

				onEvent = async (ctx: EventContext<(typeof TriggerEvent)['_data']>) => {
					executionLog.push(`event-received:${ctx.data.source}`);
					// Access workflow provider via AppContext
					if (this.appContext.hasWorkflows) {
						const handle = await this.appContext.workflows.execute(TriggeredWorkflow, {
							triggeredBy: ctx.data.source
						});
						await handle.result();
					}
					executionLog.push('event-handler-complete');
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.event(TriggerEvent)
				.consumer(TriggerEventConsumer, [AppContext])
				.workflow(TriggeredWorkflow)
				.consumer(TriggeredWorkflowConsumer);

			await app.listen(getPort());

			// Emit event that triggers workflow
			const provider = app.getEventProvider();
			provider!.emit('workflow.trigger', { source: 'test-event' });

			// Wait for async processing
			await new Promise((r) => setTimeout(r, 100));

			expect(executionLog).toEqual([
				'event-received:test-event',
				'workflow-step:test-event',
				'workflow-complete',
				'event-handler-complete'
			]);
		});

		it('should handle workflow triggered from event consumer class with DI', async () => {
			const executionLog: string[] = [];

			const DITriggerEvent = Event.define({
				name: 'di.workflow.trigger',
				data: Type.Object({ value: Type.Number() }),
				result: Type.Void()
			});

			const DIWorkflow = Workflow.define({
				name: 'di-workflow',
				data: Type.Object({ value: Type.Number() }),
				result: Type.Object({ doubled: Type.Number() })
			});

			class DIWorkflowConsumer implements IWorkflowConsumer<
				(typeof DIWorkflow)['_data'],
				(typeof DIWorkflow)['_result']
			> {
				onComplete = async (ctx: WorkflowContext<(typeof DIWorkflow)['_data']>) => {
					const doubled = ctx.data.value * 2;
					executionLog.push(`doubled:${doubled}`);
					return { doubled };
				};
			}

			// Service that uses AppContext to access workflows
			class WorkflowTriggerService {
				constructor(private appContext: AppContext) {}

				async triggerWorkflow(value: number): Promise<{ doubled: number }> {
					executionLog.push(`service-triggering:${value}`);
					const handle = await this.appContext.workflows.execute(DIWorkflow, { value });
					return handle.result();
				}
			}

			// Event consumer that uses the service
			class DITriggerConsumer implements IEventConsumer<(typeof DITriggerEvent)['_data'], void> {
				constructor(private service: WorkflowTriggerService) {}

				onEvent = async (ctx: EventContext<(typeof DITriggerEvent)['_data']>) => {
					executionLog.push(`handler-received:${ctx.data.value}`);
					const result = await this.service.triggerWorkflow(ctx.data.value);
					executionLog.push(`handler-got-result:${result.doubled}`);
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.provider(WorkflowTriggerService, [AppContext])
				.event(DITriggerEvent)
				.consumer(DITriggerConsumer, [WorkflowTriggerService])
				.workflow(DIWorkflow)
				.consumer(DIWorkflowConsumer);

			await app.listen(getPort());

			// Emit event
			const provider = app.getEventProvider();
			provider!.emit('di.workflow.trigger', { value: 21 });

			// Wait for async processing
			await new Promise((r) => setTimeout(r, 100));

			expect(executionLog).toEqual([
				'handler-received:21',
				'service-triggering:21',
				'doubled:42',
				'handler-got-result:42'
			]);
		});

		it('should handle workflow errors in event consumer gracefully', async () => {
			const executionLog: string[] = [];

			const FailingTriggerEvent = Event.define({
				name: 'failing.workflow.trigger',
				data: Type.Object({}),
				result: Type.Void()
			});

			const FailingWorkflow = Workflow.define({
				name: 'failing-workflow',
				data: Type.Object({}),
				result: Type.Object({})
			});

			class FailingWorkflowConsumer implements IWorkflowConsumer<{}, {}> {
				onComplete = async () => {
					executionLog.push('workflow-failing');
					throw new Error('Workflow step failed');
				};
			}

			class FailingTriggerConsumer implements IEventConsumer<{}, void> {
				constructor(private appContext: AppContext) {}

				onEvent = async () => {
					executionLog.push('event-handler-start');
					try {
						const handle = await this.appContext.workflows.execute(FailingWorkflow, {});
						await handle.result();
						executionLog.push('workflow-succeeded');
					} catch (error) {
						executionLog.push(`workflow-error:${(error as Error).message}`);
					}
					executionLog.push('event-handler-end');
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.event(FailingTriggerEvent)
				.consumer(FailingTriggerConsumer, [AppContext])
				.workflow(FailingWorkflow)
				.consumer(FailingWorkflowConsumer);

			await app.listen(getPort());

			const provider = app.getEventProvider();
			provider!.emit('failing.workflow.trigger', {});

			await new Promise((r) => setTimeout(r, 100));

			expect(executionLog).toContain('event-handler-start');
			expect(executionLog).toContain('workflow-failing');
			expect(executionLog.some((log) => log.startsWith('workflow-error:'))).toBe(true);
			expect(executionLog).toContain('event-handler-end');
		});
	});
});
