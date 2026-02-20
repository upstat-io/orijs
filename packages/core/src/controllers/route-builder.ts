import type {
	RouteBuilder as IRouteBuilder,
	RouteDefinition,
	RouteSchemaOptions,
	HttpMethod,
	HandlerInput,
	ContextHandlerInput,
	GuardClass,
	InterceptorClass,
	PipeClass
} from '../types/index.ts';
import { Logger } from '@orijs/logging';
import type { Schema } from '@orijs/validation';
import type { ParamValidatorClass } from './param-validators';
import type { RouteKey } from '../route-key.ts';

/**
 * Fluent API for defining routes within a controller.
 *
 * Supports guards, interceptors, and pipes at both controller level
 * (before any route) and individual route level (after a route method).
 *
 * @typeParam TState - The state variables type for this builder's handlers.
 *   Declared at the controller level for type-safe `ctx.state` access.
 *
 * @example
 * ```ts
 * interface AuthState { user: User }
 *
 * class UserController implements OriController<AuthState> {
 *   configure(r: RouteBuilder<AuthState>) {
 *     r.guard(AuthGuard);
 *
 *     r.get('/me', this.getMe);
 *     r.post('/update', this.update);
 *   }
 *
 *   private getMe = async (ctx: Context<AuthState>) => {
 *     return Response.json(ctx.state.user);  // Fully typed!
 *   };
 * }
 * ```
 */
export class RouteBuilder<
	TState extends object = Record<string, unknown>,
	TParams extends Record<string, string> = Record<string, string>
