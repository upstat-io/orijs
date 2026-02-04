import type { RequestContext } from '../controllers/request-context.ts';
import type { Token } from '../token.ts';

/**
 * Generic constructor type for dependency injection.
 *
 * Uses `any` for constructor parameters because:
 * 1. TypeScript cannot express "any valid constructor" without `any`
 * 2. The DI container handles type safety via ConstructorDeps<T> at registration
 * 3. This is the standard pattern used by Angular, NestJS, and other DI frameworks
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = any> = new (...args: any[]) => T;

/**
 * Injection token - can be a class, typed token (symbol), or string.
 * Token<T> must come before symbol in the union to preserve type information.
 */
export type InjectionToken<T = unknown> = Constructor<T> | Token<T> | string;

/**
 * Recursively maps tuple elements to constructor types.
 * Used internally by ConstructorDeps.
 *
 * Uses `any` for constructor args because we only care about the return type (First),
 * not the constructor's parameter types. The actual type safety comes from matching
 * the return type to the expected dependency type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TupleToConstructors<T extends readonly unknown[]> = T extends []
	? []
	: T extends [infer First, ...infer Rest]
		? [new (...args: any[]) => First, ...TupleToConstructors<Rest>]
		: never;

/**
 * Maps constructor parameter types to their constructor types.
 * Used to strongly type dependency arrays - TypeScript enforces correct types AND order.
 *
 * Uses `any` in the constraint because TypeScript's ConstructorParameters<T> requires
 * a constructor type, and the most general constructor type uses `any`. The actual
 * type safety is enforced by the return type of TupleToConstructors.
 *
 * @example
 * ```ts
 * class UserService {
 *   constructor(private db: DbService, private cache: CacheService) {}
 * }
 *
 * // TypeScript enforces:
 * const deps: ConstructorDeps<typeof UserService> = [DbService, CacheService];  // ✅
 * const deps: ConstructorDeps<typeof UserService> = [CacheService, DbService];  // ❌ Error!
 * const deps: ConstructorDeps<typeof UserService> = [DbService];                // ❌ Error!
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConstructorDeps<T extends new (...args: any[]) => any> = TupleToConstructors<
	ConstructorParameters<T>
>;

/**
 * Lifecycle hook function type.
 * Can be sync or async.
 */
export type LifecycleHook = () => void | Promise<void>;

/**
 * Lifecycle phases for the application.
 */
export type LifecyclePhase = 'created' | 'bootstrapped' | 'starting' | 'ready' | 'stopping' | 'stopped';

// EventSystem is defined in events/event-system.ts
// Import from there for the full interface

/**
 * Route handler function.
 * Handlers MUST return a Response object directly.
 * Use OriResponse.json<T>() for type-safe JSON responses.
 *
 * @example
 * ```ts
 * r.get('/users', async (ctx) => {
 *   const users = await userService.list();
 *   return OriResponse.json(users);
 * });
 *
 * r.post('/users', async (ctx) => {
 *   const data = await ctx.json<CreateUserRequest>();
 *   await userService.create(data);
 *   return OriResponse.json<ResponseStatus>({ status: 'success' });
 * });
 * ```
 */
export type Handler = (ctx: RequestContext) => Response | Promise<Response>;

/**
 * Route handler - either a function or a static Response.
 * Static Response is passed directly to Bun for zero-allocation dispatch.
 *
 * @example
 * ```ts
 * // Dynamic handler (function)
 * r.get('/users', async (ctx) => OriResponse.json(await userService.list()));
 *
 * // Static response (zero allocation)
 * r.get('/health', OriResponse.text('ok'));
 * r.get('/version', OriResponse.json({ version: '1.0.0' }));
 * ```
 */
export type HandlerInput = Handler | Response;
