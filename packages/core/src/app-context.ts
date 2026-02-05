import type { LifecycleHook, LifecyclePhase, Constructor } from './types/context';
import type { EventSystem } from '@orijs/events';
import type { ConfigProvider } from '@orijs/config';
import type { Logger } from '@orijs/logging';
import type { Container } from './container';
import type { EventCoordinator } from './event-coordinator';
import type { WorkflowCoordinator } from './workflow-coordinator';
import type { WorkflowExecutor } from '@orijs/workflows';
import type { BaseContext } from './base-context';
import type { SocketEmitter } from '@orijs/websocket';

/**
 * Null config provider used when no config is set.
 * Throws helpful errors directing users to set up config.
 */
class NullConfigProvider implements ConfigProvider {
	public async get(): Promise<string | undefined> {
		throw new Error('Config not configured. Call .config(provider) when creating the application.');
	}
	public async getRequired(): Promise<string> {
		throw new Error('Config not configured. Call .config(provider) when creating the application.');
	}
	public async loadKeys(): Promise<Record<string, string | undefined>> {
		throw new Error('Config not configured. Call .config(provider) when creating the application.');
	}
}

/**
 * Application-scoped context.
 * Created once per Application instance.
 * Manages lifecycle hooks and provides DI access.
 *
 * SECURITY: Config is protected from accidental serialization:
 * - Non-enumerable property (won't appear in JSON.stringify or for...in)
 * - Custom toJSON excludes config
 * - Custom inspect excludes config values
 *
 * @typeParam TSocket - The socket emitter type. Defaults to SocketEmitter.
 *   Specify a custom emitter type to get type-safe access to custom methods.
 *
 * @example
 * ```typescript
 * // Default - uses base SocketEmitter interface
 * const ctx: AppContext = app.context;
 * ctx.socket.publish('topic', 'message'); // Only base methods available
 *
 * // With custom emitter type
 * class AppSocketEmitter implements SocketEmitter {
 *   emitToAccount(accountUuid: string, event: string, payload: unknown): void { ... }
 *   // ...implements SocketEmitter methods
 * }
 * const ctx: AppContext<AppSocketEmitter> = app.context;
 * ctx.socket.emitToAccount('uuid', 'event', {}); // Type-safe custom method!
 * ```
 */
export class AppContext<TSocket extends SocketEmitter = SocketEmitter> implements BaseContext {
	private readonly startupHooks: LifecycleHook[] = [];
	private readonly readyHooks: LifecycleHook[] = [];
	private readonly shutdownHooks: LifecycleHook[] = [];
	private currentPhase: LifecyclePhase = 'created';
	private configProvider: ConfigProvider = new NullConfigProvider();
	private eventSystem: EventSystem | undefined;
	private workflowExecutor: WorkflowExecutor | undefined;

	/** Event coordinator for definition-based event handling */
	private _eventCoordinator: EventCoordinator | undefined;

	/** Workflow coordinator for definition-based workflow handling */
	private _workflowCoordinator: WorkflowCoordinator | undefined;

	/** Socket emitter getter function (set by Application.websocket()) */
	private _socketEmitterGetter: (<T extends SocketEmitter>() => T) | undefined;

	constructor(
		public readonly log: Logger,
		private readonly container: Container,
		events?: EventSystem
	) {
		this.eventSystem = events;
		// Make config non-enumerable to prevent accidental serialization
		Object.defineProperty(this, 'configProvider', {
			enumerable: false,
			writable: true
		});
	}

	/** Config provider - protected from serialization */
	get config(): ConfigProvider {
		return this.configProvider;
	}

	/**
	 * Get typed config. Use this when you need app-specific config properties.
	 * @throws {Error} If config provider is not initialized (NullConfigProvider)
	 * @example
	 * ```ts
	 * const config = app.context.getConfig<AppConfig>();
	 * const redisHost = config.redis.host;
	 * ```
	 */
	public getConfig<T>(): T {
		if (this.configProvider instanceof NullConfigProvider) {
			throw new Error('Config not configured. Call .config(provider) when creating the application.');
		}
		return this.configProvider as unknown as T;
	}

