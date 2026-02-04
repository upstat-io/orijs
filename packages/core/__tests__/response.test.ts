import { describe, test, expect, beforeEach } from 'bun:test';
import { ResponseFactory, responseFactory } from '../src/controllers/response.ts';
import type { ValidationError } from '@orijs/validation';

describe('ResponseFactory', () => {
	let factory: ResponseFactory;

	beforeEach(() => {
		factory = new ResponseFactory();
	});

	describe('json', () => {
		test('should create JSON response with correct body', async () => {
			const data = { name: 'test', value: 42 };

			const response = factory.json(data, 200);
			const body = await response.json();

			expect(body).toEqual(data);
		});

		test('should set correct status code', () => {
			const response = factory.json({ data: 'test' }, 201);

			expect(response.status).toBe(201);
		});

		test('should set Content-Type header to application/json', () => {
			const response = factory.json({ data: 'test' }, 200);

			expect(response.headers.get('Content-Type')).toBe('application/json');
		});

		test('should handle null data', async () => {
			const response = factory.json(null, 200);
			const body = await response.json();

			expect(body).toBeNull();
		});

		test('should handle array data', async () => {
			const data = [1, 2, 3];

			const response = factory.json(data, 200);
			const body = await response.json();

			expect(body).toEqual([1, 2, 3]);
		});
	});

	describe('toResponse', () => {
		test('should return Response object unchanged', () => {
			const originalResponse = new Response('original', { status: 201 });

			const result = factory.toResponse(originalResponse);

			expect(result).toBe(originalResponse);
			expect(result.status).toBe(201);
		});

		test('should convert plain object to JSON response', async () => {
			const data = { message: 'hello' };

			const response = factory.toResponse(data);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body).toEqual({ message: 'hello' });
		});

		test('should convert string to JSON response', async () => {
			const response = factory.toResponse('hello');
			const body = await response.json();

			expect(body).toBe('hello');
		});

		test('should convert number to JSON response', async () => {
			const response = factory.toResponse(42);
			const body = await response.json();

			expect(body).toBe(42);
		});
	});

	describe('notFound', () => {
		test('should return 404 status', () => {
			const response = factory.notFound();

			expect(response.status).toBe(404);
		});

		test('should return error message in body', async () => {
			const response = factory.notFound();
			const body = await response.json();

			expect(body).toEqual({ error: 'Not Found' });
		});
	});

	describe('forbidden', () => {
		test('should return 403 status', () => {
			const response = factory.forbidden();

			expect(response.status).toBe(403);
		});

		test('should return error message in body', async () => {
			const response = factory.forbidden();
			const body = await response.json();

			expect(body).toEqual({ error: 'Forbidden' });
		});
	});

	describe('methodNotAllowed', () => {
		test('should return 405 status', () => {
			const response = factory.methodNotAllowed();

			expect(response.status).toBe(405);
		});

		test('should return error message in body', async () => {
			const response = factory.methodNotAllowed();
			const body = await response.json();

			expect(body).toEqual({ error: 'Method Not Allowed' });
		});
	});

	describe('error', () => {
		test('should return 500 status', () => {
			const response = factory.error(new Error('Test error'));

			expect(response.status).toBe(500);
		});

		test('should include error message from Error object', async () => {
			const response = factory.error(new Error('Something went wrong'));
			const body = await response.json();

			expect(body).toEqual({
				error: 'Internal Server Error',
				message: 'Something went wrong'
			});
		});

		test('should convert non-Error to string message', async () => {
			const response = factory.error('string error');
			const body = await response.json();

			expect(body).toEqual({
				error: 'Internal Server Error',
				message: 'string error'
			});
		});

		test('should handle undefined error', async () => {
			const response = factory.error(undefined);
			const body = await response.json();

			expect(body).toEqual({
				error: 'Internal Server Error',
				message: 'undefined'
			});
		});
	});

	describe('validationError', () => {
		test('should return 422 status per RFC 7807', () => {
			const errors: ValidationError[] = [{ path: 'field', message: 'required' }];

			const response = factory.validationError(errors);

			expect(response.status).toBe(422);
		});

		test('should include validation errors in body', async () => {
			const errors: ValidationError[] = [
				{ path: 'email', message: 'Invalid email format' },
				{ path: 'name', message: 'Name is required' }
			];

			const response = factory.validationError(errors);
			const body = await response.json();

			expect(body).toEqual({
				error: 'Validation Error',
				errors: [
					{ path: 'email', message: 'Invalid email format' },
					{ path: 'name', message: 'Name is required' }
				]
			});
		});

		test('should handle empty errors array', async () => {
			const response = factory.validationError([]);
			const body = await response.json();

			expect(body).toEqual({
				error: 'Validation Error',
				errors: []
			});
		});
	});
});

describe('responseFactory singleton', () => {
	test('should be an instance of ResponseFactory', () => {
		expect(responseFactory).toBeInstanceOf(ResponseFactory);
	});

	test('should create valid responses', async () => {
		const response = responseFactory.json({ test: true }, 200);
		const body = await response.json();

		expect(body).toEqual({ test: true });
	});
});

