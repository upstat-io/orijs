import type { AppContext } from '../app-context.ts';
import type { BaseContext } from '../base-context.ts';
import { Logger, setMeta as setContextMeta, type LoggerOptions } from '@orijs/logging';
import { Json } from '@orijs/validation';
import { parseQueryString } from '../utils/query.ts';
import type { EventEmitter, WorkflowExecutor, SocketEmitter } from '../types/emitter.ts';
import {
	RequestBoundEventEmitter,
	RequestBoundWorkflowExecutor,
	RequestBoundSocketEmitter
} from './request-bound-emitters';

/** Maximum allowed param length to prevent DoS via extremely long params */
const MAX_PARAM_LENGTH = 256;

/** UUID format: 8-4-4-4-12 hex characters with dashes (36 chars total) */
const UUID_LENGTH = 36;

// Pre-allocated empty objects to avoid per-request allocations
const EMPTY_QUERY: Record<string, string | string[]> = Object.freeze({}) as Record<string, string | string[]>;

/**
 * Factory for creating request contexts.
 * Encapsulates shared configuration (app context, logger options) and URL parsing logic.
 */
export class RequestContextFactory {
	constructor(
		private readonly app: AppContext,
		private readonly loggerOptions: LoggerOptions
	) {}

	/**
	 * Create a new request context for the given request.
	 */
	public create(request: Request, params: Record<string, string>): RequestContext {
		const requestUrl = request.url;
		const queryStart = requestUrl.indexOf('?');
		return new RequestContext(this.app, request, params, requestUrl, queryStart, this.loggerOptions);
	}
}

/**
 * Request-scoped context passed to handlers, guards, and interceptors.
 * Created for each HTTP request.
 *
 * Context variables (state) follow the Hono pattern:
 * - Guards set values via `ctx.set('user', payload)`
 * - Handlers access via `ctx.state.user` or `ctx.get('user')`
 *
 * @typeParam TState - The shape of state variables. Declared at the controller
 *   level to provide type-safe access via `ctx.state`.
 *
 * @typeParam TSocket - The socket emitter type. Defaults to SocketEmitter.
 *   Specify a custom emitter type to get type-safe access to custom methods.
 *   Note: The actual runtime type is RequestBoundSocketEmitter which wraps
 *   the custom emitter; custom methods are available via `ctx.app.socket`.
 *
 * @example
 * ```ts
 * // Guard sets state
 * class AuthGuard implements Guard {
 *   async canActivate(ctx: Context): Promise<boolean> {
 *     ctx.set('user', { id: '123', name: 'Alice' });
 *     return true;
 *   }
 * }
 *
 * // Handler accesses typed state
 * interface AuthState { user: { id: string; name: string } }
 *
 * class MyController implements OriController<AuthState> {
 *   configure(r: RouteBuilder<AuthState>) {
 *     r.guard(AuthGuard);
 *     r.get('/me', this.getMe);
 *   }
 *
 *   private getMe = (ctx: Context<AuthState>) => {
 *     return Response.json(ctx.state.user); // Fully typed!
 *   };
 * }
 *
 * // With custom socket emitter
 * class AppSocketEmitter implements SocketEmitter {
 *   emitToAccount(accountUuid: string, event: string, payload: unknown): void { ... }
 * }
 * private notify = (ctx: RequestContext<{}, AppSocketEmitter>) => {
 *   // Use ctx.app.socket for full custom emitter access
 *   (ctx.app as AppContext<AppSocketEmitter>).socket.emitToAccount('uuid', 'event', {});
 *   // Or use ctx.socket for base SocketEmitter methods with correlation binding
 *   ctx.socket.publish('topic', 'message');
 * };
 * ```
 *
 * Performance optimizations:
 * - Query string parsing is lazy (only on first access)
 * - Logger creation is lazy (only on first access)
 * - Request ID generation is lazy (only on first access)
 * - State object is lazy (only allocated when first accessed)
 * - Minimal object allocations per request
 */
export class RequestContext<
	TState extends object = Record<string, unknown>,
	TSocket extends SocketEmitter = SocketEmitter
