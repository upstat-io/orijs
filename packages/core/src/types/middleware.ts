import type { RequestContext } from '../controllers/request-context.ts';

/**
 * Guard interface for authentication/authorization checks.
 * Guards run before the handler and can block requests.
 */
export interface Guard {
	/**
	 * Determines if the request should proceed.
	 * @param ctx - The request context
	 * @returns `true` to allow, `false` to deny (returns 403 Forbidden),
	 *          or a `Response` to short-circuit with a custom HTTP response (e.g. 401 Unauthorized)
	 */
	canActivate(ctx: RequestContext): boolean | Response | Promise<boolean | Response>;
}

/** Constructor type for Guard classes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GuardClass = new (...args: any[]) => Guard;

/**
 * Interceptor interface for request/response transformation.
 * Interceptors wrap handler execution in an onion model.
 */
export interface Interceptor {
	/**
	 * Intercepts the request/response cycle.
	 * @param ctx - The request context
	 * @param next - Call to proceed to the next interceptor or handler
	 * @returns The response (possibly transformed)
	 */
	intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response>;
}

/** Constructor type for Interceptor classes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InterceptorClass = new (...args: any[]) => Interceptor;

/**
 * Pipe interface for input validation and transformation.
 * @typeParam TInput - The input type to transform
 * @typeParam TOutput - The output type after transformation
 */
export interface Pipe<TInput = unknown, TOutput = unknown> {
	/**
	 * Transforms and validates input data.
	 * @param value - The input value to transform
	 * @param metadata - Additional context about the value source
	 * @returns The transformed value
	 * @throws Validation errors if the input is invalid
	 */
	transform(value: TInput, metadata?: PipeMetadata): TOutput | Promise<TOutput>;
}

/** Metadata describing the source of pipe input */
export interface PipeMetadata {
	/** Where the value came from */
	type: 'body' | 'param' | 'query';
	/** The specific key (for params and query) */
	key?: string;
}

/** Constructor type for Pipe classes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PipeClass = new (...args: any[]) => Pipe;
