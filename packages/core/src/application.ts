import type {
	ControllerClass,
	Constructor,
	ConstructorDeps,
	InjectionToken,
	GuardClass,
	InterceptorClass,
	SocketRouterClass
} from './types/index';
import type { ControllerConfig, ProviderOptions, AppLoggerOptions, CorsConfig } from './types/application';
import type { ConfigProvider } from '@orijs/config';
import type { EventProvider } from '@orijs/events';
import type { WorkflowProvider } from '@orijs/workflows';
import type { EventDefinition } from './types/event-definition';
import type { WorkflowDefinition } from './types/workflow-definition';
import type { IEventConsumer } from './types/consumer';
import type { IWorkflowConsumer } from './types/consumer';
import { CacheService, InMemoryCacheProvider, type CacheProvider } from '@orijs/cache';
import {
	SocketCoordinator,
	InProcWsProvider,
	WebSocketProviderToken,
	type WebSocketProvider,
	type SocketEmitter,
	type SocketEmitterConstructor,
	type WebSocketHandlers,
	type WebSocketConnection
} from '@orijs/websocket';
import { Container } from './container';
import { AppContext } from './app-context';
import { RoutingCoordinator } from './routing-coordinator';
import { EventCoordinator } from './event-coordinator';
import { WorkflowCoordinator } from './workflow-coordinator';
import { LifecycleManager } from './lifecycle-manager';
import { ProviderCoordinator } from './provider-coordinator';
import { SocketRoutingCoordinator } from './sockets/socket-routing-coordinator';
import { Logger, type LoggerOptions } from '@orijs/logging';
import { ResponseFactory, RequestPipeline, type CompiledRoute } from './controllers/index';
import { Json } from '@orijs/validation';

// Re-export application types for consumers
export type { ControllerConfig, ProviderOptions, AppLoggerOptions };

/** Bun server instance type (Bun-specific) */
type BunServer = ReturnType<typeof Bun.serve>;

/**
 * Options for creating an OriApplication instance.
 * All options are optional - defaults are used if not provided.
 */
export interface ApplicationOptions {
	/** Custom DI container (default: new Container()) */
	container?: Container;
	/** Custom response factory (default: new ResponseFactory()) */
	responseFactory?: ResponseFactory;
	/** Factory for creating RoutingCoordinator (for testing) */
	routingCoordinatorFactory?: (
		container: Container,
		responseFactory: ResponseFactory,
		logger: Logger
	) => RoutingCoordinator;
	/** Factory for creating EventCoordinator (for testing) */
	eventCoordinatorFactory?: (container: Container, logger: Logger) => EventCoordinator;
	/** Factory for creating WorkflowCoordinator (for testing) */
	workflowCoordinatorFactory?: (logger: Logger, container: Container) => WorkflowCoordinator;
	/** Factory for creating LifecycleManager (for testing) */
	lifecycleManagerFactory?: (options: { logger: Logger }) => LifecycleManager;
	/** Factory for creating ProviderCoordinator (for testing) */
	providerCoordinatorFactory?: (container: Container, logger: Logger) => ProviderCoordinator;
	/** Factory for creating SocketRoutingCoordinator (for testing) */
	socketRoutingCoordinatorFactory?: (container: Container, logger: Logger) => SocketRoutingCoordinator;
}

/**
 * Builder interface for fluent event registration.
 *
 * Returned by `.event()` to enable the fluent pattern:
 * ```ts
 * .event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
 * ```
 *
 * If `.consumer()` is not called, the event is registered for emission only
 * (emitter-only apps).
 *
 * @template TPayload - The event payload type
 * @template TResponse - The event response type
 */
export interface EventRegistration<TPayload, TResponse> extends OriApplication {
	/**
	 * Registers a consumer for this event.
	 *
	 * @param consumerClass - The consumer class to instantiate
	 * @param deps - Dependencies to inject into the consumer
	 * @returns The Application for further chaining
	 */
	consumer(
		consumerClass: Constructor<IEventConsumer<TPayload, TResponse>>,
		deps?: Constructor[]
	): OriApplication;
}

/**
 * Builder interface for fluent workflow registration.
 *
 * Returned by `.workflow()` to enable the fluent pattern:
 * ```ts
 * .workflow(SendEmail).consumer(SendEmailWorkflow, [SmtpClient])
 * ```
 *
 * @template TData - The workflow input data type
 * @template TResult - The workflow result type
 */
export interface WorkflowRegistration<TData, TResult> extends OriApplication {
	/**
	 * Registers a consumer for this workflow.
	 *
	 * @param consumerClass - The workflow consumer class to instantiate
	 * @param deps - Dependencies to inject into the consumer
	 * @returns The Application for further chaining
	 */
	consumer(
		consumerClass: Constructor<IWorkflowConsumer<TData, TResult>>,
		deps?: Constructor[]
	): OriApplication;
}

/**
 * The main OriJS application.
 *
 * Use the fluent API to configure providers, controllers, guards, and interceptors,
 * then call `listen()` to start the server.
 *
 * @example
 * ```ts
 * Ori.create()
 *   .config({ cors: { origin: '*' } })
 *   .use(app => addBullMQEvents(app, redis))
 *   .event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
 *   .controller('/users', UsersController, [UserService])
 *   .listen(3000);
 * ```
 */
export class OriApplication<TSocket extends SocketEmitter = SocketEmitter> {
	private readonly container: Container;
	private readonly responseFactory: ResponseFactory;
	private server: BunServer | null = null;
	private appLogger: Logger;
	/** Pre-allocated logger options for request contexts (avoids per-request object allocation) */
	private sharedLoggerOptions: LoggerOptions = { level: 'info' };
	/** Application context - created in constructor, always available */
	private readonly _context: AppContext<TSocket>;
	/** Config provider to be set on AppContext during bootstrap */
	private pendingConfig: ConfigProvider | null = null;
	/** Request pipeline for handling requests */
	private pipeline: RequestPipeline;
	/** Pending async config factory to await before bootstrap */
	private pendingAsyncConfig: Promise<void> | null = null;
	/** Deferred extensions to run after config is ready */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private deferredExtensions: Array<(app: OriApplication<any>) => OriApplication<any>> = [];

	// Coordinators and managers handle delegated responsibilities
	private readonly routingCoordinator: RoutingCoordinator;
	private readonly eventCoordinator: EventCoordinator;
	private readonly workflowCoordinator: WorkflowCoordinator;
	private readonly lifecycleManager: LifecycleManager;
	private readonly providerCoordinator: ProviderCoordinator;
	private readonly socketRoutingCoordinator: SocketRoutingCoordinator<TSocket>;

	// WebSocket configuration (fields used in listen() - see task 2.6)
	private websocketCoordinator: SocketCoordinator | null = null;
	private websocketProvider: WebSocketProvider | null = null;
	private _websocketPath: string = '/ws';
	private _websocketHandlers: WebSocketHandlers<unknown> | null = null;
	private websocketEmitterClass: SocketEmitterConstructor<SocketEmitter> | null = null;
	private websocketEmitterInstance: SocketEmitter | null = null;
	private _websocketUpgrade: ((request: Request) => Promise<unknown | null> | unknown | null) | null = null;

