import { Json, type ValidationError } from '@orijs/validation';

/**
 * Server-Sent Event structure
 */
export interface SseEvent {
	/** Event type (optional, defaults to 'message') */
	event?: string;
	/** Event data - will be JSON serialized if object */
	data: unknown;
	/** Event ID for client reconnection (optional) */
	id?: string;
	/** Retry timeout in milliseconds (optional) */
	retry?: number;
}

/**
 * Options for SSE stream
 */
export interface SseStreamOptions {
	/** Keep-alive interval in milliseconds (default: 15000) */
	keepAliveMs?: number;
	/** Keep-alive comment to send (default: ':keep-alive') */
	keepAliveComment?: string;
}

/**
 * ResponseFactory - Creates standardized HTTP responses
 *
 * Extracted from Application to follow Single Responsibility Principle.
 * Handles JSON serialization, streaming, and standard error response formats.
 *
 * @example
 * ```ts
 * // Static JSON response
 * return responseFactory.json({ users }, 200);
 *
 * // Streaming response
 * return responseFactory.stream(fileStream, 'application/pdf');
 *
 * // Server-Sent Events
 * return responseFactory.sseStream(async function* () {
 *   for await (const update of source) {
 *     yield { event: 'update', data: update };
 *   }
 * });
 * ```
 */
export class ResponseFactory {
	// Pre-computed JSON strings for static responses (avoids JSON.stringify per call)
	private static readonly JSON_404 = '{"error":"Not Found"}';
	private static readonly JSON_403 = '{"error":"Forbidden"}';
	private static readonly JSON_405 = '{"error":"Method Not Allowed"}';
	private static readonly JSON_HEADERS = { 'Content-Type': 'application/json' };

	/**
	 * Create a JSON response with the given data and status
	 */
	public json(data: unknown, status: number): Response {
		return new Response(JSON.stringify(data), {
			status,
			headers: ResponseFactory.JSON_HEADERS
		});
	}

	/**
	 * Convert any value to a Response
	 * - If already a Response, return as-is
	 * - Otherwise, serialize as JSON with 200 status
	 */
	public toResponse(result: unknown): Response {
		if (result instanceof Response) {
			return result;
		}
		return this.json(result, 200);
	}

	/**
	 * 404 Not Found response (uses pre-computed JSON string)
	 */
	public notFound(): Response {
		return new Response(ResponseFactory.JSON_404, {
			status: 404,
			headers: ResponseFactory.JSON_HEADERS
		});
	}

	/**
	 * 403 Forbidden response (uses pre-computed JSON string)
	 */
	public forbidden(): Response {
		return new Response(ResponseFactory.JSON_403, {
			status: 403,
			headers: ResponseFactory.JSON_HEADERS
		});
	}

	/**
	 * 405 Method Not Allowed response (uses pre-computed JSON string)
	 */
	public methodNotAllowed(): Response {
		return new Response(ResponseFactory.JSON_405, {
			status: 405,
			headers: ResponseFactory.JSON_HEADERS
		});
	}

	/**
	 * 500 Internal Server Error response
	 *
	 * In production, only a generic error message is returned to avoid leaking
	 * internal implementation details. In development, the full error message
	 * is included for debugging.
	 *
	 * @param error - The error to respond with
	 * @param options - Optional configuration
	 * @param options.correlationId - Request ID for correlation in logs
	 * @param options.exposeDetails - Force expose/hide error details (overrides NODE_ENV check)
	 */
	public error(error: unknown, options?: { correlationId?: string; exposeDetails?: boolean }): Response {
		const exposeDetails = options?.exposeDetails ?? process.env.NODE_ENV !== 'production';

		return this.json(
			{
				error: 'Internal Server Error',
				...(exposeDetails && { message: error instanceof Error ? error.message : String(error) }),
				...(options?.correlationId && { correlationId: options.correlationId })
			},
			500
		);
	}

	/**
	 * 422 Unprocessable Entity response for validation errors
	 *
	 * Uses HTTP 422 per RFC 7807 - the request was well-formed but semantically invalid.
	 * HTTP 400 is for malformed requests; 422 is for validation failures.
	 *
	 * @param errors - Array of validation errors
	 * @param options - Optional configuration
	 * @param options.correlationId - Request ID for correlation in logs
	 */
	public validationError(errors: ValidationError[], options?: { correlationId?: string }): Response {
		return this.json(
			{
				error: 'Validation Error',
				errors,
				...(options?.correlationId && { correlationId: options.correlationId })
			},
			422
		);
	}