> implements BaseContext {
	private stateData: TState | null = null;
	private parsedBody: unknown | undefined;
	private hasParsedBody = false;
	private parseType: 'json' | 'text' | null = null;

	// Lazy parsing config (primitives only - no object allocation)
	private readonly requestUrl: string;
	private readonly queryStart: number;
	private readonly loggerOptions: LoggerOptions;

	// Cached lazy values
	private cachedQuery: Record<string, string | string[]> | null = null;
	private cachedLogger: Logger | null = null;
	private cachedRequestId: string | null = null;
	private cachedEvents: EventEmitter | null = null;
	private cachedWorkflows: WorkflowExecutor | null = null;
	private cachedSocket: SocketEmitter | null = null;

	/**
	 * Access state variables set by guards.
	 * Lazily initialized on first access.
	 *
	 * @example
	 * ```ts
	 * const userId = ctx.state.user.id;
	 * ```
	 */
	get state(): TState {
		if (this.stateData === null) {
			this.stateData = {} as TState;
		}
		return this.stateData;
	}

	/**
	 * Set a state variable. Typically called by guards.
	 * Only keys defined in TState can be set, with type-safe values.
	 *
	 * @example
	 * ```ts
	 * ctx.set('user', { id: '123', name: 'Alice' });
	 * ```
	 */
	public set<K extends keyof TState>(key: K, value: TState[K]): void {
		if (this.stateData === null) {
			this.stateData = {} as TState;
		}
		(this.stateData as Record<string, unknown>)[key as string] = value;
	}

	/**
	 * Get a state variable by key.
	 *
	 * @example
	 * ```ts
	 * const user = ctx.get('user');
	 * ```
	 */
	public get<K extends keyof TState>(key: K): TState[K] {
		return this.state[key];
	}

	constructor(
		readonly app: AppContext,
		readonly request: Request,
		readonly params: Record<string, string>,
		requestUrl: string,
		queryStart: number,
		loggerOptions: LoggerOptions
	) {
		this.requestUrl = requestUrl;
		this.queryStart = queryStart;
		this.loggerOptions = loggerOptions;
	}

	get query(): Record<string, string | string[]> {
		if (this.cachedQuery === null) {
			if (this.queryStart === -1) {
				this.cachedQuery = EMPTY_QUERY;
			} else {
				// Fast path: parse query string directly without creating URL object
				const queryString = this.requestUrl.slice(this.queryStart + 1);
				this.cachedQuery = parseQueryString(queryString);
			}
		}
		return this.cachedQuery;
	}

	/** Lazily generated request ID */
	get correlationId(): string {
		if (this.cachedRequestId === null) {
			this.cachedRequestId = this.request.headers.get('x-request-id') ?? crypto.randomUUID();
		}
		return this.cachedRequestId;
	}

	get log(): Logger {
		if (this.cachedLogger === null) {
			const logger = new Logger('Request', this.loggerOptions).with({ correlationId: this.correlationId });
			// Wire up callback so Logger.setMeta() updates AsyncLocalStorage
			logger.onSetMeta(setContextMeta);
			this.cachedLogger = logger;
		}
		return this.cachedLogger;
	}

	/**
	 * @deprecated Use `ctx.events` instead for definition-based event emission.
	 */
	get event() {
		return this.app.event;
	}

	/**
	 * Event emitter for type-safe event emission.
	 *
	 * Automatically binds events to this request's context, propagating
	 * the request ID as correlation metadata for distributed tracing.
	 *
	 * @example
	 * ```ts
	 * // Define event with Event.define() in your app
	 * const UserCreated = Event.define('user.created')
	 *   .payload(Type.Object({ userId: Type.String(), email: Type.String() }))
	 *   .build();
	 *
	 * private createUser = async (ctx: Context) => {
	 *   const user = await this.userService.create(ctx.body);
	 *
	 *   // Type-safe emit - payload validated against TypeBox schema
	 *   const result = await ctx.events.emit(UserCreated, {
	 *     userId: user.id,
	 *     email: user.email
	 *   });
	 *
	 *   // result is typed as the event's response type
	 *   return ctx.json({ user, ...result });
	 * };
	 * ```
	 */
	get events(): EventEmitter {
		if (this.cachedEvents === null) {
			const coordinator = this.app.eventCoordinator;
			if (!coordinator) {
				throw new Error('Event system not configured. Register events with .event() before using ctx.events');
			}
			this.cachedEvents = new RequestBoundEventEmitter(coordinator, {
				correlationId: this.correlationId,
				logger: this.log
			});
		}
		return this.cachedEvents;
	}

	/**
	 * Workflow executor for type-safe workflow execution.
	 *
	 * Automatically binds workflows to this request's context, propagating
	 * the request ID as correlation metadata for distributed tracing.
	 *
	 * @example
	 * ```ts
	 * // Define workflow with Workflow.define() in your app
	 * const SendWelcomeEmail = Workflow.define('send-welcome-email')
	 *   .input(Type.Object({ to: Type.String(), userId: Type.String() }))
	 *   .output(Type.Object({ sent: Type.Boolean() }))
	 *   .build();
	 *
	 * private createUser = async (ctx: Context) => {
	 *   const user = await this.userService.create(ctx.body);
	 *
	 *   // Type-safe execute - data validated against TypeBox schema
	 *   const handle = await ctx.workflows.execute(SendWelcomeEmail, {
	 *     to: user.email,
	 *     userId: user.id
	 *   });
	 *
	 *   // Wait for result or track asynchronously
	 *   const result = await handle.result();
	 *   return ctx.json({ user, workflowId: handle.id });
	 * };
	 * ```
	 */
	get workflows(): WorkflowExecutor {
		if (this.cachedWorkflows === null) {
			const coordinator = this.app.workflowCoordinator;
			if (!coordinator) {
				throw new Error(
					'Workflow system not configured. Register workflows with .workflow() before using ctx.workflows'
				);
			}
			this.cachedWorkflows = new RequestBoundWorkflowExecutor(coordinator, {
				correlationId: this.correlationId,
				logger: this.log
			});
		}
		return this.cachedWorkflows;
	}

	/**
	 * Socket emitter for WebSocket messaging.
	 *
	 * Provides access to the configured socket emitter for publishing messages
	 * to WebSocket topics. Automatically binds the request's correlation ID
	 * for distributed tracing consistency.
	 *
	 * The correlation ID is available via `(ctx.socket as RequestBoundSocketEmitter).correlationId`
	 * if you need to include it in your message payloads.
	 *
	 * Note: The runtime type is RequestBoundSocketEmitter which wraps the underlying
	 * emitter. For type-safe access to custom emitter methods, use `ctx.app.socket`
	 * with an appropriately typed AppContext.
	 *
	 * @throws {Error} If WebSocket is not configured
	 *
	 * @example
	 * ```ts
	 * private notifyUser = async (ctx: Context) => {
	 *   // Publish to a topic (subscribers on that topic will receive the message)
	 *   ctx.socket.publish(`user:${userId}`, JSON.stringify({ type: 'update', data }));
	 *
	 *   return ctx.json({ sent: true });
	 * };
	 * ```
	 */
	get socket(): TSocket {
		if (this.cachedSocket === null) {
			const emitter = this.app.socket; // Throws if not configured
			this.cachedSocket = new RequestBoundSocketEmitter(emitter, {
				correlationId: this.correlationId,
				logger: this.log
			});
		}
		return this.cachedSocket as TSocket;
	}

	/**
	 * AbortSignal that fires when the client disconnects.
	 * Use this to cancel long-running operations when the request is aborted.
	 *
	 * @example
	 * ```ts
	 * private create = async (ctx: Context) => {
	 *   // Pass signal to database queries
	 *   const result = await db.query('...', { signal: ctx.signal });
	 *
	 *   // Or check manually in loops
	 *   for (const item of items) {
	 *     if (ctx.signal.aborted) {
	 *       throw new Error('Request cancelled');
	 *     }
	 *     await processItem(item);
	 *   }
	 *
	 *   return Response.json(result);
	 * };
	 * ```
	 */
	get signal(): AbortSignal {
		return this.request.signal;
	}

	public async json<T = unknown>(): Promise<T> {
		if (this.parseType === 'text') {
			throw new Error('Body already parsed as text. Cannot re-parse as JSON.');
		}
		if (!this.hasParsedBody) {
			// Use Json.parse for prototype pollution protection
			// request.json() uses native JSON.parse which doesn't sanitize __proto__
			const text = await this.request.text();
			this.parsedBody = Json.parse(text);
			this.hasParsedBody = true;
			this.parseType = 'json';
		}
		return this.parsedBody as T;
	}

	public async text(): Promise<string> {
		if (this.parseType === 'json') {
			throw new Error('Body already parsed as JSON. Cannot re-parse as text.');
		}
		if (!this.hasParsedBody) {
			this.parsedBody = await this.request.text();
			this.hasParsedBody = true;
			this.parseType = 'text';
		}
		return this.parsedBody as string;
	}

	/**
	 * Get a validated path parameter with basic sanitization.
	 * Use this for params that will be used in queries or commands.
	 *
	 * Performance: O(1) length check + O(n) character validation with early exit.
	 * For typical params (UUIDs, slugs), this is effectively O(1) bounded.
	 *
	 * Valid characters: a-z, A-Z, 0-9, hyphen (-), underscore (_)
	 *
	 * @param key - The parameter key
	 * @returns The validated parameter value
	 * @throws Error if param is missing, too long, or contains invalid characters
	 *
	 * @example
	 * ```ts
	 * const slug = ctx.getValidatedParam('slug');  // "my-project-123"
	 * const id = ctx.getValidatedParam('id');      // "abc_123"
	 * ```
	 */
	public getValidatedParam(key: string): string {
		const value = this.params[key];

		// O(1) - Check existence
		if (value === undefined || value === '') {
			throw new Error(`Missing required param: ${key}`);
		}

		// O(1) - Length check prevents DoS
		if (value.length > MAX_PARAM_LENGTH) {
			throw new Error(`Param '${key}' exceeds max length (${MAX_PARAM_LENGTH})`);
		}

		// O(n) with early exit - Validate characters using char codes (faster than regex)
		// Valid: a-z (97-122), A-Z (65-90), 0-9 (48-57), - (45), _ (95)
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			const isValid =
				(code >= 97 && code <= 122) || // a-z
				(code >= 65 && code <= 90) || // A-Z
				(code >= 48 && code <= 57) || // 0-9
				code === 45 || // -
				code === 95; // _

			if (!isValid) {
				throw new Error(`Invalid character in param '${key}' at position ${i}`);
			}
		}

		return value;
	}

	/**
	 * Get a validated UUID path parameter.
	 * Validates the param is a properly formatted UUID v4.
	 *
	 * Performance: O(1) - UUID has fixed length (36 chars), so validation is constant time.
	 *
	 * @param key - The parameter key
	 * @returns The validated UUID string
	 * @throws Error if param is missing or not a valid UUID format
	 *
	 * @example
	 * ```ts
	 * const productUuid = ctx.getValidatedUUID('productUuid');
	 * // "550e8400-e29b-41d4-a716-446655440000"
	 * ```
	 */
	public getValidatedUUID(key: string): string {
		const value = this.params[key];

		// O(1) - Check existence
		if (value === undefined || value === '') {
			throw new Error(`Missing required UUID param: ${key}`);
		}

		// O(1) - UUID is fixed length
		if (value.length !== UUID_LENGTH) {
			throw new Error(`Invalid UUID format for param '${key}': wrong length`);
		}

		// O(1) - Validate UUID format: 8-4-4-4-12 with dashes at positions 8, 13, 18, 23
		// Check dashes first (fast fail)
		if (
			value.charCodeAt(8) !== 45 || // -
			value.charCodeAt(13) !== 45 || // -
			value.charCodeAt(18) !== 45 || // -
			value.charCodeAt(23) !== 45 // -
		) {
			throw new Error(`Invalid UUID format for param '${key}': missing dashes`);
		}

		// O(1) - Validate hex characters at each position (36 chars = constant)
		// Valid hex: 0-9 (48-57), a-f (97-102), A-F (65-70)
		for (let i = 0; i < UUID_LENGTH; i++) {
			if (i === 8 || i === 13 || i === 18 || i === 23) continue; // Skip dashes

			const code = value.charCodeAt(i);
			const isHex =
				(code >= 48 && code <= 57) || // 0-9
				(code >= 97 && code <= 102) || // a-f
				(code >= 65 && code <= 70); // A-F

			if (!isHex) {
				throw new Error(`Invalid UUID format for param '${key}': invalid character`);
			}
		}

		return value;
	}
}
