import { describe, test, expect } from 'bun:test';
import { RequestContext } from '../src/controllers/request-context.ts';
import { RequestBoundSocketEmitter } from '../src/controllers/request-bound-emitters.ts';
import type { AppContext } from '../src/app-context.ts';
import { parseQuery } from '../src/utils/query.ts';
import { Logger } from '@orijs/logging';
import type { ConfigProvider } from '@orijs/config';
import type { SocketEmitter } from '../src/types/emitter.ts';
import { createRouteKey } from '../src/route-key.ts';

/** Mock config provider for testing */
const mockConfigProvider: ConfigProvider = {
	get: async () => undefined,
	getRequired: async () => {
		throw new Error('Not configured in mock');
	},
	loadKeys: async () => ({})
};

/** Create a minimal mock AppContext for testing RequestContext */
function createMockAppContext(log?: Logger): AppContext {
	const mockLog = log ?? new Logger('MockApp', { level: 'error' });
	// Use type assertion - we only need the properties RequestContext uses
	return {
		log: mockLog,
		config: mockConfigProvider,
		events: undefined,
		onStartup: () => {},
		onReady: () => {},
		onShutdown: () => {},
		resolve: () => {
			throw new Error('Not implemented in mock');
		}
	} as unknown as AppContext;
}

/** Default logger options for tests */
const defaultLoggerOptions = { level: 'error' as const };

/** Helper to create context with the new constructor signature */
function createTestContext(
	request: Request,
	params: Record<string, string> = {},
	appContext?: AppContext
): RequestContext {
	const url = request.url;
	const queryStart = url.indexOf('?');
	return new RequestContext(
		appContext ?? createMockAppContext(),
		request,
		params,
		url,
		queryStart,
		defaultLoggerOptions
	);
}