	/**
	 * Create a streaming response from a ReadableStream
	 *
	 * Use for large file downloads, chunked responses, or any streaming data.
	 *
	 * @param readable - The ReadableStream to send
	 * @param contentType - Content-Type header (default: 'application/octet-stream')
	 * @param status - HTTP status code (default: 200)
	 * @returns Streaming Response
	 *
	 * @example
	 * ```ts
	 * // Stream a file
	 * const file = Bun.file('./large-file.pdf');
	 * return responseFactory.stream(file.stream(), 'application/pdf');
	 *
	 * // Stream with custom status
	 * return responseFactory.stream(dataStream, 'text/plain', 206);
	 * ```
	 */
	public stream(readable: ReadableStream, contentType = 'application/octet-stream', status = 200): Response {
		return new Response(readable, {
			status,
			headers: {
				'Content-Type': contentType,
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive'
			}
		});
	}

	/**
	 * Create a Server-Sent Events (SSE) streaming response
	 *
	 * SSE allows servers to push real-time updates to clients over HTTP.
	 * The connection stays open and the server sends events as they occur.
	 *
	 * @param source - AsyncIterable or generator function yielding SseEvent objects
	 * @param options - SSE stream options (keep-alive settings)
	 * @returns SSE Response with proper headers
	 *
	 * @example
	 * ```ts
	 * // Using async generator function
	 * return responseFactory.sseStream(async function* () {
	 *   yield { data: { status: 'connected' } };
	 *
	 *   for await (const update of orderUpdates) {
	 *     yield { event: 'order-update', data: update };
	 *   }
	 * });
	 *
	 * // Using an existing AsyncIterable
	 * return responseFactory.sseStream(eventSource);
	 *
	 * // With event ID for reconnection
	 * yield { event: 'update', data: payload, id: '12345' };
	 *
	 * // With retry timeout
	 * yield { event: 'update', data: payload, retry: 5000 };
	 * ```
	 */
	public sseStream(
		source: AsyncIterable<SseEvent> | (() => AsyncIterable<SseEvent>),
		options: SseStreamOptions = {}
	): Response {
		const { keepAliveMs = 15000, keepAliveComment = ':keep-alive' } = options;

		// If source is a function (generator), call it to get the iterable
		const events = typeof source === 'function' ? source() : source;

		const encoder = new TextEncoder();
		let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				// Set up keep-alive if enabled
				if (keepAliveMs > 0) {
					keepAliveTimer = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(`${keepAliveComment}\n\n`));
						} catch {
							// Controller may be closed
							if (keepAliveTimer) {
								clearInterval(keepAliveTimer);
								keepAliveTimer = null;
							}
						}
					}, keepAliveMs);
				}

				try {
					for await (const event of events) {
						const message = formatSseEvent(event);
						controller.enqueue(encoder.encode(message));
					}
				} catch (error) {
					// Send error event before closing
					const errorEvent = formatSseEvent({
						event: 'error',
						data: { message: error instanceof Error ? error.message : String(error) }
					});
					controller.enqueue(encoder.encode(errorEvent));
				} finally {
					if (keepAliveTimer) {
						clearInterval(keepAliveTimer);
						keepAliveTimer = null;
					}
					controller.close();
				}
			},

			cancel() {
				if (keepAliveTimer) {
					clearInterval(keepAliveTimer);
					keepAliveTimer = null;
				}
			}
		});

		return new Response(stream, {
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no' // Disable nginx buffering
			}
		});
	}
}

/**
 * Format an SSE event according to the SSE specification
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format
 */
function formatSseEvent(event: SseEvent): string {
	const lines: string[] = [];

	// Event type (optional)
	if (event.event) {
		lines.push(`event: ${event.event}`);
	}

	// Event ID (optional)
	if (event.id) {
		lines.push(`id: ${event.id}`);
	}

	// Retry timeout (optional)
	if (event.retry !== undefined) {
		lines.push(`retry: ${event.retry}`);
	}

	// Data (required) - JSON serialize objects, handle multi-line strings
	// Use Json.stringify for API symmetry (safe output encoding)
	const dataStr = typeof event.data === 'string' ? event.data : Json.stringify(event.data);
	// SSE spec: each line of data must be prefixed with 'data: '
	const dataLines = dataStr.split('\n');
	for (const line of dataLines) {
		lines.push(`data: ${line}`);
	}

	// Events are separated by double newline
	return lines.join('\n') + '\n\n';
}

/**
 * Default response factory instance
 */
export const responseFactory = new ResponseFactory();