	// CORS configuration (from OriAppConfig)
	private _corsConfig: CorsConfig | null = null;
	// Pre-computed static CORS headers (computed once at startup)
	private _staticCorsHeaders: Record<string, string> | null = null;

	constructor(options?: ApplicationOptions) {
		// Logger must be created first so all components can use it
		this.appLogger = new Logger('OriJS', { level: 'info' });
		this.container = options?.container ?? new Container({ logger: this.appLogger });
		this.responseFactory = options?.responseFactory ?? new ResponseFactory();
		this.pipeline = new RequestPipeline(this.container, this.responseFactory, this.appLogger);

		// Create AppContext early so it's available for provider extensions (.use())
		// Hooks like onShutdown() can be registered during setup, before listen()
		// Type assertion needed: AppContext starts as base type, upgraded via websocket<TEmitter>()
		this._context = new AppContext(this.appLogger, this.container) as AppContext<TSocket>;

		// Initialize coordinators and managers (use factories if provided for testing)
		this.routingCoordinator =
			options?.routingCoordinatorFactory?.(this.container, this.responseFactory, this.appLogger) ??
			new RoutingCoordinator(this.container, this.responseFactory, this.appLogger);
		this.eventCoordinator =
			options?.eventCoordinatorFactory?.(this.container, this.appLogger) ??
			new EventCoordinator(this.container, this.appLogger.child('EventCoordinator'));
		this.workflowCoordinator =
			options?.workflowCoordinatorFactory?.(this.appLogger, this.container) ??
			new WorkflowCoordinator(this.appLogger.child('WorkflowCoordinator'), this.container);
		this.lifecycleManager =
			options?.lifecycleManagerFactory?.({ logger: this.appLogger }) ??
			new LifecycleManager({ logger: this.appLogger });
		this.providerCoordinator =
			options?.providerCoordinatorFactory?.(this.container, this.appLogger) ??
			new ProviderCoordinator(this.container, this.appLogger);
		// Type assertion needed: coordinator starts as base type, upgraded via websocket<TEmitter>()
		this.socketRoutingCoordinator = (options?.socketRoutingCoordinatorFactory?.(
			this.container,
			this.appLogger
		) ??
			new SocketRoutingCoordinator(
				this.container,
				this.appLogger.child('SocketRouting')
			)) as SocketRoutingCoordinator<TSocket>;
	}

	/**
	 * Configures the application with a ConfigProvider or async factory.
	 *
	 * @example
	 * ```ts
	 * Ori.create()
	 *   .config(addConfig)
	 *   .cors({ origin: '*' })
	 *   .logger({ level: 'debug' })
	 *   .listen(3000);
	 * ```
	 */
	public config(factoryOrProvider: ConfigProvider | ((app: OriApplication<TSocket>) => Promise<void>)): this {
		if (typeof factoryOrProvider === 'function') {
			this.pendingAsyncConfig = factoryOrProvider(this);
		} else {
			this.pendingConfig = factoryOrProvider;
		}
		return this;
	}

	/**
	 * Configures CORS for the application.
	 */
	public cors(config: CorsConfig): this {
		this._corsConfig = config;
		return this;
	}

	/**
	 * Configures the application logger.
	 * Also sets global defaults so all Logger instances share the same config.
	 * @param options - Logger configuration options
	 */
	public logger(options: AppLoggerOptions): this {
		// Clear console BEFORE flushing buffered logs so warnings are visible
		if (options.clearConsole) {
			console.clear();
		}

		// Configure global defaults for all loggers (flushes any buffered logs)
		Logger.configure({
			level: options.level ?? 'info',
			transports: options.transports
		});

		// Update shared logger options for request contexts
		this.sharedLoggerOptions = {
			level: options.level ?? 'info',
			transports: options.transports
		};

		this.appLogger = new Logger('OriJS', {
			level: options.level ?? 'info',
			transports: options.transports
		});
		this.container.setLogger(this.appLogger);

		// Recreate pipeline with new logger
		this.pipeline = new RequestPipeline(this.container, this.responseFactory, this.appLogger);
		return this;
	}

	/**
	 * Adds a global guard that applies to all routes.
	 * @param guard - The guard class
	 */
	public guard(guard: GuardClass): this {
		this.routingCoordinator.addGuard(guard);
		return this;
	}

	/**
	 * Adds a global interceptor that applies to all routes.
	 * @param interceptor - The interceptor class
	 */
	public intercept(interceptor: InterceptorClass): this {
		this.routingCoordinator.addInterceptor(interceptor);
		return this;
	}

	/**
	 * Registers a provider (service) with no dependencies.
	 * @param service - The service class
	 * @param options - Provider options (e.g., { eager: true } for immediate instantiation)
	 */
	public provider<T extends new () => unknown>(service: T, options?: ProviderOptions): this;
	/**
	 * Registers a provider (service) with the DI container.
	 * TypeScript enforces correct dependency types and order.
	 * @param service - The service class
	 * @param deps - Array of dependency classes (must match constructor parameter types and order)
	 * @param options - Provider options (e.g., { eager: true } for immediate instantiation)
	 *
	 * @example
	 * ```ts
	 * // Lazy provider (default) - instantiated on first use
	 * .provider(UserService, [DatabaseService])
	 *
	 * // Eager provider - instantiated at startup
	 * .provider(QueueListener, [Redis], { eager: true })
	 * ```
	 */
	public provider<T extends Constructor>(
		service: T,
		deps: ConstructorDeps<T>,
		options?: ProviderOptions
	): this;
	public provider<T extends Constructor>(
		service: T,
		depsOrOptions?: ConstructorDeps<T> | ProviderOptions,
		options?: ProviderOptions
	): this {
		// Handle overload: provider(Service) or provider(Service, options) vs provider(Service, deps, options)
		const isOptions = (arg: unknown): arg is ProviderOptions =>
			arg !== undefined && !Array.isArray(arg) && typeof arg === 'object';

		const deps = Array.isArray(depsOrOptions) ? depsOrOptions : [];
		const opts = isOptions(depsOrOptions) ? depsOrOptions : options;

		this.providerCoordinator.addProvider(service, deps, opts?.eager);
		return this;
	}

	/**
	 * Registers a pre-instantiated value as a provider.
	 * Useful for services that need external configuration (e.g., database connections).
	 * Works with both class constructors and injection tokens (symbols/strings).
	 * @param token - The service class or injection token (used as the key)
	 * @param instance - The pre-created instance
	 */
	public providerInstance<T>(token: InjectionToken<T>, instance: T): this {
		this.providerCoordinator.registerInstance(token, instance);
		return this;
	}