describe('stream', () => {
	let factory: ResponseFactory;

	beforeEach(() => {
		factory = new ResponseFactory();
	});

	test('should create streaming response with ReadableStream', async () => {
		const chunks = ['Hello, ', 'World!'];
		const stream = new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(new TextEncoder().encode(chunk));
				}
				controller.close();
			}
		});

		const response = factory.stream(stream, 'text/plain');
		const text = await response.text();

		expect(text).toBe('Hello, World!');
	});

	test('should set correct Content-Type header', () => {
		const stream = new ReadableStream({
			start(c) {
				c.close();
			}
		});

		const response = factory.stream(stream, 'application/pdf');

		expect(response.headers.get('Content-Type')).toBe('application/pdf');
	});

	test('should use application/octet-stream as default Content-Type', () => {
		const stream = new ReadableStream({
			start(c) {
				c.close();
			}
		});

		const response = factory.stream(stream);

		expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
	});

	test('should set Cache-Control and Connection headers', () => {
		const stream = new ReadableStream({
			start(c) {
				c.close();
			}
		});

		const response = factory.stream(stream);

		expect(response.headers.get('Cache-Control')).toBe('no-cache');
		expect(response.headers.get('Connection')).toBe('keep-alive');
	});

	test('should use default status 200', () => {
		const stream = new ReadableStream({
			start(c) {
				c.close();
			}
		});

		const response = factory.stream(stream);

		expect(response.status).toBe(200);
	});

	test('should allow custom status code', () => {
		const stream = new ReadableStream({
			start(c) {
				c.close();
			}
		});

		const response = factory.stream(stream, 'text/plain', 206);

		expect(response.status).toBe(206);
	});
});

describe('sseStream', () => {
	let factory: ResponseFactory;

	beforeEach(() => {
		factory = new ResponseFactory();
	});

	/** Helper to read all chunks from SSE response */
	async function readSseResponse(response: Response): Promise<string> {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let result = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			result += decoder.decode(value, { stream: true });
		}

		return result;
	}

	test('should create SSE response with correct headers', () => {
		const response = factory.sseStream(async function* () {
			yield { data: 'test' };
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');
		expect(response.headers.get('Cache-Control')).toBe('no-cache');
		expect(response.headers.get('Connection')).toBe('keep-alive');
		expect(response.headers.get('X-Accel-Buffering')).toBe('no');
	});

	test('should format data-only event correctly', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { data: 'hello' };
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('data: hello\n\n');
	});

	test('should JSON serialize object data', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { data: { message: 'hello', count: 42 } };
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('data: {"message":"hello","count":42}\n\n');
	});

	test('should include event type when specified', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { event: 'update', data: 'payload' };
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('event: update\ndata: payload\n\n');
	});

	test('should include event ID when specified', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { data: 'payload', id: 'msg-123' };
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('id: msg-123\ndata: payload\n\n');
	});

	test('should include retry timeout when specified', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { data: 'payload', retry: 5000 };
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('retry: 5000\ndata: payload\n\n');
	});

	test('should include all fields in correct order', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { event: 'message', id: '123', retry: 3000, data: { text: 'hello' } };
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('event: message\nid: 123\nretry: 3000\ndata: {"text":"hello"}\n\n');
	});

	test('should handle multiple events', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { data: 'first' };
				yield { data: 'second' };
				yield { data: 'third' };
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('data: first\n\ndata: second\n\ndata: third\n\n');
	});

	test('should handle multi-line data strings', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { data: 'line1\nline2\nline3' };
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('data: line1\ndata: line2\ndata: line3\n\n');
	});

	test('should accept AsyncIterable directly', async () => {
		const events = {
			async *[Symbol.asyncIterator]() {
				yield { data: 'from iterable' };
			}
		};

		const response = factory.sseStream(events, { keepAliveMs: 0 });
		const text = await readSseResponse(response);

		expect(text).toBe('data: from iterable\n\n');
	});

	test('should handle errors gracefully', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { data: 'before error' };
				throw new Error('Stream error');
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toContain('data: before error');
		expect(text).toContain('event: error');
		expect(text).toContain('Stream error');
	});

	test('should handle empty generator', async () => {
		const response = factory.sseStream(
			async function* () {
				// No events
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toBe('');
	});

	test('should send keep-alive comments when enabled', async () => {
		const response = factory.sseStream(
			async function* () {
				// Delay to allow keep-alive to fire
				await new Promise((resolve) => setTimeout(resolve, 150));
				yield { data: 'after-keepalive' };
			},
			{ keepAliveMs: 50, keepAliveComment: ': ping' }
		);

		const text = await readSseResponse(response);

		// Should have at least one keep-alive before the data
		expect(text).toContain(': ping');
		expect(text).toContain('data: after-keepalive');
	});

	test('should use default keep-alive comment', async () => {
		const response = factory.sseStream(
			async function* () {
				await new Promise((resolve) => setTimeout(resolve, 150));
				yield { data: 'done' };
			},
			{ keepAliveMs: 50 }
		);

		const text = await readSseResponse(response);

		// Default comment is ':keep-alive' (no space after colon)
		expect(text).toContain(':keep-alive');
	});

	test('should clean up keep-alive timer on stream close', async () => {
		// Test that the keep-alive interval is cleaned up when stream ends
		const response = factory.sseStream(
			async function* () {
				yield { data: 'single-event' };
			},
			{ keepAliveMs: 10 }
		);

		const text = await readSseResponse(response);

		expect(text).toContain('data: single-event');

		// Wait a bit to ensure no errors from orphaned interval
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	test('should handle non-Error throw gracefully', async () => {
		const response = factory.sseStream(
			async function* () {
				yield { data: 'before' };
				throw 'string error';
			},
			{ keepAliveMs: 0 }
		);

		const text = await readSseResponse(response);

		expect(text).toContain('data: before');
		expect(text).toContain('event: error');
		expect(text).toContain('string error');
	});
});