describe('RequestContext', () => {
	describe('json', () => {
		test('should parse JSON body', async () => {
			const body = { name: 'test', value: 42 };
			const request = new Request('http://localhost/', {
				method: 'POST',
				body: JSON.stringify(body),
				headers: { 'Content-Type': 'application/json' }
			});

			const ctx = createTestContext(request);
			const parsed = await ctx.json();

			expect(parsed).toEqual(body);
		});

		test('should cache parsed body', async () => {
			const body = { cached: true };
			const request = new Request('http://localhost/', {
				method: 'POST',
				body: JSON.stringify(body)
			});

			const ctx = createTestContext(request);
			const first = await ctx.json();
			const second = await ctx.json();

			expect(first).toBe(second);
		});

		test('should throw when calling json() after text()', async () => {
			const request = new Request('http://localhost/', {
				method: 'POST',
				body: 'plain text'
			});

			const ctx = createTestContext(request);
			await ctx.text();

			expect(ctx.json()).rejects.toThrow('Body already parsed as text');
		});
	});

	describe('text', () => {
		test('should parse text body', async () => {
			const request = new Request('http://localhost/', {
				method: 'POST',
				body: 'plain text content'
			});

			const ctx = createTestContext(request);
			const text = await ctx.text();

			expect(text).toBe('plain text content');
		});

		test('should cache parsed text body', async () => {
			const request = new Request('http://localhost/', {
				method: 'POST',
				body: 'text'
			});

			const ctx = createTestContext(request);
			const first = await ctx.text();
			const second = await ctx.text();

			expect(first).toBe(second);
		});

		test('should throw when calling text() after json()', async () => {
			const request = new Request('http://localhost/', {
				method: 'POST',
				body: JSON.stringify({ data: 'test' })
			});

			const ctx = createTestContext(request);
			await ctx.json();

			expect(ctx.text()).rejects.toThrow('Body already parsed as JSON');
		});
	});

	describe('context state', () => {
		test('should allow setting and getting state via set/get', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.set('user', { id: '123' });

			expect(ctx.get('user')).toEqual({ id: '123' });
		});

		test('should allow accessing state via state property', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.set('user', { id: '456' });

			expect(ctx.state.user).toEqual({ id: '456' });
		});

		test('should preserve state across multiple operations', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.set('first', 1);
			ctx.set('second', 2);

			expect(ctx.get('first')).toBe(1);
			expect(ctx.get('second')).toBe(2);
			expect(ctx.state.first).toBe(1);
			expect(ctx.state.second).toBe(2);
		});
	});

	describe('typed state (type safety)', () => {
		// Define a typed state interface for tests
		interface AuthState {
			user: { id: string; name: string };
			token: string;
			permissions: string[];
		}

		/** Helper to create typed context */
		function createTypedContext(request: Request): RequestContext<AuthState> {
			const url = request.url;
			const queryStart = url.indexOf('?');
			return new RequestContext<AuthState>(
				createMockAppContext(),
				request,
				{},
				url,
				queryStart,
				defaultLoggerOptions
			);
		}

		test('should enforce type-safe set with correct value type', () => {
			const request = new Request('http://localhost/');
			const ctx = createTypedContext(request);

			// Type-safe: user must be { id: string; name: string }
			ctx.set('user', { id: '123', name: 'Alice' });
			ctx.set('token', 'jwt-token-xyz');
			ctx.set('permissions', ['read', 'write']);

			expect(ctx.get('user')).toEqual({ id: '123', name: 'Alice' });
			expect(ctx.get('token')).toBe('jwt-token-xyz');
			expect(ctx.get('permissions')).toEqual(['read', 'write']);
		});

		test('should return typed values from get()', () => {
			const request = new Request('http://localhost/');
			const ctx = createTypedContext(request);

			ctx.set('user', { id: '456', name: 'Bob' });

			// Return type is inferred as { id: string; name: string }
			const user = ctx.get('user');
			expect(user.id).toBe('456');
			expect(user.name).toBe('Bob');
		});

		test('should provide typed state object', () => {
			const request = new Request('http://localhost/');
			const ctx = createTypedContext(request);

			ctx.set('user', { id: '789', name: 'Carol' });
			ctx.set('permissions', ['admin']);

			// state property is typed as AuthState
			const { user, permissions } = ctx.state;
			expect(user.id).toBe('789');
			expect(permissions).toContain('admin');
		});

		test('should allow overwriting state with same key', () => {
			const request = new Request('http://localhost/');
			const ctx = createTypedContext(request);

			ctx.set('user', { id: '111', name: 'First' });
			ctx.set('user', { id: '222', name: 'Second' });

			expect(ctx.get('user')).toEqual({ id: '222', name: 'Second' });
		});
	});

	describe('params and query', () => {
		test('should expose params', () => {
			const request = new Request('http://localhost/');
			const params = { id: '123', slug: 'test' };

			const ctx = createTestContext(request, params);

			expect(ctx.params).toEqual(params);
		});

		test('should expose query from query string', () => {
			const request = new Request('http://localhost/?filter=active&page=1');

			const ctx = createTestContext(request);

			expect(ctx.query).toEqual({ filter: 'active', page: '1' });
		});

		test('should default params and query to empty objects', () => {
			const request = new Request('http://localhost/');

			const ctx = createTestContext(request);

			expect(ctx.params).toEqual({});
			expect(ctx.query).toEqual({});
		});
	});

	describe('getValidatedParam', () => {
		test('should return valid alphanumeric param', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { slug: 'my-project-123' });

			expect(ctx.getValidatedParam('slug')).toBe('my-project-123');
		});

		test('should accept hyphens and underscores', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { id: 'abc_123-xyz' });

			expect(ctx.getValidatedParam('id')).toBe('abc_123-xyz');
		});

		test('should throw on missing param', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, {});

			expect(() => ctx.getValidatedParam('missing')).toThrow('Missing required param: missing');
		});

		test('should throw on empty param', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { empty: '' });

			expect(() => ctx.getValidatedParam('empty')).toThrow('Missing required param: empty');
		});

		test('should throw on param exceeding max length', () => {
			const request = new Request('http://localhost/');
			const longValue = 'a'.repeat(257);
			const ctx = createTestContext(request, { long: longValue });

			expect(() => ctx.getValidatedParam('long')).toThrow('exceeds max length');
		});

		test('should accept param at max length', () => {
			const request = new Request('http://localhost/');
			const maxValue = 'a'.repeat(256);
			const ctx = createTestContext(request, { max: maxValue });

			expect(ctx.getValidatedParam('max')).toBe(maxValue);
		});

		test('should throw on invalid characters - space', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { bad: 'hello world' });

			expect(() => ctx.getValidatedParam('bad')).toThrow('Invalid character');
		});

		test('should throw on invalid characters - special', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { bad: 'test@email.com' });

			expect(() => ctx.getValidatedParam('bad')).toThrow('Invalid character');
		});

		test('should throw on path traversal attempt', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { file: '../etc/passwd' });

			expect(() => ctx.getValidatedParam('file')).toThrow('Invalid character');
		});

		test('should throw on SQL injection attempt', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { id: "1'; DROP TABLE users;--" });

			expect(() => ctx.getValidatedParam('id')).toThrow('Invalid character');
		});
	});

	describe('getValidatedUUID', () => {
		test('should return valid UUID', () => {
			const request = new Request('http://localhost/');
			const uuid = '550e8400-e29b-41d4-a716-446655440000';
			const ctx = createTestContext(request, { monitorUuid: uuid });

			expect(ctx.getValidatedUUID('monitorUuid')).toBe(uuid);
		});

		test('should accept uppercase hex characters', () => {
			const request = new Request('http://localhost/');
			const uuid = '550E8400-E29B-41D4-A716-446655440000';
			const ctx = createTestContext(request, { id: uuid });

			expect(ctx.getValidatedUUID('id')).toBe(uuid);
		});

		test('should accept mixed case hex characters', () => {
			const request = new Request('http://localhost/');
			const uuid = '550e8400-E29B-41d4-A716-446655440000';
			const ctx = createTestContext(request, { id: uuid });

			expect(ctx.getValidatedUUID('id')).toBe(uuid);
		});

		test('should throw on missing UUID param', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, {});

			expect(() => ctx.getValidatedUUID('missing')).toThrow('Missing required UUID param: missing');
		});

		test('should throw on empty UUID param', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { uuid: '' });

			expect(() => ctx.getValidatedUUID('uuid')).toThrow('Missing required UUID param: uuid');
		});

		test('should throw on wrong length - too short', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { id: '550e8400-e29b-41d4' });

			expect(() => ctx.getValidatedUUID('id')).toThrow('wrong length');
		});

		test('should throw on wrong length - too long', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { id: '550e8400-e29b-41d4-a716-446655440000-extra' });

			expect(() => ctx.getValidatedUUID('id')).toThrow('wrong length');
		});

		test('should throw on missing dashes', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { id: '550e8400e29b41d4a716446655440000' });

			expect(() => ctx.getValidatedUUID('id')).toThrow('wrong length');
		});

		test('should throw on dashes in wrong positions', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { id: '550e84-00e29b-41d4a-716-446655440000' });

			expect(() => ctx.getValidatedUUID('id')).toThrow('missing dashes');
		});

		test('should throw on invalid hex characters', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { id: '550e8400-e29b-41d4-a716-44665544000g' });

			expect(() => ctx.getValidatedUUID('id')).toThrow('invalid character');
		});

		test('should throw on special characters', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request, { id: "550e8400-e29b-41d4-a716-44665544000'" });

			expect(() => ctx.getValidatedUUID('id')).toThrow('invalid character');
		});
	});

	describe('request', () => {
		test('should expose the original request', () => {
			const request = new Request('http://localhost/test', {
				method: 'POST',
				headers: { 'X-Custom': 'value' }
			});

			const ctx = createTestContext(request);

			expect(ctx.request).toBe(request);
			expect(ctx.request.method).toBe('POST');
			expect(ctx.request.headers.get('X-Custom')).toBe('value');
		});
	});

	describe('app', () => {
		test('should expose the app context', () => {
			const request = new Request('http://localhost/');
			const mockApp = createMockAppContext();

			const ctx = createTestContext(request, {}, mockApp);

			expect(ctx.app).toBe(mockApp);
		});
	});

	describe('log', () => {
		test('should create lazy logger with proper configuration', () => {
			const request = new Request('http://localhost/');

			const ctx = createTestContext(request);

			// Logger is lazily created with the configured options
			const log = ctx.log;
			expect(log).toBeDefined();
			// Verify it's a functional logger by calling a method
			const childLog = log.with({ test: true });
			expect(childLog.propagationMeta().test).toBe(true);
		});

		test('should include correlationId in lazy logger', () => {
			const correlationId = 'test-request-id';
			const request = new Request('http://localhost/', {
				headers: { 'x-request-id': correlationId }
			});

			const ctx = createTestContext(request);

			// The lazy logger should have the correlationId in propagation meta
			expect(ctx.log.propagationMeta().correlationId).toBe(correlationId);
		});

		test('should generate correlationId if not provided in header', () => {
			const request = new Request('http://localhost/');

			const ctx = createTestContext(request);

			// RequestId should be generated (UUID format)
			expect(ctx.correlationId).toMatch(/^[0-9a-f-]{36}$/);
			expect(ctx.log.propagationMeta().correlationId).toBe(ctx.correlationId);
		});
	});

	describe('log.setMeta', () => {
		test('should add metadata to logger context', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.log.setMeta({ userId: 'user-123', accountUuid: 'acc-456' });

			expect(ctx.log.propagationMeta().userId).toBe('user-123');
			expect(ctx.log.propagationMeta().accountUuid).toBe('acc-456');
		});

		test('should preserve correlationId when adding metadata', () => {
			const correlationId = 'test-request-id';
			const request = new Request('http://localhost/', {
				headers: { 'x-request-id': correlationId }
			});

			const ctx = createTestContext(request);
			ctx.log.setMeta({ userId: 'user-123' });

			expect(ctx.log.propagationMeta().correlationId).toBe(correlationId);
			expect(ctx.log.propagationMeta().userId).toBe('user-123');
		});

		test('should allow multiple setMeta calls', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.log.setMeta({ userId: 'user-123' });
			ctx.log.setMeta({ accountUuid: 'acc-456' });

			expect(ctx.log.propagationMeta().userId).toBe('user-123');
			expect(ctx.log.propagationMeta().accountUuid).toBe('acc-456');
		});
	});

	describe('signal', () => {
		test('should expose AbortSignal from request', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			expect(ctx.signal).toBeInstanceOf(AbortSignal);
			expect(ctx.signal).toBe(request.signal);
		});

		test('should start as not aborted', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			expect(ctx.signal.aborted).toBe(false);
		});

		test('should reflect aborted state from AbortController', () => {
			const controller = new AbortController();
			const request = new Request('http://localhost/', {
				signal: controller.signal
			});
			const ctx = createTestContext(request);

			expect(ctx.signal.aborted).toBe(false);

			controller.abort();

			expect(ctx.signal.aborted).toBe(true);
		});

		test('should allow registering abort listener', () => {
			const controller = new AbortController();
			const request = new Request('http://localhost/', {
				signal: controller.signal
			});
			const ctx = createTestContext(request);

			let abortCalled = false;
			ctx.signal.addEventListener('abort', () => {
				abortCalled = true;
			});

			controller.abort();

			expect(abortCalled).toBe(true);
		});

		test('should provide abort reason when aborted with reason', () => {
			const controller = new AbortController();
			const request = new Request('http://localhost/', {
				signal: controller.signal
			});
			const ctx = createTestContext(request);

			const reason = new Error('Client disconnected');
			controller.abort(reason);

			expect(ctx.signal.aborted).toBe(true);
			expect(ctx.signal.reason).toBe(reason);
		});

		test('should cancel long-running operation when aborted', async () => {
			const controller = new AbortController();
			const request = new Request('http://localhost/', {
				signal: controller.signal
			});
			const ctx = createTestContext(request);

			// Simulate a long-running operation that respects AbortSignal
			const longRunningOperation = async (signal: AbortSignal): Promise<string> => {
				// Check if already aborted
				if (signal.aborted) {
					throw new DOMException('Operation cancelled', 'AbortError');
				}

				return new Promise((resolve, reject) => {
					const timeout = setTimeout(() => resolve('completed'), 5000);

					signal.addEventListener('abort', () => {
						clearTimeout(timeout);
						reject(new DOMException('Operation cancelled', 'AbortError'));
					});
				});
			};

			// Start the operation
			const operationPromise = longRunningOperation(ctx.signal);

			// Abort after a short delay (simulating client disconnect)
			setTimeout(() => controller.abort(), 10);

			// Verify the operation was cancelled
			await expect(operationPromise).rejects.toThrow('Operation cancelled');
		});

		test('should allow checking signal.aborted in processing loop', async () => {
			const controller = new AbortController();
			const request = new Request('http://localhost/', {
				signal: controller.signal
			});
			const ctx = createTestContext(request);

			const processedItems: number[] = [];

			// Simulate processing items in a loop that checks for cancellation
			const processItems = async (items: number[], signal: AbortSignal): Promise<number[]> => {
				for (const item of items) {
					if (signal.aborted) {
						break; // Stop processing on cancellation
					}
					// Simulate async work
					await new Promise((resolve) => setTimeout(resolve, 5));
					processedItems.push(item);
				}
				return processedItems;
			};

			// Start processing 100 items
			const items = Array.from({ length: 100 }, (_, i) => i);
			const processingPromise = processItems(items, ctx.signal);

			// Abort after processing some items
			setTimeout(() => controller.abort(), 25);

			const result = await processingPromise;

			// Should have processed some items but not all
			expect(result.length).toBeGreaterThan(0);
			expect(result.length).toBeLessThan(100);
		});
	});

	describe('socket', () => {
		describe('generic type parameter', () => {
			test('should accept TSocket generic parameter for type-safe socket access', () => {
				// Define a custom emitter that extends SocketEmitter
				interface CustomSocketEmitter extends SocketEmitter {
					emitToAccount(accountUuid: string, event: string, payload: unknown): void;
					customMethod(): string;
				}

				const mockSocketEmitter: SocketEmitter = {
					publish: () => Promise.resolve(),
					send: () => true,
					broadcast: () => {},
					emit: () => Promise.resolve()
				};
				const mockApp = {
					...createMockAppContext(),
					socket: mockSocketEmitter
				} as unknown as AppContext;
				const request = new Request('http://localhost/');

				// Create context with custom socket type
				// Note: The second generic parameter is for TSocket
				const ctx = new RequestContext<Record<string, unknown>, CustomSocketEmitter>(
					mockApp,
					request,
					{},
					request.url,
					-1,
					defaultLoggerOptions
				);

				// The socket getter returns TSocket type
				// At runtime it's RequestBoundSocketEmitter, but TypeScript sees CustomSocketEmitter
				const socket = ctx.socket;

				// Base SocketEmitter methods should work (these are implemented by RequestBoundSocketEmitter)
				expect(typeof socket.publish).toBe('function');
				expect(typeof socket.send).toBe('function');
				expect(typeof socket.broadcast).toBe('function');

				// Runtime type is still RequestBoundSocketEmitter for correlation binding
				expect(socket).toBeInstanceOf(RequestBoundSocketEmitter);
			});

			test('should default to SocketEmitter when no TSocket generic provided', () => {
				const mockSocketEmitter: SocketEmitter = {
					publish: () => Promise.resolve(),
					send: () => true,
					broadcast: () => {},
					emit: () => Promise.resolve()
				};
				const mockApp = {
					...createMockAppContext(),
					socket: mockSocketEmitter
				} as unknown as AppContext;
				const request = new Request('http://localhost/');

				// Default usage without generic parameter
				const ctx = createTestContext(request, {}, mockApp);
				const socket = ctx.socket;

				// Should have SocketEmitter methods
				expect(typeof socket.publish).toBe('function');
				expect(typeof socket.send).toBe('function');
				expect(typeof socket.broadcast).toBe('function');
			});
		});

		test('should return request-bound socket emitter with correlation ID', () => {
			const mockSocketEmitter: SocketEmitter = {
				publish: () => Promise.resolve(),
				send: () => true,
				broadcast: () => {},
				emit: () => Promise.resolve()
			};
			const mockApp = {
				...createMockAppContext(),
				socket: mockSocketEmitter
			} as unknown as AppContext;
			const request = new Request('http://localhost/', {
				headers: { 'x-request-id': 'test-correlation-123' }
			});

			const ctx = createTestContext(request, {}, mockApp);
			const socket = ctx.socket;

			expect(socket).toBeInstanceOf(RequestBoundSocketEmitter);
			expect((socket as RequestBoundSocketEmitter).correlationId).toBe('test-correlation-123');
		});

		test('should cache socket emitter on repeated access', () => {
			const mockSocketEmitter: SocketEmitter = {
				publish: () => Promise.resolve(),
				send: () => true,
				broadcast: () => {},
				emit: () => Promise.resolve()
			};
			const mockApp = {
				...createMockAppContext(),
				socket: mockSocketEmitter
			} as unknown as AppContext;
			const request = new Request('http://localhost/');

			const ctx = createTestContext(request, {}, mockApp);

			const firstAccess = ctx.socket;
			const secondAccess = ctx.socket;

			expect(firstAccess).toBe(secondAccess);
		});

		test('should throw when WebSocket not configured', () => {
			const mockApp = {
				...createMockAppContext(),
				get socket(): SocketEmitter {
					throw new Error('WebSocket not configured. Call .websocket() when creating the application.');
				}
			} as unknown as AppContext;
			const request = new Request('http://localhost/');

			const ctx = createTestContext(request, {}, mockApp);

			expect(() => ctx.socket).toThrow('WebSocket not configured');
		});

		test('should delegate publish to underlying emitter', () => {
			let publishedTopic: string | undefined;
			let publishedMessage: string | ArrayBuffer | undefined;
			const mockSocketEmitter: SocketEmitter = {
				publish: (topic, message) => {
					publishedTopic = topic;
					publishedMessage = message;
					return Promise.resolve();
				},
				send: () => true,
				broadcast: () => {},
				emit: () => Promise.resolve()
			};
			const mockApp = {
				...createMockAppContext(),
				socket: mockSocketEmitter
			} as unknown as AppContext;
			const request = new Request('http://localhost/');

			const ctx = createTestContext(request, {}, mockApp);
			ctx.socket.publish('user:456', JSON.stringify({ type: 'notification' }));

			expect(publishedTopic).toBe('user:456');
			expect(publishedMessage).toBe(JSON.stringify({ type: 'notification' }));
		});
	});

	describe('response headers', () => {
		test('should return null when no response headers set', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			expect(ctx.getResponseHeaders()).toBeNull();
		});

		test('should store and retrieve a single response header', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.setResponseHeader('X-RateLimit-Remaining', '42');

			const headers = ctx.getResponseHeaders();
			expect(headers).toEqual([['X-RateLimit-Remaining', '42']]);
		});

		test('should store multiple response headers', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.setResponseHeader('X-RateLimit-Remaining', '42');
			ctx.setResponseHeader('X-RateLimit-Reset', '1700000000');
			ctx.setResponseHeader('X-Custom', 'value');

			const headers = ctx.getResponseHeaders();
			expect(headers).toHaveLength(3);
			expect(headers).toEqual([
				['X-RateLimit-Remaining', '42'],
				['X-RateLimit-Reset', '1700000000'],
				['X-Custom', 'value']
			]);
		});

		test('should not interfere with state data', () => {
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.set('user', { id: '123' });
			ctx.setResponseHeader('X-Custom', 'value');

			expect(ctx.get('user')).toEqual({ id: '123' });
			expect(ctx.getResponseHeaders()).toEqual([['X-Custom', 'value']]);
		});
	});

	describe('route data (get with RouteKey)', () => {
		test('should return value for set route key', () => {
			const key = createRouteKey<number>('Limit');
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			const data = new Map<symbol, unknown>([[key, 42]]);
			ctx.setRouteData(data);

			expect(ctx.get(key)).toBe(42);
		});

		test('should return undefined for unset route key', () => {
			const key = createRouteKey<string>('Missing');
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			expect(ctx.get(key)).toBeUndefined();
		});

		test('should return undefined when no route data injected', () => {
			const key = createRouteKey<string>('NoData');
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			expect(ctx.get(key)).toBeUndefined();
		});

		test('should not interfere with string-key state', () => {
			const routeKey = createRouteKey<number>('Config');
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			ctx.set('user', { id: '123' });
			ctx.setRouteData(new Map<symbol, unknown>([[routeKey, 99]]));

			expect(ctx.get('user')).toEqual({ id: '123' });
			expect(ctx.get(routeKey)).toBe(99);
		});

		test('should handle multiple route keys', () => {
			const limitKey = createRouteKey<number>('Limit');
			const tagKey = createRouteKey<string>('Tag');
			const request = new Request('http://localhost/');
			const ctx = createTestContext(request);

			const data = new Map<symbol, unknown>([
				[limitKey, 100],
				[tagKey, 'auth']
			]);
			ctx.setRouteData(data);

			expect(ctx.get(limitKey)).toBe(100);
			expect(ctx.get(tagKey)).toBe('auth');
		});
	});
});

describe('parseQuery', () => {
	test('should parse query parameters', () => {
		const url = new URL('http://localhost/?name=test&count=5');

		const query = parseQuery(url);

		expect(query).toEqual({ name: 'test', count: '5' });
	});

	test('should return empty object for no query', () => {
		const url = new URL('http://localhost/');

		const query = parseQuery(url);

		expect(query).toEqual({});
	});

	test('should handle duplicate keys as array', () => {
		const url = new URL('http://localhost/?tag=a&tag=b&tag=c');

		const query = parseQuery(url);

		expect(query.tag).toEqual(['a', 'b', 'c']);
	});

	test('should handle mixed single and duplicate keys', () => {
		const url = new URL('http://localhost/?single=one&multi=a&multi=b');

		const query = parseQuery(url);

		expect(query.single).toBe('one');
		expect(query.multi).toEqual(['a', 'b']);
	});

	test('should handle URL encoded values', () => {
		const url = new URL('http://localhost/?message=hello%20world&special=%26%3D');

		const query = parseQuery(url);

		expect(query.message).toBe('hello world');
		expect(query.special).toBe('&=');
	});
});