	/**
	 * Registers a provider with explicit dependency tokens.
	 * Use when dependencies include named tokens (symbols) created with createToken().
	 *
	 * This method trades compile-time type checking for flexibility when using
	 * named providers. Ensure dependencies are listed in constructor order.
	 *
	 * @param service - The service class
	 * @param deps - Array of dependency tokens (constructors or symbols)
	 * @param options - Provider options (e.g., { eager: true })
	 *
	 * @example
	 * ```ts
	 * import { createToken } from '@orijs/core';
	 *
	 * // Create tokens for named providers
	 * const HotCache = createToken<CacheService>('HotCache');
	 * const ColdCache = createToken<CacheService>('ColdCache');
	 *
	 * Ori.create()
	 *   .providerInstance(HotCache, new CacheService(memoryProvider))
	 *   .providerInstance(ColdCache, new CacheService(redisProvider))
	 *   .providerWithTokens(HotDataService, [HotCache])
	 *   .providerWithTokens(ColdDataService, [ColdCache])
	 *   .listen(3000);
	 * ```
	 */
	public providerWithTokens<T extends Constructor>(
		service: T,
		deps: InjectionToken[],
		options?: ProviderOptions
	): this {
		// Tokens are resolved at runtime, so we cast to satisfy the registry
		this.providerCoordinator.addProvider(service, deps as Constructor[], options?.eager);
		return this;
	}

	/**
	 * Applies a provider extension function to register multiple providers.
	 * Inspired by .NET Core's IServiceCollection extension method pattern.
	 *
	 * @example
	 * ```ts
	 * // Define extension functions in providers.ts
	 * export function addDatabase(app: Application, sql: SQL): Application {
	 *   return app
	 *     .providerInstance(DbSqlService, new DbSqlService(sql))
	 *     .provider(UserMapper)
	 *     .provider(DbUserService, [DbSqlService, UserMapper]);
	 * }
	 *
	 * // Use in app.ts
	 * Ori.create()
	 *   .use(app => addDatabase(app, sql))
	 *   .use(addRepositories)
	 *   .listen(3000);
	 * ```
	 *
	 * @param extension - A function that registers providers and returns the app
	 */
	public use(extension: (app: OriApplication<TSocket>) => OriApplication<TSocket>): this {
		if (this.pendingAsyncConfig) {
			// Defer until config is ready
			this.deferredExtensions.push(extension);
		} else {
			extension(this);
		}
		return this;
	}

	/**
	 * Registers an event definition with optional consumer.
	 *
	 * Returns a fluent builder that allows chaining `.consumer()` to register
	 * an event consumer, or continuing with other Application methods for
	 * emitter-only apps.
	 *
	 * @param definition - The event definition created with Event.define()
	 * @returns EventRegistration builder for fluent chaining
	 *
	 * @example
	 * ```ts
	 * import { Event, type Consumer } from '@orijs/core';
	 * import { Type } from '@orijs/validation';
	 *
	 * // Define the event
	 * const UserCreated = Event.define({
	 *   name: 'user.created',
	 *   data: Type.Object({ userId: Type.String(), email: Type.String() }),
	 *   result: Type.Object({ welcomeEmailSent: Type.Boolean() })
	 * });
	 *
	 * // Consumer implementation
	 * class UserCreatedConsumer implements EventConsumer<typeof UserCreated> {
	 *   constructor(private emailService: EmailService) {}
	 *   onEvent = async (ctx) => {
	 *     await this.emailService.sendWelcome(ctx.payload.email);
	 *     return { welcomeEmailSent: true };
	 *   };
	 * }
	 *
	 * // Application setup with consumer
	 * Ori.create()
	 *   .use(app => addBullMQEvents(app, redis))
	 *   .event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
	 *   .controller('/users', UsersController, [UserService])
	 *   .listen(3000);
	 *
	 * // Emitter-only app (no consumer)
	 * Ori.create()
	 *   .event(UserCreated)  // Just declares - can emit but doesn't consume
	 *   .controller('/users', UsersController, [UserService])
	 *   .listen(8000);
	 * ```
	 */
	public event<TPayload, TResponse>(
		definition: EventDefinition<TPayload, TResponse>
	): EventRegistration<TPayload, TResponse> {
		// Register the event definition (for emitter-only support)
		this.eventCoordinator.registerEventDefinition(definition);

		// Return a Proxy that adds the consumer() method while preserving all Application methods
		return new Proxy(this, {
			get: (target, prop, receiver) => {
				if (prop === 'consumer') {
					return (
						consumerClass: Constructor<IEventConsumer<TPayload, TResponse>>,
						deps: Constructor[] = []
					): OriApplication<TSocket> => {
						target.eventCoordinator.addEventConsumer(definition, consumerClass, deps);
						return target;
					};
				}
				return Reflect.get(target, prop, receiver);
			}
		}) as unknown as EventRegistration<TPayload, TResponse>;
	}

	/**
	 * Returns the event provider (useful for testing and manual emission).
	 * Returns null if no events are configured.
	 */
	public getEventProvider(): EventProvider | null {
		return this.eventCoordinator.getProvider();
	}

	/**
	 * Sets a custom event provider for the application.
	 * Use this to integrate with distributed event systems like BullMQ.
	 *
	 * @param provider - The event provider to use
	 * @returns this (for chaining)
	 *
	 * @example
	 * ```ts
	 * import { BullMQEventProvider } from '@orijs/bullmq';
	 *
	 * Ori.create()
	 *   .eventProvider(new BullMQEventProvider(redis))
	 *   .event(UserCreated).consumer(UserCreatedHandler)
	 *   .listen(3000);
	 * ```
	 */
	public eventProvider(provider: EventProvider): this {
		this.eventCoordinator.setProvider(provider);
		return this;
	}

	/**
	 * Sets a custom workflow provider for the application.
	 * Use this to integrate with distributed workflow systems like BullMQ.
	 *
	 * @param provider - The workflow provider to use
	 * @returns this (for chaining)
	 *
	 * @example
	 * ```ts
	 * import { BullMQWorkflowProvider } from '@orijs/bullmq';
	 *
	 * Ori.create()
	 *   .workflowProvider(new BullMQWorkflowProvider(redis))
	 *   .workflow(SendEmail).consumer(SendEmailWorkflow)
	 *   .listen(3000);
	 * ```
	 */
	public workflowProvider(provider: WorkflowProvider): this {
		this.workflowCoordinator.setProvider(provider);
		return this;
	}

