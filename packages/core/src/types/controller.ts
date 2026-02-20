import type { RequestContext } from '../controllers/request-context.ts';
import type { HandlerInput } from './context';
import type { SocketEmitter } from './emitter';
import type { HttpMethod } from './http';
import type { GuardClass, InterceptorClass, PipeClass } from './middleware';
import type { Schema } from '@orijs/validation';
import type { ParamValidatorClass } from '../controllers/param-validators';
import type { RouteKey } from '../route-key.ts';

/**
 * Schema options for route validation.
 * Each field accepts a TypeBox schema or custom validator function.
 */
export interface RouteSchemaOptions {
	/** Schema for URL path parameters */
	params?: Schema;
	/** Schema for query string parameters */
	query?: Schema;
	/** Schema for request body */
	body?: Schema;
}

/**
 * Controller interface that all controllers must implement.
 * Controllers define routes via the configure method.
 *
 * @typeParam TState - The state variables type for this controller's context.
 *   Guards set state via `ctx.set()`, handlers access via `ctx.state`.
 *
 * @example
 * ```ts
 * interface AuthState {
 *   user: UserWithAccountAndRoles;
 * }
 *
 * class UserController implements OriController<AuthState> {
 *   configure(r: RouteBuilder<AuthState>) {
 *     r.guard(AuthGuard);
 *     r.get('/me', this.getMe);
 *   }
 *
 *   private getMe = async (ctx: Context<AuthState>) => {
 *     return Response.json(ctx.state.user);  // Fully typed!
 *   };
 * }
 * ```
 */
export interface OriController<
	TState extends object = Record<string, unknown>,
	TParams extends Record<string, string> = Record<string, string>
> {
	/**
	 * Configures routes for this controller using the RouteBuilder.
	 * @param route - The route builder instance
	 */
	configure(route: RouteBuilder<TState, TParams>): void;
}

/** Constructor type for Controller classes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ControllerClass = new (...args: any[]) => OriController<any, any>;

/** Internal route definition after building */
export interface RouteDefinition {
	method: HttpMethod;
	path: string;
	handler: HandlerInput;
	guards: GuardClass[];
	interceptors: InterceptorClass[];
	pipes: Array<{ pipe: PipeClass; schema?: Schema }>;
	schema?: RouteSchemaOptions;
	paramValidators?: Map<string, ParamValidatorClass>;
	data?: Map<symbol, unknown>;
}

/**
 * Handler function type for a specific context.
 * @typeParam TState - The state variables type for the context
 */
export type ContextHandler<
	TState extends object = Record<string, unknown>,
	TParams extends Record<string, string> = Record<string, string>
> = (ctx: RequestContext<TState, SocketEmitter, TParams>) => Response | Promise<Response>;

/**
 * Handler input - either a function or a static Response.
 * @typeParam TState - The state variables type for the context
 * @typeParam TParams - The path parameters type
 */
export type ContextHandlerInput<
	TState extends object = Record<string, unknown>,
	TParams extends Record<string, string> = Record<string, string>
> = ContextHandler<TState, TParams> | Response;

/**
 * Fluent API for defining routes within a controller.
 *
 * @typeParam TState - The state variables type for this builder's handlers.
 *   Declared at the controller level for type-safe `ctx.state` access.
 *
 * @example
 * ```ts
 * import { UuidParam } from '@orijs/orijs';
 *
 * interface AuthState { user: User }
 *
 * class UserController implements OriController<AuthState> {
 *   configure(r: RouteBuilder<AuthState>) {
 *     r.guard(AuthGuard);
 *     r.param('uuid', UuidParam);
 *
 *     r.get('/me', this.getMe);
 *     r.get('/:uuid', this.getById);
 *   }
 *
 *   private getMe = async (ctx: Context<AuthState>) => {
 *     return Response.json(ctx.state.user);  // Fully typed!
 *   };
 * }
 * ```
 */
export interface RouteBuilder<
	TState extends object = Record<string, unknown>,
	TParams extends Record<string, string> = Record<string, string>