> implements IRouteBuilder<TState, TParams> {
	private routes: RouteDefinition[] = [];
	private controllerGuards: GuardClass[] = [];
	private controllerInterceptors: InterceptorClass[] = [];
	private controllerPipes: Array<{ pipe: PipeClass; schema?: Schema }> = [];
	private controllerParams: Map<string, ParamValidatorClass> = new Map();
	private currentRoute: RouteDefinition | null = null;
	private routeGuardsOverride: GuardClass[] | null = null;
	private routeInterceptorsOverride: InterceptorClass[] | null = null;
	private controllerData: Map<symbol, unknown> | null = null;
	private routeDataOverride: Map<symbol, unknown> | null = null;

	/**
	 * Creates a new RouteBuilder.
	 * @param inheritedGuards - Guards inherited from global application level
	 * @param inheritedInterceptors - Interceptors inherited from global application level
	 */
	constructor(
		private inheritedGuards: GuardClass[] = [],
		private inheritedInterceptors: InterceptorClass[] = []
	) {}

	/**
	 * Adds a guard to the controller or current route.
	 *
	 * When called before any route method, applies to all routes in the controller.
	 * When called after a route method, applies only to that route.
	 *
	 * @param guard - Guard class to add (must implement OriGuard interface)
	 * @returns this for method chaining
	 *
	 * @example
	 * ```ts
	 * // Controller-level guard (applies to all routes)
	 * r.guard(AuthGuard);
	 * r.get('/users', this.list);
	 *
	 * // Route-level guard (applies only to this route)
	 * r.post('/admin', this.adminAction);
	 * r.guard(AdminGuard);
	 * ```
	 */
	public guard(guard: GuardClass): this {
		if (this.currentRoute) {
			if (!this.routeGuardsOverride) {
				this.routeGuardsOverride = [...this.getEffectiveGuards()];
			}
			this.routeGuardsOverride.push(guard);
			this.currentRoute.guards = this.routeGuardsOverride;
		} else {
			this.controllerGuards.push(guard);
		}
		return this;
	}

	/**
	 * Replaces all guards with the provided array.
	 *
	 * When called at controller level, clears inherited guards and sets new ones.
	 * When called after a route, sets exact guards for that route only.
	 *
	 * @param guards - Array of guard classes to use
	 * @returns this for method chaining
	 */
	public guards(guards: GuardClass[]): this {
		if (this.currentRoute) {
			this.routeGuardsOverride = guards;
			this.currentRoute.guards = guards;
		} else {
			this.controllerGuards = guards;
			this.inheritedGuards = [];
		}
		return this;
	}

	/**
	 * Clears all guards (inherited and controller-level).
	 *
	 * Useful when a specific route or controller should bypass all guards.
	 *
	 * @returns this for method chaining
	 */
	public clearGuards(): this {
		if (this.currentRoute) {
			this.routeGuardsOverride = [];
			this.currentRoute.guards = [];
		} else {
			this.controllerGuards = [];
			this.inheritedGuards = [];
		}
		return this;
	}

	/**
	 * Replaces global (inherited) guards with a new set at the controller level.
	 * Requires a reason that is logged at info level for audit trail.
	 * Only valid at controller level (before any route method).
	 *
	 * @param guards - Guard classes to use instead of global guards (empty array = unprotected)
	 * @param options - Options with required reason string
	 * @returns this for method chaining
	 *
	 * @example
	 * ```ts
	 * // Public endpoint — no guards
	 * r.replaceGlobalGuardsWith([], { reason: 'Health check — must be public' });
	 *
	 * // Different guard
	 * r.replaceGlobalGuardsWith([InternalAuthGuard], { reason: 'Service-to-service only' });
	 * ```
	 */
	public replaceGlobalGuardsWith(guards: GuardClass[], options: { reason: string }): this {
		const logger = new Logger('RouteBuilder');
		logger.info('Global guards replaced', {
			reason: options.reason,
			removed: this.inheritedGuards.map((g) => g.name),
			replacedWith: guards.map((g) => g.name)
		});
		this.inheritedGuards = [];
		this.controllerGuards = guards;
		return this;
	}

	/**
	 * Adds an interceptor to the controller or current route.
	 *
	 * Interceptors wrap handler execution for cross-cutting concerns
	 * like logging, timing, or response transformation.
	 *
	 * @param interceptor - Interceptor class to add
	 * @returns this for method chaining
	 */
	public intercept(interceptor: InterceptorClass): this {
		if (this.currentRoute) {
			if (!this.routeInterceptorsOverride) {
				this.routeInterceptorsOverride = [...this.getEffectiveInterceptors()];
			}
			this.routeInterceptorsOverride.push(interceptor);
			this.currentRoute.interceptors = this.routeInterceptorsOverride;
		} else {
			this.controllerInterceptors.push(interceptor);
		}
		return this;
	}

	/**
	 * Replaces all interceptors with the provided array.
	 *
	 * @param interceptors - Array of interceptor classes to use
	 * @returns this for method chaining
	 */
	public interceptors(interceptors: InterceptorClass[]): this {
		if (this.currentRoute) {
			this.routeInterceptorsOverride = interceptors;
			this.currentRoute.interceptors = interceptors;
		} else {
			this.controllerInterceptors = interceptors;
			this.inheritedInterceptors = [];
		}
		return this;
	}

	/**
	 * Clears all interceptors (inherited and controller-level).
	 *
	 * @returns this for method chaining
	 */
	public clearInterceptors(): this {
		if (this.currentRoute) {
			this.routeInterceptorsOverride = [];
			this.currentRoute.interceptors = [];
		} else {
			this.controllerInterceptors = [];
			this.inheritedInterceptors = [];
		}
		return this;
	}

	/**
	 * Adds a pipe for request transformation/validation.
	 *
	 * Pipes process the request before it reaches the handler,
	 * typically for validation or data transformation.
	 *
	 * @param pipe - Pipe class to add
	 * @param schema - Optional validation schema for the pipe
	 * @returns this for method chaining
	 *
	 * @example
	 * ```ts
	 * r.post('/users', this.create);
	 * r.pipe(ValidationPipe, CreateUserSchema);
	 * ```
	 */
	public pipe(pipe: PipeClass, schema?: Schema): this {
		if (this.currentRoute) {
			this.currentRoute.pipes.push({ pipe, schema });
		} else {
			this.controllerPipes.push({ pipe, schema });
		}
		return this;
	}

	/**
	 * Declares a path parameter validator at the controller level.
	 * Automatically applies to all routes that contain `:name` in their path.
	 *
	 * Built-in validators: UuidParam, StringParam, NumberParam.
	 * Provide your own by implementing the ParamValidator interface.
	 *
	 * @param name - Parameter name (matches `:name` in route paths)
	 * @param validator - ParamValidator class to validate the parameter
	 * @returns this for method chaining
	 *
	 * @example
	 * ```ts
	 * r.param('uuid', UuidParam);
	 * r.get('/:uuid', this.getOne);        // uuid validated
	 * r.delete('/:uuid', this.remove);      // uuid validated
	 * r.get('/', this.list);                // no param validation
	 * ```
	 */
	public param<TName extends string>(
		name: TName,
		validator: ParamValidatorClass
	): RouteBuilder<TState, TParams & Record<TName, string>> {
		this.controllerParams.set(name, validator);
		return this as unknown as RouteBuilder<TState, TParams & Record<TName, string>>;
	}

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
	 * @returns this for method chaining
	 */
	public set<T>(key: RouteKey<T>, value: T): this {
		if (this.currentRoute) {
			if (!this.routeDataOverride) {
				this.routeDataOverride = this.controllerData
					? new Map(this.controllerData)
					: new Map();
			}
			this.routeDataOverride.set(key, value);
			this.currentRoute.data = this.routeDataOverride;
		} else {
			if (!this.controllerData) {
				this.controllerData = new Map();
			}
			this.controllerData.set(key, value);
		}
		return this;
	}

	/**
	 * Clears all guards and interceptors.
	 *
	 * Convenience method equivalent to calling clearGuards() and clearInterceptors().
	 *
	 * @returns this for method chaining
	 */
	public clear(): this {
		this.clearGuards();
		this.clearInterceptors();
		return this;
	}

	/**
	 * Registers a GET route.
	 *
	 * @param path - Route path (e.g., '/users', '/users/:id')
	 * @param handler - Handler function or method reference
	 * @param schema - Optional schema for params/query/response validation
	 * @returns this for method chaining
	 */
	public get(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): this {
		return this.addRoute('GET', path, handler as HandlerInput, schema);
	}

	/**
	 * Registers a POST route.
	 *
	 * @param path - Route path
	 * @param handler - Handler function or method reference
	 * @param schema - Optional schema for body/params/response validation
	 * @returns this for method chaining
	 */
	public post(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): this {
		return this.addRoute('POST', path, handler as HandlerInput, schema);
	}

	/**
	 * Registers a PUT route.
	 *
	 * @param path - Route path
	 * @param handler - Handler function or method reference
	 * @param schema - Optional schema for body/params/response validation
	 * @returns this for method chaining
	 */
	public put(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): this {
		return this.addRoute('PUT', path, handler as HandlerInput, schema);
	}

	/**
	 * Registers a PATCH route.
	 *
	 * @param path - Route path
	 * @param handler - Handler function or method reference
	 * @param schema - Optional schema for body/params/response validation
	 * @returns this for method chaining
	 */
	public patch(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): this {
		return this.addRoute('PATCH', path, handler as HandlerInput, schema);
	}

	/**
	 * Registers a DELETE route.
	 *
	 * @param path - Route path
	 * @param handler - Handler function or method reference
	 * @param schema - Optional schema for params validation
	 * @returns this for method chaining
	 */
	public delete(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): this {
		return this.addRoute('DELETE', path, handler as HandlerInput, schema);
	}

	/**
	 * Registers a HEAD route.
	 *
	 * @param path - Route path
	 * @param handler - Handler function or method reference
	 * @param schema - Optional schema validation
	 * @returns this for method chaining
	 */
	public head(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): this {
		return this.addRoute('HEAD', path, handler as HandlerInput, schema);
	}

	/**
	 * Registers an OPTIONS route.
	 *
	 * @param path - Route path
	 * @param handler - Handler function or method reference
	 * @param schema - Optional schema validation
	 * @returns this for method chaining
	 */
	public options(path: string, handler: ContextHandlerInput<TState, TParams>, schema?: RouteSchemaOptions): this {
		return this.addRoute('OPTIONS', path, handler as HandlerInput, schema);
	}

	/**
	 * Returns all registered routes.
	 *
	 * Finalizes any pending route configuration and returns an immutable
	 * array of route definitions.
	 *
	 * @returns Frozen array of route definitions
	 */
	public getRoutes(): readonly RouteDefinition[] {
		this.currentRoute = null;
		return Object.freeze([...this.routes]);
	}

	private addRoute(
		method: HttpMethod,
		path: string,
		handler: HandlerInput,
		schema?: RouteSchemaOptions
	): this {
		const paramValidators = this.buildParamValidators(path);
		this.currentRoute = {
			method,
			path,
			handler,
			guards: this.getEffectiveGuards(),
			interceptors: this.getEffectiveInterceptors(),
			pipes: [...this.controllerPipes],
			schema,
			paramValidators,
			data: this.controllerData ? new Map(this.controllerData) : undefined
		};
		this.routeGuardsOverride = null;
		this.routeInterceptorsOverride = null;
		this.routeDataOverride = null;
		this.routes.push(this.currentRoute);
		return this;
	}

	/**
	 * Builds a param validators map for a route, only including
	 * params that appear in the route path as `:name` segments.
	 */
	private buildParamValidators(path: string): Map<string, ParamValidatorClass> | undefined {
		if (this.controllerParams.size === 0) return undefined;

		const validators = new Map<string, ParamValidatorClass>();
		for (const [name, validator] of this.controllerParams) {
			if (path.includes(`:${name}`)) {
				validators.set(name, validator);
			}
		}

		return validators.size > 0 ? validators : undefined;
	}

	private getEffectiveGuards(): GuardClass[] {
		return [...this.inheritedGuards, ...this.controllerGuards];
	}

	private getEffectiveInterceptors(): InterceptorClass[] {
		return [...this.inheritedInterceptors, ...this.controllerInterceptors];
	}
}