	/**
	 * Registers a workflow definition with optional consumer.
	 *
	 * Returns a fluent builder that allows chaining `.consumer()` to register
	 * a workflow consumer.
	 *
	 * @param definition - The workflow definition created with Workflow.define()
	 * @returns WorkflowRegistration builder for fluent chaining
	 *
	 * @example
	 * ```ts
	 * import { Workflow, type WorkflowConsumer } from '@orijs/core';
	 * import { Type } from '@orijs/validation';
	 *
	 * // Define the workflow
	 * const SendEmail = Workflow.define({
	 *   name: 'send-email',
	 *   data: Type.Object({ to: Type.String(), subject: Type.String() }),
	 *   result: Type.Object({ messageId: Type.String(), sentAt: Type.String() })
	 * });
	 *
	 * // Workflow consumer implementation
	 * class SendEmailWorkflow implements WorkflowConsumer<typeof SendEmail> {
	 *   constructor(private smtpClient: SmtpClient) {}
	 *
	 *   configure(w: WorkflowBuilder): void {}
	 *
	 *   onComplete = async (ctx) => {
	 *     const result = await this.smtpClient.send(ctx.data.to, ctx.data.subject);
	 *     return { messageId: result.id, sentAt: new Date().toISOString() };
	 *   };
	 * }
	 *
	 * // Application setup
	 * Ori.create()
	 *   .use(app => addBullMQWorkflows(app, redis))
	 *   .workflow(SendEmail).consumer(SendEmailWorkflow, [SmtpClient])
	 *   .controller('/notifications', NotificationController, [NotificationService])
	 *   .listen(3000);
	 * ```
	 */
	public workflow<TData, TResult>(
		definition: WorkflowDefinition<TData, TResult>
	): WorkflowRegistration<TData, TResult> {
		// Register the workflow definition
		this.workflowCoordinator.registerWorkflowDefinition(definition);

		// Return a Proxy that adds the consumer() method while preserving all Application methods
		return new Proxy(this, {
			get: (target, prop, receiver) => {
				if (prop === 'consumer') {
					return (
						consumerClass: Constructor<IWorkflowConsumer<TData, TResult>>,
						deps: Constructor[] = []
					): OriApplication<TSocket> => {
						target.workflowCoordinator.addWorkflowConsumer(definition, consumerClass, deps);
						return target;
					};
				}
				return Reflect.get(target, prop, receiver);
			}
		}) as unknown as WorkflowRegistration<TData, TResult>;
	}

	/**
	 * Returns the workflow provider (useful for testing and direct access).
	 * Returns null if no workflows configured.
	 */
	public getWorkflowProvider(): WorkflowProvider | null {
		return this.workflowCoordinator.getProvider();
	}

	/**
	 * Configures the cache system for the application.
	 * If no provider is provided, InMemoryCacheProvider is used (suitable for dev/testing).
	 *
	 * @param provider - Optional custom cache provider (default: InMemoryCacheProvider)
	 * @returns this (for chaining)
	 *
	 * @example
	 * ```ts
	 * // Development/testing with in-memory cache
	 * Ori.create()
	 *   .cache()
	 *   .provider(UserService, [CacheService])
	 *   .listen(3000);
	 *
	 * // Production with Redis
	 * import { RedisCacheProvider } from '@orijs/cache-redis';
	 *
	 * Ori.create()
	 *   .cache(new RedisCacheProvider(redis))
	 *   .provider(UserService, [CacheService])
	 *   .listen(3000);
	 * ```
	 */
	public cache(provider?: CacheProvider): this {
		const cacheService = new CacheService(provider ?? new InMemoryCacheProvider());
		this.providerInstance(CacheService, cacheService);
		return this;
	}

	/**
	 * Returns the cache service (useful for testing and direct access).
	 * Returns null if no cache configured.
	 * Throws if cache is configured but has dependency/resolution errors.
	 */
	public getCacheService(): CacheService | null {
		// Check if cache is registered before resolving
		// This avoids masking genuine configuration errors as "not configured"
		if (!this.container.has(CacheService)) {
			return null;
		}
		return this.container.resolve(CacheService);
	}

	/**
	 * Configures WebSocket support for the application.
	 *
	 * **⚠️ IMPORTANT: Single-Instance Limitation**
	 *
	 * The default `InProcWsProvider` stores connections in memory and is only suitable
	 * for **single-instance deployments**. In horizontally-scaled environments (multiple
	 * server instances behind a load balancer), messages published on one instance will
	 * NOT reach clients connected to other instances.
	 *
	 * For production deployments with horizontal scaling, use a distributed provider:
	 * ```ts
	 * import { RedisWsProvider } from '@orijs/websocket-redis';
	 * Ori.create().websocket(new RedisWsProvider(redis)).listen(3000);
	 * ```
	 *
	 * @typeParam TEmitter - Custom emitter class type. This generic provides IDE autocompletion
	 *   when using `getSocketEmitter<TEmitter>()`. Note: The type is used for inference only;
	 *   internally the emitter is stored as `SocketEmitter` for flexibility.
	 * @param provider - Optional custom WebSocket provider (default: InProcWsProvider)
	 * @param options - Optional configuration for WebSocket handling
	 * @returns this (for chaining)
	 *
	 * @example
	 * ```ts
	 * // Basic WebSocket with default in-process provider
	 * Ori.create()
	 *   .websocket()
	 *   .onWebSocket({
	 *     open: (ws) => ws.subscribe('global'),
	 *     message: (ws, msg) => console.log('Received:', msg)
	 *   })
	 *   .listen(3000);
	 *
	 * // With custom emitter class for type-safe domain methods
	 * class AppSocketEmitter implements SocketEmitter {
	 *   constructor(private provider: WebSocketProvider) {}
	 *   publish(topic: string, message: string) { this.provider.publish(topic, message); }
	 *   send(socketId: string, message: string) { return this.provider.send(socketId, message); }
	 *   broadcast(message: string) { this.provider.broadcast(message); }
	 *   emitToAccount(accountUuid: string, event: string, payload: unknown) {
	 *     this.publish(`account:${accountUuid}`, JSON.stringify({ event, payload }));
	 *   }
	 * }
	 *
	 * Ori.create()
	 *   .websocket<AppSocketEmitter>(new InProcWsProvider(), {
	 *     path: '/ws',
	 *     emitter: AppSocketEmitter,
	 *     upgrade: async (req) => {
	 *       const token = req.headers.get('authorization');
	 *       return token ? { userId: 'user-123' } : null; // null rejects
	 *     }
	 *   })
	 *   .listen(3000);
	 *
	 * // Production with Redis provider for horizontal scaling
	 * import { RedisWsProvider } from '@orijs/websocket-redis';
	 *
	 * Ori.create()
	 *   .websocket(new RedisWsProvider(redis))
	 *   .listen(3000);
	 * ```
	 *
	 * @remarks
	 * **Topic Naming Best Practices:**
	 * - Use prefixes that users cannot control (e.g., `account:${accountUuid}`, `user:${userId}`)
	 * - Never pass user input directly as topic names without validation
	 * - Consider an allowlist of valid topic patterns for user-provided topics
	 * - The `__broadcast__` topic is reserved for internal use
	 *
	 * @typeParam TEmitter - Custom emitter class type (default: SocketEmitter)
	 * @typeParam TData - Type of user data returned by upgrade handler. Use the same type
	 *   parameter in `onWebSocket<TData>()` for type consistency in handlers.
	 *
	 * @example
	 * ```typescript
	 * interface UserData { userId: string; role: string; }
	 *
	 * app.websocket<SocketEmitter, UserData>(undefined, {
	 *   upgrade: async (req) => {
	 *     const token = req.headers.get('Authorization');
	 *     if (!token) return null;
	 *     return { userId: '123', role: 'admin' }; // Type-checked as UserData
	 *   }
	 * }).onWebSocket<UserData>({
	 *   open: (ws) => {
	 *     console.log(ws.data.data.userId); // Type-safe access
	 *   },
	 *   // ...
	 * });
	 * ```
	 */
	public websocket<TEmitter extends SocketEmitter = SocketEmitter, TData = unknown>(
		provider?: WebSocketProvider,
		options?: {
			/** Path for WebSocket connections (default: '/ws') */
			path?: string;
			/** Custom emitter class for domain-specific methods */
			emitter?: SocketEmitterConstructor<TEmitter>;
			/** Upgrade handler to validate connections and attach data. Return null to reject. */
			upgrade?: (request: Request) => Promise<TData | null> | TData | null;
		}
	): OriApplication<TEmitter> {
		const wsProvider = provider ?? new InProcWsProvider({ logger: this.appLogger.child('WebSocket') });

		this.websocketCoordinator = new SocketCoordinator({
			provider: wsProvider,
			logger: this.appLogger.child('WebSocket')
		});

		this.websocketProvider = wsProvider;
		this._websocketPath = options?.path ?? '/ws';
		this.websocketEmitterClass = (options?.emitter ?? null) as SocketEmitterConstructor<SocketEmitter> | null;
		this._websocketUpgrade = options?.upgrade ?? null;

		// Register provider instance for DI
		this.container.registerInstance(WebSocketProviderToken, wsProvider);

		// Return with upgraded type - TEmitter is now the socket emitter type for all downstream code
		return this as unknown as OriApplication<TEmitter>;
	}