	/** Set the config provider (called by Application.config()) */
	public setConfig(provider: ConfigProvider): void {
		this.configProvider = provider;
	}

	/** Event system for emitting and subscribing to events */
	get event(): EventSystem | undefined {
		return this.eventSystem;
	}

	/** Set the event system (called by Application.events()) */
	public setEventSystem(system: EventSystem): void {
		this.eventSystem = system;
	}

	/**
	 * Workflow executor for starting workflows (narrow interface for business code).
	 * Throws if workflows are not configured - call .workflows() on Application first.
	 */
	get workflows(): WorkflowExecutor {
		if (!this.workflowExecutor) {
			throw new Error('Workflows not configured. Call .workflows(registry) when creating the application.');
		}
		return this.workflowExecutor;
	}

	/**
	 * Check if workflows are configured (for conditional logic).
	 * Prefer using `workflows` directly - it throws a helpful error if not configured.
	 */
	get hasWorkflows(): boolean {
		return this.workflowExecutor !== undefined;
	}

	/** Set the workflow executor (called by Application.workflows()) */
	public setWorkflows(executor: WorkflowExecutor): void {
		this.workflowExecutor = executor;
	}

	/**
	 * Event coordinator for definition-based event handling.
	 * Used by RequestContext to create request-bound event emitters.
	 */
	get eventCoordinator(): EventCoordinator | undefined {
		return this._eventCoordinator;
	}

	/** Set the event coordinator (called by Application during bootstrap) */
	public setEventCoordinator(coordinator: EventCoordinator): void {
		this._eventCoordinator = coordinator;
	}

	/**
	 * Workflow coordinator for definition-based workflow handling.
	 * Used by RequestContext to create request-bound workflow executors.
	 */
	get workflowCoordinator(): WorkflowCoordinator | undefined {
		return this._workflowCoordinator;
	}

	/** Set the workflow coordinator (called by Application during bootstrap) */
	public setWorkflowCoordinator(coordinator: WorkflowCoordinator): void {
		this._workflowCoordinator = coordinator;
	}

	/**
	 * Socket emitter for WebSocket messaging.
	 * Throws if WebSocket is not configured.
	 *
	 * Returns the typed socket emitter based on the TSocket type parameter.
	 * When using a custom emitter type, cast AppContext with the emitter type
	 * to get type-safe access to custom methods.
	 *
	 * @throws {Error} If WebSocket is not configured
	 *
	 * @example
	 * ```ts
	 * // In a service injecting AppContext:
	 * this.ctx.socket.publish('room:123', JSON.stringify({ event: 'update' }));
	 *
	 * // With custom emitter type:
	 * class AppSocketEmitter implements SocketEmitter {
	 *   emitToAccount(accountUuid: string, event: string, payload: unknown): void { ... }
	 * }
	 * // Service using typed context:
	 * constructor(private readonly ctx: AppContext<AppSocketEmitter>) {}
	 * this.ctx.socket.emitToAccount('uuid', 'event', {}); // Type-safe!
	 * ```
	 */
	get socket(): TSocket {
		if (!this._socketEmitterGetter) {
			throw new Error(
				'WebSocket not configured. Call .websocket() when creating the application.\n\n' +
					'Example:\n' +
					'  Ori.create()\n' +
					'    .websocket()\n' +
					'    .listen(3000);'
			);
		}
		return this._socketEmitterGetter() as TSocket;
	}

	/**
	 * Check if WebSocket is configured (for conditional logic).
	 * Prefer using `socket` directly - it throws a helpful error if not configured.
	 */
	get hasWebSocket(): boolean {
		return this._socketEmitterGetter !== undefined;
	}

	/** Set the socket emitter getter (called by Application during bootstrap) */
	public setSocketEmitterGetter<T extends SocketEmitter>(getter: () => T): void {
		this._socketEmitterGetter = getter as <T extends SocketEmitter>() => T;
	}

	/** Custom JSON serialization - excludes config to prevent secret leakage */
	public toJSON(): Record<string, unknown> {
		return {
			phase: this.currentPhase
			// Intentionally excludes config
		};
	}

	/** Custom inspect for Bun/Node debugging - excludes config values */
	[Symbol.for('nodejs.util.inspect.custom')](): string {
		return `AppContext { phase: '${this.currentPhase}', config: [REDACTED] }`;
	}

