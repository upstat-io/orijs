import type {
	Constructor,
	ConstructorDeps,
	GuardClass,
	InterceptorClass,
	HttpMethod,
	RouteDefinition,
	OriController
} from './types/index';
import type { ControllerConfig } from './types/application';
import type { LoggerOptions, Logger } from '@orijs/logging';
import type { Container } from './container';
import type { AppContext } from './app-context';
import {
	RouteBuilder,
	RequestPipeline,
	type ResponseFactory,
	type CompiledRoute,
	type BunRouteHandler
} from './controllers/index';

/** Method handlers for a single path (Bun-specific) */
type MethodHandlers = {
	[K in HttpMethod]?: BunRouteHandler;
};

/** Bun.serve() routes object type (Bun-specific) */
type BunRoutes = Record<string, BunRouteHandler | MethodHandlers | Response>;

/**
 * Coordinates HTTP routing concerns.
 * Handles controller registration, route compilation, and Bun route generation.
 */
export class RoutingCoordinator {
	private globalGuards: GuardClass[] = [];
	private globalInterceptors: InterceptorClass[] = [];
	private controllers: ControllerConfig[] = [];
	private compiledRoutes: CompiledRoute[] = [];

	constructor(
		private readonly container: Container,
		private readonly responseFactory: ResponseFactory,
		private readonly logger: Logger
	) {}

	/**
	 * Updates the pipeline with a new logger (called when logger is reconfigured).
	 */
	public updatePipeline(logger: Logger): RequestPipeline {
		return new RequestPipeline(this.container, this.responseFactory, logger);
	}

	/**
	 * Adds a global guard that applies to all routes.
	 */
	public addGuard(guard: GuardClass): void {
		this.globalGuards.push(guard);
	}

	/**
	 * Adds a global interceptor that applies to all routes.
	 */
	public addInterceptor(interceptor: InterceptorClass): void {
		this.globalInterceptors.push(interceptor);
	}

	/**
	 * Registers a controller configuration for later compilation.
	 */
	public addController(config: ControllerConfig): void {
		this.controllers.push(config);
	}

	/**
	 * Returns global guards (for logging purposes).
	 */
	public getGlobalGuards(): readonly GuardClass[] {
		return this.globalGuards;
	}

	/**
	 * Returns global interceptors (for logging purposes).
	 */
	public getGlobalInterceptors(): readonly InterceptorClass[] {
		return this.globalInterceptors;
	}

	/**
	 * Registers global middleware (guards and interceptors) with the container.
	 */
	public registerGlobalMiddleware(): void {
		for (const guard of this.globalGuards) {
			this.registerIfMissing(guard);
			this.logger.debug(`Global Guard Registered: ${guard.name}`);
		}
		for (const interceptor of this.globalInterceptors) {
			this.registerIfMissing(interceptor);
			this.logger.debug(`Global Interceptor Registered: ${interceptor.name}`);
		}
	}

	/**
	 * Registers all controllers with the container and compiles their routes.
	 */
	public registerControllers(): void {
		for (const { path: controllerPath, controller, deps } of this.controllers) {
			// Type assertion safe: deps validated at API boundary via ConstructorDeps<T>
			this.container.register(controller, deps as ConstructorDeps<typeof controller>);
			const instance = this.container.resolve<OriController>(controller);

			const builder = new RouteBuilder([...this.globalGuards], [...this.globalInterceptors]);

			instance.configure(builder);
			const routes = builder.getRoutes();

			this.registerRouteMiddleware(routes);

			// Compile routes with full paths
			for (const route of routes) {
				// Root route '/' means "use controller path as-is"
				const routePath = route.path === '/' ? '' : route.path;
				const fullPath = this.normalizePath(controllerPath + routePath);
				this.compiledRoutes.push({
					...route,
					fullPath
				});
			}

			const routePaths = routes.map((r) => `${r.method} ${controllerPath}${r.path === '/' ? '' : r.path}`);
			this.logger.debug(
				`Controller Registered: ${controller.name} (${controllerPath}) -> [${routePaths.join(', ')}]`
			);
		}
	}