	/**
	 * Registers WebSocket lifecycle event handlers.
	 * Call after .websocket() to handle connection events.
	 *
	 * @typeParam TData - The type of custom data attached during upgrade. This generic
	 *   provides IDE autocompletion and documentation value. Note: The actual data type
	 *   depends on what your upgrade handler returns - this parameter is not enforced
	 *   at runtime.
	 * @param handlers - Object containing lifecycle event handlers
	 * @returns this (for chaining)
	 *
	 * @example
	 * ```ts
	 * Ori.create()
	 *   .websocket()
	 *   .onWebSocket<{ userId: string }>({
	 *     open: (ws) => {
	 *       console.log('Connected:', ws.data.data.userId);
	 *       ws.subscribe('global');
	 *     },
	 *     message: (ws, message) => {
	 *       console.log('Message from', ws.data.socketId, ':', message);
	 *     },
	 *     close: (ws, code, reason) => {
	 *       console.log('Disconnected:', ws.data.socketId, code, reason);
	 *     }
	 *   })
	 *   .listen(3000);
	 * ```
	 */
	public onWebSocket<TData = unknown>(handlers: WebSocketHandlers<TData>): this {
		this._websocketHandlers = handlers as WebSocketHandlers<unknown>;
		return this;
	}

	/**
	 * Returns the WebSocket coordinator (useful for testing and direct access).
	 * Returns null if WebSocket is not configured.
	 */
	public getWebSocketCoordinator(): SocketCoordinator | null {
		return this.websocketCoordinator;
	}

	/**
	 * Returns the WebSocket provider (useful for testing and direct access).
	 * Returns null if WebSocket is not configured.
	 */
	public getWebSocketProvider(): WebSocketProvider | null {
		return this.websocketProvider;
	}

	/**
	 * Gets or creates the socket emitter instance.
	 * If a custom emitter class was provided, instantiates it.
	 * Otherwise returns the provider directly as it implements SocketEmitter.
	 *
	 * **Type Parameter Note**: Due to TypeScript limitations with builder patterns,
	 * the generic type parameter from `.websocket<TEmitter>()` is not automatically
	 * preserved. If you configured a custom emitter class, you must specify the
	 * type parameter again when calling this method:
	 *
	 * @example
	 * ```ts
	 * // When using a custom emitter:
	 * const emitter = app.getSocketEmitter<MyCustomEmitter>();
	 * ```
	 *
	 * @typeParam TEmitter - The emitter type. Must match what was configured in `.websocket()`.
	 * @throws Error if WebSocket is not configured
	 * @internal Used by RequestContext and AppContext to provide ctx.socket
	 */
	public getSocketEmitter<TEmitter extends SocketEmitter = SocketEmitter>(): TEmitter {
		if (!this.websocketProvider) {
			throw new Error(
				'WebSocket not configured. Call .websocket() when creating the application.\n\n' +
					'Example:\n' +
					'  Ori.create()\n' +
					'    .websocket()\n' +
					'    .listen(3000);'
			);
		}

		if (this.websocketEmitterInstance === null) {
			if (this.websocketEmitterClass) {
				this.websocketEmitterInstance = new this.websocketEmitterClass(this.websocketProvider);
			} else {
				// Use provider directly as it implements SocketEmitter
				this.websocketEmitterInstance = this.websocketProvider;
			}
		}

		return this.websocketEmitterInstance as TEmitter;
	}

	/**
	 * Registers a controller with no dependencies.
	 * @param path - The base path for all routes in this controller
	 * @param controller - The controller class (must implement OriController)
	 */
	public controller<T extends new () => unknown>(path: string, controller: T & ControllerClass): this;
	/**
	 * Registers a controller with its routes.
	 * TypeScript enforces correct dependency types and order.
	 * @param path - The base path for all routes in this controller
	 * @param controller - The controller class (must implement OriController)
	 * @param deps - Array of dependency classes (must match constructor parameter types and order)
	 */
	public controller<T extends ControllerClass>(path: string, controller: T, deps: ConstructorDeps<T>): this;
	public controller<T extends ControllerClass>(path: string, controller: T, deps: Constructor[] = []): this {
		this.routingCoordinator.addController({ path, controller, deps });
		return this;
	}

