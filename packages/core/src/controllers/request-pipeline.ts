import type {
	Guard,
	Interceptor,
	RequestContext,
	HttpMethod,
	RouteSchemaOptions,
	RouteDefinition
} from '../types/index.ts';
import type { Container } from '../container.ts';
import type { ResponseFactory } from './response';
import {
	runWithContext,
	createTraceContext,
	type TraceContext,
	type Logger,
	type LoggerOptions
} from '@orijs/logging';
import { RequestContextFactory } from './request-context';
import type { AppContext } from '../app-context.ts';
import { validate, type ValidationError } from '@orijs/validation';

/** Standard trace context header names (W3C Trace Context compatible) */
const TRACE_PARENT_HEADER = 'traceparent';
const TRACE_ID_HEADER = 'x-trace-id';
const SPAN_ID_HEADER = 'x-span-id';
/** Request ID header names (common aliases for correlation ID) */
const REQUEST_ID_HEADER = 'x-request-id';
const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Compiled route with full path for Bun native routing */
export interface CompiledRoute extends RouteDefinition {
	/** Full path including controller prefix */
	fullPath: string;
}

/** Bun's request type with params */
export interface BunRequest extends Request {
	params: Record<string, string>;
}

/** Route handler type for Bun.serve() routes */
export type BunRouteHandler = (req: BunRequest) => Response | Promise<Response>;

/**
 * Handles the request processing pipeline: guards, interceptors, validation, and handler execution.
 * Extracted from Application to follow Single Responsibility Principle.
 *
 * Note: Guards and interceptors are resolved through the Container, which handles
 * singleton caching. No local cache is needed here - the Container's singleton
 * behavior ensures thread-safe instance reuse across concurrent requests.
 */
export class RequestPipeline {
	constructor(
		private readonly container: Container,
		private readonly responseFactory: ResponseFactory,
		private readonly appLogger: Logger
	) {}

	/**
	 * Extracts correlation ID from headers.
	 * Prefers x-correlation-id (standard from UI), falls back to x-request-id.
	 */
	private extractCorrelationId(req: Request): string {
		return (
			req.headers.get(CORRELATION_ID_HEADER) ?? req.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID()
		);
	}

	/**
	 * Extracts or creates trace context for the request.
	 * Supports W3C traceparent format and custom x-trace-id/x-span-id headers.
	 * Always returns a trace context - generates one if no headers present.
	 */
	private extractTraceContext(req: Request): TraceContext {
		// Try W3C traceparent header first
		const traceparent = req.headers.get(TRACE_PARENT_HEADER);
		if (traceparent) {
			// traceparent format: version-trace_id-parent_id-flags (e.g., 00-xxx-yyy-01)
			const parts = traceparent.split('-');
			if (parts.length >= 3) {
				return createTraceContext(parts[1], parts[2]);
			}
		}

		// Check for custom headers
		const traceId = req.headers.get(TRACE_ID_HEADER);
		const spanId = req.headers.get(SPAN_ID_HEADER);

		// Create trace context - auto-generate if no headers present
		// This ensures every request has a traceId for distributed tracing
		return createTraceContext(traceId ?? undefined, spanId ?? undefined);
	}