	/** Current lifecycle phase */
	get phase(): LifecyclePhase {
		return this.currentPhase;
	}

	/**
	 * Register a hook to run after bootstrap, before server starts.
	 * Warns if registered after startup phase has passed.
	 */
	public onStartup(hook: LifecycleHook): void {
		if (this.currentPhase !== 'created' && this.currentPhase !== 'bootstrapped') {
			this.log.warn('Startup Hook Registered After Startup Phase');
		}
		this.startupHooks.push(hook);
	}

	/**
	 * Register a hook to run after server starts listening.
	 * Warns if registered after ready phase has passed.
	 */
	public onReady(hook: LifecycleHook): void {
		if (
			this.currentPhase === 'ready' ||
			this.currentPhase === 'stopping' ||
			this.currentPhase === 'stopped'
		) {
			this.log.warn('Ready Hook Registered After Ready Phase');
		}
		this.readyHooks.push(hook);
	}

	/**
	 * Register a hook to run on shutdown.
	 * Can be registered at any time before shutdown.
	 */
	public onShutdown(hook: LifecycleHook): void {
		if (this.currentPhase === 'stopping' || this.currentPhase === 'stopped') {
			this.log.warn('Shutdown Hook Registered During Or After Shutdown');
		}
		this.shutdownHooks.push(hook);
	}

	/**
	 * Resolve a service from the DI container.
	 *
	 * @internal For lifecycle hooks and bootstrap only.
	 * DO NOT use at request-time - use constructor injection instead.
	 *
	 * @example
	 * ```ts
	 * // Good: Use in lifecycle hooks
	 * app.context.onStartup(async () => {
	 *   const db = app.context.resolve(DatabaseService);
	 *   await db.runMigrations();
	 * });
	 *
	 * // Bad: Don't use at request-time - use constructor injection
	 * class MyController {
	 *   // Bad: this.ctx.resolve(OtherService)
	 *   // Good: constructor(private other: OtherService) {}
	 * }
	 * ```
	 */
	public resolve<T>(service: Constructor<T>): T {
		return this.container.resolve(service);
	}

	/**
	 * Resolve a service asynchronously, supporting async constructors.
	 * Use this when your service has a constructor that returns a Promise.
	 *
	 * @internal For lifecycle hooks and bootstrap only.
	 * DO NOT use at request-time - use constructor injection instead.
	 */
	public resolveAsync<T>(service: Constructor<T>): Promise<T> {
		return this.container.resolveAsync(service);
	}

	/**
	 * Set the current lifecycle phase.
	 * @internal Used by Application to manage lifecycle. Not intended for external use.
	 */
	public setPhase(phase: LifecyclePhase): void {
		this.currentPhase = phase;
	}

	/**
	 * Execute all startup hooks in FIFO order.
	 * Each hook completes before the next starts. Errors fail fast.
	 */
	public async executeStartupHooks(): Promise<void> {
		this.currentPhase = 'starting';
		for (const hook of this.startupHooks) {
			await hook();
		}
	}

	/**
	 * Execute all ready hooks in FIFO order.
	 * Each hook completes before the next starts. Errors fail fast.
	 */
	public async executeReadyHooks(): Promise<void> {
		for (const hook of this.readyHooks) {
			await hook();
		}
		this.currentPhase = 'ready';
	}

	/**
	 * Execute all shutdown hooks in LIFO order.
	 * Errors are logged but don't stop other hooks.
	 */
	public async executeShutdownHooks(): Promise<void> {
		this.currentPhase = 'stopping';
		// LIFO order - reverse the array
		const hooks = [...this.shutdownHooks].reverse();
		for (const hook of hooks) {
			try {
				await hook();
			} catch (error) {
				this.log.error('Shutdown hook failed', { error });
			}
		}
		this.currentPhase = 'stopped';
	}

	/** Get count of registered hooks (for testing/debugging) */
	public getHookCounts(): { startup: number; ready: number; shutdown: number } {
		return {
			startup: this.startupHooks.length,
			ready: this.readyHooks.length,
			shutdown: this.shutdownHooks.length
		};
	}
}