	/**
	 * Registers a socket router with no dependencies.
	 * Socket routers handle WebSocket messages with connection guards running ONCE on upgrade.
	 *
	 * @param router - The socket router class (must implement OriSocketRouter)
	 */
	public socketRouter<T extends new () => unknown>(router: T & SocketRouterClass): this;
	/**
	 * Registers a socket router with its message handlers.
	 * TypeScript enforces correct dependency types and order.
	 *
	 * Socket routers handle WebSocket connections in two phases:
	 * 1. Connection: Guards run ONCE on WebSocket upgrade (authentication)
	 * 2. Routing: Messages route to handlers with pre-authenticated state
	 *
	 * @param router - The socket router class (must implement OriSocketRouter)
	 * @param deps - Array of dependency classes (must match constructor parameter types and order)
	 *
	 * @example
	 * ```ts
	 * interface AuthState { user: UserWithAccountAndRoles }
	 *
	 * class PresenceRouter implements OriSocketRouter<AuthState> {
	 *   constructor(private presenceService: PresenceClientService) {}
	 *
	 *   configure(r: SocketRouteBuilder<AuthState>) {
	 *     r.connectionGuard(FirebaseAuthGuard);  // Runs ONCE on connect
	 *     r.on('heartbeat', this.handleHeartbeat);
	 *   }
	 *
	 *   private handleHeartbeat = async (ctx: SocketContext<AuthState>) => {
	 *     await this.presenceService.updatePresence(ctx.state.user);
	 *     return { team: await this.presenceService.getTeamPresence(ctx.state.user) };
	 *   };
	 * }
	 *
	 * Ori.create()
	 *   .websocket()
	 *   .socketRouter(PresenceRouter, [PresenceClientService])
	 *   .listen(3000);
	 * ```
	 */
	public socketRouter<T extends SocketRouterClass>(router: T, deps: ConstructorDeps<T>): this;
	public socketRouter<T extends SocketRouterClass>(router: T, deps: Constructor[] = []): this {
		this.socketRoutingCoordinator.addRouter({ router, deps });
		return this;
	}

	/**
	 * Starts the HTTP server asynchronously.
	 * Executes startup hooks before serving, and ready hooks after.
	 * @param port - The port to listen on
	 * @param callback - Optional callback invoked when server is ready
	 * @returns Promise resolving to the Bun server instance
	 */
	public async listen(port: number, callback?: () => void): Promise<BunServer> {
		const startTime = performance.now();
		this.logHeader();

		// Await async config factory before bootstrap
		if (this.pendingAsyncConfig) {
			await this.pendingAsyncConfig;
		}

		// Apply config to AppContext before deferred extensions run
		if (this.pendingConfig) {
			this._context.setConfig(this.pendingConfig);
		}

		// Run deferred extensions now that config is ready
		for (const extension of this.deferredExtensions) {
			extension(this);
		}

		this.bootstrap();

		// Initialize socket routing coordinator if socket controllers are registered
		if (this.socketRoutingCoordinator.hasRouters()) {
			this.socketRoutingCoordinator.initialize(this._context, this.sharedLoggerOptions);
		}

		await this.startSystems();
		this.logSummary(startTime);

		// Pre-compute static CORS headers before route generation
		if (this._corsConfig) {
			this._staticCorsHeaders = this.buildStaticCorsHeaders();
		}

		const bunRoutes = this.routingCoordinator.generateBunRoutes(
			this._context,
			this.sharedLoggerOptions,
			this.pipeline,
			this._staticCorsHeaders
		);

		// Create server with optional WebSocket support
		if (this.websocketProvider) {
			this.appLogger.debug('Creating server with WebSocket support', { path: this._websocketPath });
			this.server = Bun.serve({
				port,
				routes: bunRoutes,
				fetch: (request, server) => this.handleFetch(request, server),
				websocket: this.buildWebSocketHandlers()
			});
		} else {
			this.server = Bun.serve({
				port,
				routes: bunRoutes,
				fetch: (request) => this.handleUnmatchedRequest(request)
			});
		}

		// Set server reference on WebSocket provider for publishing
		if (this.websocketProvider) {
			this.appLogger.debug('Setting server reference on WebSocket provider');
			this.websocketProvider.setServer(this.server);
			this.appLogger.info(`WebSocket enabled at: ws://localhost:${port}${this._websocketPath}`);
		}

		this.appLogger.info(`Server Listening: http://localhost:${port}`);
		await this.finalizeStartup(callback);

		return this.server;
	}

	/**
	 * Handles fetch requests, including WebSocket upgrades and CORS.
	 */
	private async handleFetch(request: Request, server: BunServer): Promise<Response | undefined> {
		// Handle CORS preflight
		if (this._corsConfig && request.method === 'OPTIONS') {
			return this.handleCorsPreFlight(request);
		}

		// Check for WebSocket upgrade at configured path
		if (this.websocketProvider) {
			const url = new URL(request.url);
			if (url.pathname === this._websocketPath && request.headers.get('upgrade') === 'websocket') {
				return this.handleWebSocketUpgrade(request, server);
			}
		}

		// Fall through to normal request handling
		return this.handleUnmatchedRequest(request);
	}

	/**
	 * Handles CORS preflight OPTIONS requests.
	 */
	private handleCorsPreFlight(request: Request): Response {
		const headers = this.getCorsHeadersForRequest(request);
		return new Response(null, { status: 204, headers });
	}

	/**
	 * Builds static CORS headers once at startup.
	 * Called during listen() after config is set.
	 */
	private buildStaticCorsHeaders(): Record<string, string> {
		if (!this._corsConfig) return {};

		const headers: Record<string, string> = {
			'Access-Control-Allow-Methods': (
				this._corsConfig.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
			).join(', '),
			'Access-Control-Allow-Headers': (
				this._corsConfig.allowedHeaders ?? ['Content-Type', 'Authorization', 'X-Firebase-AppCheck']
			).join(', '),
			'Access-Control-Max-Age': String(this._corsConfig.maxAge ?? 86400)
		};

		if (this._corsConfig.credentials !== false) {
			headers['Access-Control-Allow-Credentials'] = 'true';
		}

		if (this._corsConfig.exposedHeaders?.length) {
			headers['Access-Control-Expose-Headers'] = this._corsConfig.exposedHeaders.join(', ');
		}

		// If origin is static (not array), add it now
		const origin = this._corsConfig.origin;
		if (!Array.isArray(origin)) {
			headers['Access-Control-Allow-Origin'] = origin;
		}

		return headers;
	}

	/**
	 * Gets CORS headers for a request.
	 * Uses pre-computed static headers, only computing origin dynamically for array origins.
	 */
	private getCorsHeadersForRequest(request: Request): Record<string, string> {
		if (!this._staticCorsHeaders || !this._corsConfig) return {};

		// If origin is not an array, static headers already include it
		if (!Array.isArray(this._corsConfig.origin)) {
			return this._staticCorsHeaders;
		}

		// For array origins, check if request origin is allowed
		const requestOrigin = request.headers.get('Origin');
		const allowedOrigins = this._corsConfig.origin;
		const allowedOrigin =
			requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : (allowedOrigins[0] ?? '*');

		return {
			...this._staticCorsHeaders,
			'Access-Control-Allow-Origin': allowedOrigin
		};
	}

	/** Timeout for WebSocket upgrade handlers (5 seconds) */
	private static readonly UPGRADE_TIMEOUT_MS = 5000;