	/**
	 * Creates a Bun route handler that wraps the route with context, guards, and interceptors.
	 * Optimized for the common case: no guards, no interceptors, no schema validation.
	 *
	 * Guards and interceptors are resolved once at route registration time (not per-request).
	 *
	 * @param corsHeaders - Optional pre-computed CORS headers to inject into all responses
	 */
	public createHandler(
		route: CompiledRoute,
		appContext: AppContext,
		sharedLoggerOptions: LoggerOptions,
		corsHeaders?: Record<string, string> | null
	): BunRouteHandler {
		const method = route.method;
		const hasGuards = route.guards.length > 0;
		const hasInterceptors = route.interceptors.length > 0;
		const hasSchema = !!route.schema;
		const handler = route.handler as (ctx: RequestContext) => Response | Promise<Response>;

		// Create factory once, reuse for all requests on this route
		const contextFactory = new RequestContextFactory(appContext, sharedLoggerOptions);

		// Pre-resolve guards at route registration time (singleton instances)
		const guards = hasGuards ? route.guards.map((G) => this.container.resolve(G)) : [];

		// Pre-resolve interceptors at route registration time (singleton instances)
		const interceptors = hasInterceptors ? route.interceptors.map((I) => this.container.resolve(I)) : [];

		// Create response finalizer that adds CORS headers if configured
		const finalizeResponse = corsHeaders
			? (response: Response) => this.addCorsHeaders(response, corsHeaders)
			: (response: Response) => response;

		// Fast path: no guards, no interceptors, no schema - minimal overhead
		// Still use runWithContext for correlation ID propagation (needed for distributed tracing)
		// Optimization: Use sync wrapper with try-catch + .catch() instead of async/await (~23% faster)
		if (!hasGuards && !hasInterceptors && !hasSchema) {
			return (req: BunRequest): Promise<Response> => {
				const params = req.params || {};
				const ctx = contextFactory.create(req, params);
				const trace = this.extractTraceContext(req);
				const correlationId = this.extractCorrelationId(req);

				const handleError = (error: unknown): Response => {
					this.appLogger.error('Unhandled error in request handler', {
						correlationId,
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					return finalizeResponse(this.responseFactory.error(error, { correlationId, exposeDetails: false }));
				};

				return runWithContext({ log: this.appLogger, correlationId, trace }, () => {
					try {
						// Handler may return Response or Promise<Response>
						// Promise.resolve handles both cases, .catch() handles async rejections
						return Promise.resolve(handler(ctx)).then(finalizeResponse).catch(handleError);
					} catch (error) {
						// Sync throw from handler
						return Promise.resolve(handleError(error));
					}
				}) as Promise<Response>;
			};
		}

		// Full path: guards, interceptors, and/or schema validation
		return async (req: BunRequest): Promise<Response> => {
			const params = req.params || {};
			const ctx = contextFactory.create(req, params);
			const trace = this.extractTraceContext(req);
			const correlationId = this.extractCorrelationId(req);

			return runWithContext({ log: this.appLogger, correlationId, trace }, async () => {
				try {
					// Run guards (pre-resolved at route registration)
					if (hasGuards) {
						const guardResult = await this.runGuards(guards, ctx);
						if (guardResult) {
							return finalizeResponse(guardResult);
						}
					}

					// Validate request if schema is defined
					if (hasSchema) {
						const validationResult = await this.validateRequest(ctx, route.schema!, method);
						if (validationResult) {
							return finalizeResponse(validationResult);
						}
					}

					// Execute handler (with pre-resolved interceptors if any)
					const response = hasInterceptors
						? await this.executeWithInterceptors(interceptors, handler, ctx)
						: await handler(ctx);

					return finalizeResponse(response);
				} catch (error) {
					this.appLogger.error('Unhandled error in request handler', {
						correlationId,
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					return finalizeResponse(this.responseFactory.error(error, { correlationId, exposeDetails: false }));
				}
			});
		};
	}

	/**
	 * Adds CORS headers to a response.
	 */
	private addCorsHeaders(response: Response, corsHeaders: Record<string, string>): Response {
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

	private async runGuards(guards: Guard[], ctx: RequestContext): Promise<Response | null> {
		for (const guard of guards) {
			const canActivate = await guard.canActivate(ctx);
			if (!canActivate) {
				return this.responseFactory.forbidden();
			}
		}
		return null;
	}

	private async executeWithInterceptors(
		interceptors: Interceptor[],
		handler: (ctx: RequestContext) => Response | Promise<Response>,
		ctx: RequestContext
	): Promise<Response> {
		// Build interceptor chain with pre-resolved instances
		const handlerFn = this.wrapHandler(handler, ctx);
		const chain = this.buildInterceptorChain(interceptors, ctx, handlerFn);
		return chain();
	}

	private wrapHandler(
		handler: (ctx: RequestContext) => Response | Promise<Response>,
		ctx: RequestContext
	): () => Promise<Response> {
		return async (): Promise<Response> => {
			return handler(ctx);
		};
	}

	private buildInterceptorChain(
		interceptors: Interceptor[],
		ctx: RequestContext,
		handler: () => Promise<Response>
	): () => Promise<Response> {
		let chain = handler;
		for (let i = interceptors.length - 1; i >= 0; i--) {
			const interceptor = interceptors[i]!;
			const next = chain;
			chain = () => interceptor.intercept(ctx, next);
		}
		return chain;
	}

	private prefixErrors(prefix: string, errors: ValidationError[]): ValidationError[] {
		return errors.map((e) => {
			// TypeBox uses JSON Pointer paths (e.g., "/accountUuid")
			// Convert to dot notation (e.g., "body.accountUuid")
			const normalizedPath = e.path.startsWith('/') ? e.path.slice(1).replace(/\//g, '.') : e.path;
			return { ...e, path: normalizedPath ? `${prefix}.${normalizedPath}` : prefix };
		});
	}

	private async validateRequest(
		ctx: RequestContext,
		schema: RouteSchemaOptions,
		method: HttpMethod
	): Promise<Response | null> {
		const errors: ValidationError[] = [];

		// Validate params
		if (schema.params) {
			const result = await validate(schema.params, ctx.params);
			if (!result.success) {
				errors.push(...this.prefixErrors('params', result.errors));
			}
		}

		// Validate query
		if (schema.query) {
			const result = await validate(schema.query, ctx.query);
			if (!result.success) {
				errors.push(...this.prefixErrors('query', result.errors));
			}
		}

		// Validate body for POST, PUT, PATCH
		if (schema.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
			try {
				const body = await ctx.json();
				const result = await validate(schema.body, body);
				if (!result.success) {
					errors.push(...this.prefixErrors('body', result.errors));
				}
			} catch {
				errors.push({ path: 'body', message: 'Invalid JSON body' });
			}
		}

		if (errors.length > 0) {
			return this.responseFactory.validationError(errors);
		}

		return null;
	}
}