> {
	/**
	 * Declares a path parameter validator at the controller level.
	 * Applies automatically to all routes that contain `:name` in their path.
	 *
	 * Built-in validators: UuidParam, StringParam, NumberParam.
	 * Provide your own by implementing the ParamValidator interface.
	 *
	 * Each call accumulates the parameter name into the TParams type,
	 * enabling type-safe `ctx.params` access in handlers.
	 *
	 * @param name - Parameter name (matches `:name` in route paths)
	 * @param validator - ParamValidator class to validate the parameter
	 */
	param<TName extends string>(
		name: TName,
		validator: ParamValidatorClass
	): RouteBuilder<TState, TParams & Record<TName, string>>;

	/**
	 * Attaches typed metadata to the current route or controller.
	 *
	 * When called before any route method, applies to all routes in the controller.
	 * When called after a route method, applies only to that route (overriding controller-level).
	 *
	 * Guards and handlers read the value via ctx.get(key).
	 *
	 * @param key - A RouteKey created with createRouteKey()
	 * @param value - The typed value to attach
	 */
	set<T>(key: RouteKey<T>, value: T): RouteBuilder<TState, TParams>;

	/**
	 * Adds a guard to the current route or controller.
	 * @param guard - The guard class to add
	 */
	guard(guard: GuardClass): RouteBuilder<TState, TParams>;

	/**
	 * Replaces all guards for the current route or controller.
	 * @param guards - The guard classes to use
	 */
	guards(guards: GuardClass[]): RouteBuilder<TState, TParams>;

	/** Removes all inherited and controller-level guards */
	clearGuards(): RouteBuilder<TState, TParams>;

	/**
	 * Replaces global (inherited) guards with a new set at the controller level.
	 * Requires a reason that is logged at info level for audit trail.
	 *
	 * @param guards - Guard classes to use instead of global guards (empty array = unprotected)
	 * @param options - Options with required reason string
	 */
	replaceGlobalGuardsWith(guards: GuardClass[], options: { reason: string }): RouteBuilder<TState, TParams>;

	/**
	 * Adds an interceptor to the current route or controller.
	 * @param interceptor - The interceptor class to add
	 */
	intercept(interceptor: InterceptorClass): RouteBuilder<TState, TParams>;

	/**
	 * Replaces all interceptors for the current route or controller.
	 * @param interceptors - The interceptor classes to use
	 */
	interceptors(interceptors: InterceptorClass[]): RouteBuilder<TState, TParams>;

	/** Removes all inherited and controller-level interceptors */
	clearInterceptors(): RouteBuilder<TState, TParams>;

	/**
	 * Adds a validation pipe to the current route or controller.
	 * @param pipe - The pipe class to use
	 * @param schema - Optional validation schema
	 */
	pipe(pipe: PipeClass, schema?: Schema): RouteBuilder<TState, TParams>;

	/** Removes all guards and interceptors */
	clear(): RouteBuilder<TState, TParams>;

	/**
	 * Registers a GET route.
	 * Pass Response directly for zero-allocation static routes.
	 */
	get(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): RouteBuilder<TState, TParams>;

	/** Registers a POST route. */
	post(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): RouteBuilder<TState, TParams>;

	/** Registers a PUT route. */
	put(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): RouteBuilder<TState, TParams>;

	/** Registers a PATCH route. */
	patch(
		path: string,
		handler: ContextHandlerInput<TState, TParams>,
		schema?: RouteSchemaOptions
	): RouteBuilder<TState, TParams>;

	/** Registers a DELETE route. */
	delete(
		path: string,
		handler: ContextHandlerInput<TState, TParams>,
		schema?: RouteSchemaOptions
	): RouteBuilder<TState, TParams>;

	/** Registers a HEAD route. */
	head(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): RouteBuilder<TState, TParams>;

	/** Registers an OPTIONS route. */
	options(
		path: string,
		handler: ContextHandlerInput<TState, TParams>,
		schema?: RouteSchemaOptions
	): RouteBuilder<TState, TParams>;

	/** Returns all registered routes (internal use) */
	getRoutes(): readonly RouteDefinition[];
}