	/**
	 * Handles WebSocket upgrade requests.
	 * Validates via upgrade handler and creates connection data.
	 */
	private async handleWebSocketUpgrade(request: Request, server: BunServer): Promise<Response | undefined> {
		// Generate correlation ID for tracing this upgrade attempt
		const upgradeCorrelationId = crypto.randomUUID();
		this.appLogger.debug('WebSocket upgrade request received', {
			url: request.url,
			correlationId: upgradeCorrelationId
		});
		try {
			// Call upgrade handler to validate and get socket data
			let data: unknown;
			if (this._websocketUpgrade) {
				// Wrap upgrade handler with timeout to prevent hanging
				let timeoutId: ReturnType<typeof setTimeout>;
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeoutId = setTimeout(
						() => reject(new Error('WebSocket upgrade handler timeout')),
						OriApplication.UPGRADE_TIMEOUT_MS
					);
				});

				try {
					data = await Promise.race([this._websocketUpgrade(request), timeoutPromise]);
				} finally {
					// Always clear timeout to prevent unhandled rejection
					clearTimeout(timeoutId!);
				}
			} else {
				data = {};
			}

			// null means rejection
			if (data === null) {
				this.appLogger.debug('WebSocket upgrade rejected by handler', {
					correlationId: upgradeCorrelationId
				});
				return new Response('Unauthorized', { status: 401 });
			}

			const socketId = crypto.randomUUID();
			this.appLogger.debug('WebSocket upgrade successful', { socketId, correlationId: upgradeCorrelationId });
			const socketData = {
				socketId,
				data,
				topics: new Set<string>()
			};

			const success = server.upgrade(request, { data: socketData });

			if (!success) {
				return new Response('WebSocket upgrade failed', { status: 500 });
			}