	/**
	 * Generates the Bun native routes object from compiled routes.
	 * Groups routes by path and creates per-method handlers.
	 * Static routes (Response passed directly) use Bun's zero-allocation dispatch.
	 *
	 * @param corsHeaders - Optional pre-computed CORS headers to inject into all responses
	 */
	public generateBunRoutes(
		appContext: AppContext,
		sharedLoggerOptions: LoggerOptions,
		pipeline: RequestPipeline,
		corsHeaders?: Record<string, string> | null
	): BunRoutes {
		const routes: BunRoutes = {};

		// Pre-create OPTIONS preflight response if CORS is configured (reused for all paths)
		const optionsHandler = corsHeaders
			? () => new Response(null, { status: 204, headers: corsHeaders })
			: null;

		// Group routes by path
		const routesByPath = new Map<string, CompiledRoute[]>();
		for (const route of this.compiledRoutes) {
			const existing = routesByPath.get(route.fullPath) || [];
			existing.push(route);
			routesByPath.set(route.fullPath, existing);
		}

		// Generate Bun route handlers
		for (const [path, pathRoutes] of routesByPath) {
			const bunPath = path;

			if (pathRoutes.length === 1) {
				const route = pathRoutes[0]!;

				// Static route: Response passed directly - use Bun's zero-allocation dispatch
				if (route.handler instanceof Response) {
					routes[bunPath] = corsHeaders
						? this.addCorsToStaticResponse(route.handler, corsHeaders)
						: route.handler;
					this.logger.debug('Static Route Registered', { path: bunPath });
					continue;
				}

				// Single method - use method handlers object with OPTIONS for CORS preflight
				const methodHandlers: MethodHandlers = {};
				methodHandlers[route.method] = pipeline.createHandler(
					route,
					appContext,
					sharedLoggerOptions,
					corsHeaders
				);
				if (optionsHandler) {
					methodHandlers['OPTIONS'] = optionsHandler;
				}
				routes[bunPath] = methodHandlers;
			} else {
				// Multiple methods - use method object
				const methodHandlers: MethodHandlers = {};
				for (const route of pathRoutes) {
					// Static Response on multi-method path - pass directly
					if (route.handler instanceof Response) {
						// Can't use static Response with method handlers, log warning
						this.logger.warn('Static Response on multi-method path not supported', { path: bunPath });
					}
					methodHandlers[route.method] = pipeline.createHandler(
						route,
						appContext,
						sharedLoggerOptions,
						corsHeaders
					);
				}
				// Add OPTIONS handler for CORS preflight
				if (optionsHandler) {
					methodHandlers['OPTIONS'] = optionsHandler;
				}
				routes[bunPath] = methodHandlers;
			}
		}

		return routes;
	}

	/**
	 * Adds CORS headers to a static Response.
	 */
	private addCorsToStaticResponse(response: Response, corsHeaders: Record<string, string>): Response {
		const newHeaders = new Headers(response.headers);
		for (const [key, value] of Object.entries(corsHeaders)) {
			newHeaders.set(key, value);
		}
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: newHeaders
		});
	}

	/**
	 * Returns all compiled routes (useful for debugging).
	 */
	public getCompiledRoutes(): CompiledRoute[] {
		return this.compiledRoutes;
	}

	/**
	 * Returns the response factory for handling unmatched requests.
	 */
	public getResponseFactory(): ResponseFactory {
		return this.responseFactory;
	}

	/** Maximum allowed path length to prevent DoS via extremely long paths */
	private static readonly MAX_PATH_LENGTH = 2048;

	/**
	 * Validates and normalizes a route path.
	 * Security: Blocks path traversal, null bytes, and DoS via long paths.
	 * Performance: O(1) length check, O(n) traversal check with early exit.
	 */
	private normalizePath(input: string): string {
		// O(1) length check - prevents DoS via extremely long paths
		if (input.length > RoutingCoordinator.MAX_PATH_LENGTH) {
			throw new Error(
				`Route path too long (${input.length} chars, max ${RoutingCoordinator.MAX_PATH_LENGTH})`
			);
		}

		// O(n) with early exit - block path traversal attacks
		// indexOf is highly optimized in JS engines
		if (input.indexOf('..') !== -1) {
			throw new Error(`Path traversal not allowed in route: ${input}`);
		}

		// O(n) with early exit - block null bytes (can cause truncation vulnerabilities)
		if (input.indexOf('\0') !== -1) {
			throw new Error('Null bytes not allowed in route path');
		}

		// Normalize the path
		let path = input;
		if (!path.startsWith('/')) {
			path = '/' + path;
		}
		if (path !== '/' && path.endsWith('/')) {
			path = path.slice(0, -1);
		}
		return path.replace(/\/+/g, '/');
	}

	private registerRouteMiddleware(routes: readonly RouteDefinition[]): void {
		for (const route of routes) {
			for (const guard of route.guards) {
				this.registerIfMissing(guard);
			}
			for (const interceptor of route.interceptors) {
				this.registerIfMissing(interceptor);
			}
		}
	}

	private registerIfMissing(service: Constructor): void {
		if (!this.container.has(service)) {
			// Middleware (guards, interceptors) have no constructor deps
			this.container.register(service as new () => unknown);
		}
	}
}
