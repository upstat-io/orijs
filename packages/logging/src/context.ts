import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from './logger';

/**
 * Distributed tracing context for cross-service correlation.
 *
 * - traceId: Unique ID for the entire request chain (preserved across services)
 * - spanId: Unique ID for the current operation (new per request/event)
 * - parentSpanId: The spanId of the parent operation (for tree reconstruction)
 */
export interface TraceContext {
	/** Unique ID for the entire distributed trace (preserved across services) */
	readonly traceId: string;
	/** Unique ID for the current span/operation */
	readonly spanId: string;
	/** Parent span ID (enables trace tree reconstruction) */
	readonly parentSpanId?: string;
}

export interface RequestContextData {
	log: Logger;
	correlationId: string;
	/** Distributed tracing context */
	trace?: TraceContext;
	/** Application-injected metadata (userId, accountUuid, etc.) */
	meta?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<RequestContextData>();

/** Cached fallback context to avoid creating new Logger instances on every call */
let fallbackContext: RequestContextData | null = null;

/**
 * Gets the current request context from AsyncLocalStorage.
 * Falls back to a console logger if no context is set (unit tests, scripts).
 */
export function requestContext(): RequestContextData {
	const store = storage.getStore();
	if (!store) {
		if (!fallbackContext) {
			fallbackContext = {
				log: Logger.console(),
				correlationId: ''
			};
		}
		return fallbackContext;
	}
	return store;
}

/**
 * Runs a function within a request context.
 * Used by the framework to set up context for each request.
 */
export function runWithContext<T>(context: RequestContextData, fn: () => T | Promise<T>): T | Promise<T> {
	return storage.run(context, fn);
}

/**
 * Injects application-specific metadata into the current request context.
 * Used by guards and middleware to add fields like userId, accountUuid.
 *
 * The injected metadata:
 * - Persists for the duration of the request
 * - Is automatically propagated across service boundaries (events, workflows)
 * - Appears as trace fields in logs if registered via registerTraceFields()
 *
 * @example
 * ```typescript
 * // In AuthGuard
 * setMeta({ userId: payload.userId, accountUuid: payload.accountUuid });
 * ```
 */
export function setMeta(meta: Record<string, unknown>): void {
	const ctx = storage.getStore();
	if (!ctx) {
		// No context available (e.g., called outside of request)
		return;
	}

	// Merge with existing meta
	ctx.meta = { ...ctx.meta, ...meta };

	// Also update the logger context so logs include these fields
	const updatedLog = ctx.log.with(meta);
	// Replace the log reference (Logger is immutable, so we need to update the context)
	(ctx as { log: Logger }).log = updatedLog;
}

/**
 * Generates a unique correlation ID
 */
export function generateCorrelationId(): string {
	return crypto.randomUUID();
}

/**
 * Standard span ID length in hex characters.
 * 64 bits = 16 hex chars per OpenTelemetry/W3C Trace Context spec.
 */
const SPAN_ID_HEX_LENGTH = 16;

/**
 * Generates a unique span ID (shorter than UUID for efficiency in headers).
 * Uses 64-bit span IDs per OpenTelemetry/W3C Trace Context specification.
 */
export function generateSpanId(): string {
	return crypto.randomUUID().replace(/-/g, '').slice(0, SPAN_ID_HEX_LENGTH);
}

/**
 * Creates a new trace context for an incoming request.
 *
 * @param incomingTraceId - Trace ID from incoming request headers (if any)
 * @param incomingSpanId - Span ID from parent operation (becomes parentSpanId)
 */
export function createTraceContext(incomingTraceId?: string, incomingSpanId?: string): TraceContext {
	return {
		traceId: incomingTraceId ?? crypto.randomUUID(),
		spanId: generateSpanId(),
		parentSpanId: incomingSpanId
	};
}

/**
 * Creates a child trace context for an outgoing operation (event, HTTP call).
 * The current spanId becomes the parentSpanId, and a new spanId is generated.
 *
 * @param parent - The parent trace context
 */
export function createChildTraceContext(parent: TraceContext): TraceContext {
	return {
		traceId: parent.traceId,
		spanId: generateSpanId(),
		parentSpanId: parent.spanId
	};
}

/**
 * Metadata for cross-service context propagation.
 *
 * Used by all OriJS systems (Controller, Event, Cache, Workflow) to propagate
 * request context across service boundaries and async operations.
 *
 * Compatible with Logger.propagationMeta() output and Logger.fromMeta() input.
 *
 * ALL fields use camelCase - this is the framework standard.
 *
 * Contains:
 * - Core framework fields: correlationId, traceId, spanId, parentSpanId
 * - Application-injected fields: any additional fields set via setMeta()
 */
export interface PropagationMeta {
	/** Correlation ID for request tracing across services */
	readonly correlationId?: string;
	/** Trace ID for distributed tracing (preserved across services) */
	readonly traceId?: string;
	/** Span ID for current operation */
	readonly spanId?: string;
	/** Parent span ID (enables trace tree reconstruction) */
	readonly parentSpanId?: string;
	/** Application-injected fields (userId, accountUuid, etc.) */
	readonly [key: string]: unknown;
}

/**
 * Captures propagation metadata from the current request context.
 *
 * Used by all OriJS systems (Controller, Event, Cache, Workflow) to automatically
 * propagate context without requiring consumers to pass it explicitly.
 *
 * Creates a child trace span for the outgoing operation to enable distributed
 * tracing tree reconstruction.
 *
 * Captures:
 * - Core framework fields: correlationId, traceId, spanId, parentSpanId
 * - Application-injected fields: any metadata set via setMeta()
 *
 * ALL fields use camelCase - this is the framework standard.
 *
 * @returns PropagationMeta with context from AsyncLocalStorage, or undefined if no context
 */
export function capturePropagationMeta(): PropagationMeta | undefined {
	const ctx = requestContext();

	// Build the propagation metadata
	const meta: PropagationMeta = {};

	// Add correlationId if available
	if (ctx.correlationId) {
		(meta as Record<string, unknown>).correlationId = ctx.correlationId;
	}

	// Add trace context with child span
	if (ctx.trace) {
		const childTrace = createChildTraceContext(ctx.trace);
		(meta as Record<string, unknown>).traceId = childTrace.traceId;
		(meta as Record<string, unknown>).spanId = childTrace.spanId;
		if (childTrace.parentSpanId) {
			(meta as Record<string, unknown>).parentSpanId = childTrace.parentSpanId;
		}
	}

	// Add application-injected metadata
	if (ctx.meta) {
		for (const [key, value] of Object.entries(ctx.meta)) {
			if (value !== undefined) {
				(meta as Record<string, unknown>)[key] = value;
			}
		}
	}

	// Return undefined if no context was captured
	if (Object.keys(meta).length === 0) {
		return undefined;
	}

	return meta;
}