			// Return undefined to indicate successful upgrade
			return undefined;
		} catch (error) {
			this.appLogger.error('WebSocket upgrade error', {
				error,
				url: request.url,
				upgradeHeader: request.headers.get('upgrade'),
				correlationId: upgradeCorrelationId
			});
			return new Response('Internal Server Error', { status: 500 });
		}
	}

	/**
	 * Builds WebSocket handler configuration for Bun.serve.
	 */
	private buildWebSocketHandlers() {
		const coordinator = this.websocketCoordinator;
		const socketRouting = this.socketRoutingCoordinator;
		const hasSocketRouters = socketRouting.hasRouters();
		const handlers = this._websocketHandlers;
		const logger = this.appLogger;

		/**
		 * Safely executes a user handler, catching any async errors.
		 * User handlers may be sync or async - this handles both cases.
		 */
		const safeCall = <T>(handlerName: string, handler: (() => T | Promise<T>) | undefined): void => {
			if (!handler) return;
			try {
				const result = handler();
				// If handler returns a promise, catch any rejections
				if (result && typeof (result as Promise<T>).catch === 'function') {
					(result as Promise<T>).catch((error) => {
						logger.error(`WebSocket ${handlerName} handler error`, { error });
					});
				}
			} catch (error) {
				// Sync error
				logger.error(`WebSocket ${handlerName} handler error`, { error });
			}
		};

		/**
		 * Wraps a WebSocket with a Proxy that intercepts subscribe/unsubscribe calls
		 * and routes them through the coordinator for proper Redis pub/sub support.
		 *
		 * This ensures that when user code calls ws.subscribe(topic), the provider
		 * also subscribes to the Redis channel, enabling cross-instance messaging.
		 */
		const wrapWebSocket = (ws: WebSocketConnection<unknown>): WebSocketConnection<unknown> => {
			if (!coordinator) {
				return ws; // No coordinator, return unwrapped
			}

			return new Proxy(ws, {
				get(target, prop) {
					if (prop === 'subscribe') {
						return (topic: string) => {
							// Route through coordinator which handles both:
							// 1. Bun's native ws.subscribe() for local pub/sub
							// 2. provider.subscribe() for Redis pub/sub
							coordinator.subscribeToTopic(target.data.socketId, topic);
						};
					}
					if (prop === 'unsubscribe') {
						return (topic: string) => {
							// Route through coordinator which handles both:
							// 1. Bun's native ws.unsubscribe() for local pub/sub
							// 2. provider.unsubscribe() for Redis pub/sub
							coordinator.unsubscribeFromTopic(target.data.socketId, topic);
						};
					}
					// IMPORTANT: Bind methods and getters to target (not proxy) so
					// ServerWebSocket's 'this' binding is correct. Methods like
					// ws.send() and getters like ws.data require 'this' to be
					// the actual ServerWebSocket, not the Proxy wrapper.
					const value = Reflect.get(target, prop, target);
					if (typeof value === 'function') {
						return value.bind(target);
					}
					return value;
				}
			});
		};

		return {
			open: (ws: WebSocketConnection<unknown>) => {
				// Add to coordinator for tracking
				coordinator?.addConnection(ws);
				// Subscribe to broadcast topic via coordinator (for Redis support)
				if (coordinator) {
					coordinator.subscribeToTopic(ws.data.socketId, '__broadcast__');
				} else {
					ws.subscribe('__broadcast__');
				}

				// Run socket controller connection guards if any controllers registered
				if (hasSocketRouters) {
					socketRouting
						.handleConnection(ws)
						.then((allowed) => {
							if (!allowed) {
								logger.debug('Socket controller connection guards rejected', {
									socketId: ws.data.socketId
								});
								ws.close(1008, 'Connection rejected by guard');
								return;
							}
							// Call user handler after guards pass
							const wrappedWs = wrapWebSocket(ws);
							safeCall('open', () => handlers?.open?.(wrappedWs));
						})
						.catch((error) => {
							logger.error('Socket controller connection handler error', { error });
							ws.close(1011, 'Connection handler error');
						});
				} else {
					// No socket controllers - just call user handler
					const wrappedWs = wrapWebSocket(ws);
					safeCall('open', () => handlers?.open?.(wrappedWs));
				}
			},
			message: (ws: WebSocketConnection<unknown>, message: string | Buffer) => {
				// Route through socket controllers first if any registered
				if (hasSocketRouters && typeof message === 'string') {
					try {
						const parsed = Json.parse(message);
						if (parsed && typeof parsed === 'object' && 'type' in parsed) {
							const { type, data, correlationId } = parsed as {
								type: string;
								data?: unknown;
								correlationId?: string;
							};

							// Try socket controller route
							socketRouting
								.handleMessage(ws, type, data, correlationId)
								.then((handled) => {
									if (!handled) {
										// No controller handled it - fall back to user handler
										const wrappedWs = wrapWebSocket(ws);
										safeCall('message', () => handlers?.message?.(wrappedWs, message));
									}
								})
								.catch((error) => {
									logger.error('Socket controller message handler error', { error });
									ws.send(JSON.stringify({ type, error: 'Internal error', correlationId }));
								});
							return;
						}
					} catch {
						// Not valid JSON or doesn't have type - fall through to user handler
					}
				}

				// No socket controllers or invalid message format - call user handler
				const wrappedWs = wrapWebSocket(ws);
				safeCall('message', () => handlers?.message?.(wrappedWs, message));
			},
			close: (ws: WebSocketConnection<unknown>, code: number, reason: string) => {
				// Clean up socket controller connection state
				if (hasSocketRouters) {
					socketRouting.handleDisconnection(ws.data.socketId);
				}
				// Call user handler (with wrapped ws for consistency)
				const wrappedWs = wrapWebSocket(ws);
				safeCall('close', () => handlers?.close?.(wrappedWs, code, reason));
				// Remove from coordinator (handles cleanup of all subscriptions)
				coordinator?.removeConnection(ws.data.socketId);
			},
			ping: (ws: WebSocketConnection<unknown>, data: Buffer) => {
				const wrappedWs = wrapWebSocket(ws);
				safeCall('ping', () => handlers?.ping?.(wrappedWs, data));
			},
			pong: (ws: WebSocketConnection<unknown>, data: Buffer) => {
				const wrappedWs = wrapWebSocket(ws);
				safeCall('pong', () => handlers?.pong?.(wrappedWs, data));
			},
			drain: (ws: WebSocketConnection<unknown>) => {
				const wrappedWs = wrapWebSocket(ws);
				safeCall('drain', () => handlers?.drain?.(wrappedWs));
			}
		};
	}

	/**
	 * Stops the server gracefully.
	 * Executes shutdown hooks in LIFO order before closing the server.
	 * Safe to call multiple times (no-op if already stopped).
	 * Times out after configured duration (default 10s) to prevent hanging.
	 * @returns Promise resolving when shutdown is complete
	 */
	public async stop(): Promise<void> {
		// Guard against multiple calls (check server AND lifecycle state)
		if (this.lifecycleManager.isInShutdown() || !this.server) {
			return;
		}

		await this.lifecycleManager.executeGracefulShutdown(async () => {
			// Execute shutdown hooks (LIFO, continue on error)
			await this._context.executeShutdownHooks();

			// Stop event system
			await this.eventCoordinator.stop();

			// Stop workflow provider
			await this.workflowCoordinator.stop();

			// Drain WebSocket connections gracefully
			if (this.websocketCoordinator) {
				const connections = this.websocketCoordinator.getAllConnections();
				for (const ws of connections) {
					try {
						// Send close frame with reason (1001 = Going Away)
						ws.close(1001, 'Server shutting down');
					} catch {
						// Connection may already be closed, ignore
					}
				}
				// Brief delay to allow close frames to be sent
				if (connections.length > 0) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			}

			// Stop WebSocket provider
			if (this.websocketProvider) {
				await this.websocketProvider.stop();
			}
		});

		// Stop the server
		this.server.stop();
		this.server = null;
	}

	/**
	 * Sets the graceful shutdown timeout in milliseconds.
	 * If shutdown hooks take longer than this, the server will force stop.
	 * Default: 10000ms (10 seconds)
	 * @param timeoutMs - Timeout in milliseconds
	 */
	public setShutdownTimeout(timeoutMs: number): this {
		this.lifecycleManager.setShutdownTimeout(timeoutMs);
		return this;
	}

	/**
	 * Disables signal handling (useful for tests).
	 * Must be called before listen().
	 */
	public disableSignalHandling(): this {
		this.lifecycleManager.disableSignalHandling();
		return this;
	}

	/** Returns all registered routes (useful for debugging). */
	public getRoutes(): CompiledRoute[] {
		return this.routingCoordinator.getCompiledRoutes();
	}

	/** Returns the DI container (useful for testing). */
	public getContainer(): Container {
		return this.container;
	}

	private bootstrap(): void {
		// Set phase (AppContext created in constructor)
		this._context.setPhase('bootstrapped');

		// Set config provider if configured
		if (this.pendingConfig) {
			this._context.setConfig(this.pendingConfig);
		}

		// Set coordinators on AppContext for request-bound emitters (ctx.events, ctx.workflows)
		this._context.setEventCoordinator(this.eventCoordinator);
		this._context.setWorkflowCoordinator(this.workflowCoordinator);

		// Set socket emitter getter if WebSocket is configured
		if (this.websocketProvider) {
			this._context.setSocketEmitterGetter(() => this.getSocketEmitter());
		}

		// Register AppContext as a provider so services can inject it
		// Use the AppContext type as the key (Constructor) for type-safe injection
		this.container.registerInstance(AppContext, this._context);

		this.providerCoordinator.registerProviders();

		// Validate container BEFORE any instantiation or further work
		// This catches missing dependencies, circular deps, and external package issues early
		this.container.validate();

		this.providerCoordinator.instantiateEagerProviders();
		this.routingCoordinator.registerGlobalMiddleware();
		this.routingCoordinator.registerControllers();
		this.socketRoutingCoordinator.registerRouters();
		this.eventCoordinator.registerConsumers();
		this.workflowCoordinator.registerConsumers();

		// Set workflow executor on AppContext AFTER registerConsumers() creates the provider
		// Use createExecutor() to get a definition-aware executor that handles both
		// WorkflowDefinition (new API) and WorkflowClass (old API)
		if (this.workflowCoordinator.isConfigured()) {
			this._context.setWorkflows(this.workflowCoordinator.createExecutor());
		}
	}

	/**
	 * Application context - always available.
	 * Use for registering lifecycle hooks and accessing app-level services.
	 */
	get context(): AppContext<TSocket> {
		return this._context;
	}

	/**
	 * Handles requests that don't match any registered route.
	 * This is the fallback for Bun's fetch handler.
	 */
	private handleUnmatchedRequest(_request: Request): Response {
		return this.responseFactory.notFound();
	}

	/** Starts all background systems (startup hooks, events, workflows) */
	private async startSystems(): Promise<void> {
		await this._context.executeStartupHooks();
		await this.eventCoordinator.start();
		await this.workflowCoordinator.start();

		// Start WebSocket provider if configured
		if (this.websocketProvider) {
			await this.websocketProvider.start();
		}
	}

	/** Finalizes startup (ready hooks, signal handlers, callback) */
	private async finalizeStartup(callback?: () => void): Promise<void> {
		await this._context.executeReadyHooks();
		this.lifecycleManager.registerSignalHandlers(async () => {
			await this.stop();
		});
		callback?.();
	}

	private logHeader(): void {
		this.appLogger.info('Starting Application');
	}

	private logSummary(startTime: number): void {
		const duration = Math.round(performance.now() - startTime);
		const routeCount = this.routingCoordinator.getCompiledRoutes().length;
		const providerCount = this.container.getRegisteredCount();

		this.appLogger.info(
			`Application Ready: ${providerCount} providers, ${routeCount} routes (${duration}ms)`
		);
	}
}

/**
 * Factory for creating OriJS applications.
 *
 * @example
 * ```ts
 * // Simple usage
 * const app = Ori.create();
 * app.listen(3000);
 *
 * // With custom dependencies (for testing)
 * const app = Ori.create({
 *   container: customContainer,
 * });
 * ```
 */
export const Ori = {
	/** Creates a new OriApplication instance with optional custom dependencies. */
	create(options?: ApplicationOptions): OriApplication {
		return new OriApplication(options);
	}
};

// Backwards compatibility alias
export { OriApplication as Application };
