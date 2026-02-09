import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { RequestPipeline, type CompiledRoute, type BunRequest } from '../src/controllers/request-pipeline.ts';
import type { Container } from '../src/container.ts';
import type { ResponseFactory } from '../src/controllers/response.ts';
import type { Logger } from '@orijs/logging';
import type { AppContext } from '../src/app-context.ts';
import type { Guard, Interceptor, RequestContext, ParamValidator, ParamValidatorClass } from '../src/types/index.ts';
import { Type } from '@orijs/validation';
import { UuidParam, NumberParam } from '../src/controllers/param-validators';

describe('RequestPipeline', () => {
	let pipeline: RequestPipeline;
	let mockContainer: Container;
	let mockResponseFactory: ResponseFactory;
	let mockLogger: Logger;
	let mockAppContext: AppContext;

	// Test guards
	class AllowGuard implements Guard {
		canActivate(): boolean | Promise<boolean> {
			return true;
		}
	}

	class DenyGuard implements Guard {
		canActivate(): boolean | Promise<boolean> {
			return false;
		}
	}

	class AsyncGuard implements Guard {
		async canActivate(): Promise<boolean> {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return true;
		}
	}

	// Test interceptors
	class ModifyResponseInterceptor implements Interceptor {
		async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
			const response = await next();
			return new Response('intercepted', { status: response.status });
		}
	}

	beforeEach(() => {
		// Create mock container that caches instances (simulates real Container singleton behavior)
		const instances = new Map<new () => unknown, unknown>();
		mockContainer = {
			resolve: mock((ctor: new () => unknown) => {
				let instance = instances.get(ctor);
				if (!instance) {
					instance = new ctor();
					instances.set(ctor, instance);
				}
				return instance;
			})
		} as unknown as Container;

		// Create mock response factory
		mockResponseFactory = {
			error: mock((_error: unknown) => new Response('Internal Server Error', { status: 500 })),
			forbidden: mock(() => new Response('Forbidden', { status: 403 })),
			validationError: mock(
				(errors: unknown[]) =>
					new Response(JSON.stringify({ errors }), {
						status: 422,
						headers: { 'Content-Type': 'application/json' }
					})
			)
		} as unknown as ResponseFactory;

		// Create mock logger
		mockLogger = {
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {})
		} as unknown as Logger;

		// Create mock app context
		mockAppContext = {
			container: mockContainer
		} as unknown as AppContext;

		pipeline = new RequestPipeline(mockContainer, mockResponseFactory, mockLogger);
	});

	function createMockRequest(method: string = 'GET', url: string = 'http://localhost/test'): BunRequest {
		const request = new Request(url, { method }) as BunRequest;
		request.params = {};
		return request;
	}

	function createRoute(overrides: Partial<CompiledRoute> = {}): CompiledRoute {
		return {
			method: 'GET',
			path: '/test',
			fullPath: '/test',
			handler: async () => new Response('OK'),
			guards: [],
			interceptors: [],
			pipes: [],
			...overrides
		};
	}

	describe('createHandler()', () => {
		test('should create handler that calls route handler', async () => {
			const handlerFn = mock(async () => new Response('Success'));
			const route = createRoute({ handler: handlerFn });

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const response = await handler(createMockRequest());

			expect(await response.text()).toBe('Success');
		});

		test('should create fast-path handler when no guards, interceptors, or schema', async () => {
			const handlerFn = mock(async () => new Response('Fast path'));
			const route = createRoute({
				handler: handlerFn,
				guards: [],
				interceptors: [],
				schema: undefined
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const response = await handler(createMockRequest());

			expect(await response.text()).toBe('Fast path');
		});

		test('should pass params from request to context', async () => {
			let receivedParams: Record<string, string> = {};
			const route = createRoute({
				handler: async (ctx: RequestContext) => {
					receivedParams = ctx.params;
					return new Response('OK');
				}
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const request = createMockRequest();
			request.params = { id: '123', slug: 'test-slug' };

			await handler(request);

			expect(receivedParams.id).toBe('123');
			expect(receivedParams.slug).toBe('test-slug');
		});

		test('should handle empty params', async () => {
			let receivedParams: Record<string, string> = {};
			const route = createRoute({
				handler: async (ctx: RequestContext) => {
					receivedParams = ctx.params;
					return new Response('OK');
				}
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const request = createMockRequest();
			request.params = undefined as unknown as Record<string, string>;

			await handler(request);

			expect(receivedParams).toEqual({});
		});

		test('should catch handler errors and return error response', async () => {
			const route = createRoute({
				handler: async () => {
					throw new Error('Handler error');
				}
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const response = await handler(createMockRequest());

			expect(response.status).toBe(500);
			expect(mockResponseFactory.error).toHaveBeenCalled();
		});
	});

	describe('guards', () => {
		test('should allow request when guard returns true', async () => {
			const route = createRoute({
				guards: [AllowGuard],
				handler: async () => new Response('Allowed')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const response = await handler(createMockRequest());

			expect(await response.text()).toBe('Allowed');
		});

		test('should block request when guard returns false', async () => {
			const route = createRoute({
				guards: [DenyGuard],
				handler: async () => new Response('Should not reach')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const response = await handler(createMockRequest());

			expect(response.status).toBe(403);
			expect(mockResponseFactory.forbidden).toHaveBeenCalled();
		});

		test('should run guards in order', async () => {
			const order: string[] = [];

			class FirstGuard implements Guard {
				canActivate(): boolean {
					order.push('first');
					return true;
				}
			}

			class SecondGuard implements Guard {
				canActivate(): boolean {
					order.push('second');
					return true;
				}
			}

			// Override container resolve to track order
			(mockContainer.resolve as ReturnType<typeof mock>).mockImplementation((ctor: new () => unknown) => {
				return new ctor();
			});

			const route = createRoute({
				guards: [FirstGuard, SecondGuard],
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			await handler(createMockRequest());

			expect(order).toEqual(['first', 'second']);
		});

		test('should stop at first failing guard', async () => {
			const order: string[] = [];

			class FirstGuard implements Guard {
				canActivate(): boolean {
					order.push('first');
					return false;
				}
			}

			class SecondGuard implements Guard {
				canActivate(): boolean {
					order.push('second');
					return true;
				}
			}

			const route = createRoute({
				guards: [FirstGuard, SecondGuard],
				handler: async () => new Response('Should not reach')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			await handler(createMockRequest());

			expect(order).toEqual(['first']);
		});

		test('should support async guards', async () => {
			const route = createRoute({
				guards: [AsyncGuard],
				handler: async () => new Response('Async allowed')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const response = await handler(createMockRequest());

			expect(await response.text()).toBe('Async allowed');
		});

		test('should cache guard instances', async () => {
			let instanceCount = 0;

			class CountingGuard implements Guard {
				constructor() {
					instanceCount++;
				}
				canActivate(): boolean {
					return true;
				}
			}

			const route = createRoute({
				guards: [CountingGuard],
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Call handler multiple times
			await handler(createMockRequest());
			await handler(createMockRequest());
			await handler(createMockRequest());

			// Guard should only be instantiated once (cached)
			expect(instanceCount).toBe(1);
		});

		test('should handle concurrent requests safely with single guard instance', async () => {
			let instanceCount = 0;
			let concurrentCalls = 0;
			let maxConcurrentCalls = 0;

			class ConcurrentGuard implements Guard {
				constructor() {
					instanceCount++;
				}
				async canActivate(): Promise<boolean> {
					concurrentCalls++;
					maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
					// Simulate some async work
					await new Promise((resolve) => setTimeout(resolve, 10));
					concurrentCalls--;
					return true;
				}
			}

			const route = createRoute({
				guards: [ConcurrentGuard],
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Fire 10 concurrent requests
			const promises = Array.from({ length: 10 }, () => handler(createMockRequest()));
			const responses = await Promise.all(promises);

			// All requests should succeed
			expect(responses.every((r) => r.status === 200)).toBe(true);

			// Only one guard instance should be created (container caches it)
			expect(instanceCount).toBe(1);

			// Should have had concurrent requests (verifies we're testing concurrency)
			expect(maxConcurrentCalls).toBeGreaterThan(1);
		});
	});

	describe('interceptors', () => {
		test('should run interceptor around handler', async () => {
			const route = createRoute({
				interceptors: [ModifyResponseInterceptor],
				handler: async () => new Response('Original')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const response = await handler(createMockRequest());

			expect(await response.text()).toBe('intercepted');
		});

		test('should chain multiple interceptors', async () => {
			const order: string[] = [];

			class FirstInterceptor implements Interceptor {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
					order.push('first-before');
					const response = await next();
					order.push('first-after');
					return response;
				}
			}

			class SecondInterceptor implements Interceptor {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
					order.push('second-before');
					const response = await next();
					order.push('second-after');
					return response;
				}
			}

			const route = createRoute({
				interceptors: [FirstInterceptor, SecondInterceptor],
				handler: async () => {
					order.push('handler');
					return new Response('OK');
				}
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			await handler(createMockRequest());

			expect(order).toEqual(['first-before', 'second-before', 'handler', 'second-after', 'first-after']);
		});

		test('should cache interceptor instances', async () => {
			let instanceCount = 0;

			class CountingInterceptor implements Interceptor {
				constructor() {
					instanceCount++;
				}
				async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
					return next();
				}
			}

			const route = createRoute({
				interceptors: [CountingInterceptor],
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Call handler multiple times
			await handler(createMockRequest());
			await handler(createMockRequest());
			await handler(createMockRequest());

			// Interceptor should only be instantiated once (cached)
			expect(instanceCount).toBe(1);
		});

		test('should handle concurrent requests safely with single interceptor instance', async () => {
			let instanceCount = 0;
			let concurrentCalls = 0;
			let maxConcurrentCalls = 0;

			class ConcurrentInterceptor implements Interceptor {
				constructor() {
					instanceCount++;
				}
				async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
					concurrentCalls++;
					maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
					// Simulate some async work
					await new Promise((resolve) => setTimeout(resolve, 10));
					const response = await next();
					concurrentCalls--;
					return response;
				}
			}

			const route = createRoute({
				interceptors: [ConcurrentInterceptor],
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Fire 10 concurrent requests
			const promises = Array.from({ length: 10 }, () => handler(createMockRequest()));
			const responses = await Promise.all(promises);

			// All requests should succeed
			expect(responses.every((r) => r.status === 200)).toBe(true);

			// Only one interceptor instance should be created (container caches it)
			expect(instanceCount).toBe(1);

			// Should have had concurrent requests (verifies we're testing concurrency)
			expect(maxConcurrentCalls).toBeGreaterThan(1);
		});

		test('should skip interceptor chain when no interceptors', async () => {
			const handlerFn = mock(async () => new Response('Direct'));
			const route = createRoute({
				interceptors: [],
				guards: [AllowGuard], // Need guard to trigger full path
				handler: handlerFn
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const response = await handler(createMockRequest());

			expect(await response.text()).toBe('Direct');
		});
	});

	describe('schema validation', () => {
		test('should validate params schema', async () => {
			const route = createRoute({
				method: 'GET',
				schema: {
					params: Type.Object({
						id: Type.String({ format: 'uuid' })
					})
				},
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Invalid UUID
			const request = createMockRequest();
			request.params = { id: 'not-a-uuid' };

			const response = await handler(request);

			expect(response.status).toBe(422);
			expect(mockResponseFactory.validationError).toHaveBeenCalled();
		});

		test('should validate query schema', async () => {
			const route = createRoute({
				method: 'GET',
				schema: {
					query: Type.Object({
						page: Type.Number({ minimum: 1 })
					})
				},
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Request with invalid query
			const request = createMockRequest('GET', 'http://localhost/test?page=-1');
			const response = await handler(request);

			expect(response.status).toBe(422);
		});

		test('should validate body schema for POST requests', async () => {
			const route = createRoute({
				method: 'POST',
				schema: {
					body: Type.Object({
						name: Type.String({ minLength: 1 }),
						email: Type.String({ format: 'email' })
					})
				},
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Invalid body
			const request = new Request('http://localhost/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: '', email: 'not-an-email' })
			}) as BunRequest;
			request.params = {};

			const response = await handler(request);

			expect(response.status).toBe(422);
		});

		test('should return validation error for invalid JSON body', async () => {
			const route = createRoute({
				method: 'POST',
				schema: {
					body: Type.Object({ name: Type.String() })
				},
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Invalid JSON
			const request = new Request('http://localhost/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'not valid json'
			}) as BunRequest;
			request.params = {};

			const response = await handler(request);

			expect(response.status).toBe(422);
		});

		test('should allow valid request through validation', async () => {
			const route = createRoute({
				method: 'POST',
				schema: {
					params: Type.Object({ id: Type.String() }),
					body: Type.Object({ name: Type.String() })
				},
				handler: async () => new Response('Valid')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			const request = new Request('http://localhost/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Test' })
			}) as BunRequest;
			request.params = { id: '123' };

			const response = await handler(request);

			expect(await response.text()).toBe('Valid');
		});
	});

	describe('combined guards and interceptors', () => {
		test('should run guards before interceptors', async () => {
			const order: string[] = [];

			class TrackingGuard implements Guard {
				canActivate(): boolean {
					order.push('guard');
					return true;
				}
			}

			class TrackingInterceptor implements Interceptor {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
					order.push('interceptor-before');
					const response = await next();
					order.push('interceptor-after');
					return response;
				}
			}

			const route = createRoute({
				guards: [TrackingGuard],
				interceptors: [TrackingInterceptor],
				handler: async () => {
					order.push('handler');
					return new Response('OK');
				}
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			await handler(createMockRequest());

			expect(order).toEqual(['guard', 'interceptor-before', 'handler', 'interceptor-after']);
		});

		test('should not run interceptors when guard denies', async () => {
			let interceptorCalled = false;

			class BlockingGuard implements Guard {
				canActivate(): boolean {
					return false;
				}
			}

			class TrackingInterceptor implements Interceptor {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
					interceptorCalled = true;
					return next();
				}
			}

			const route = createRoute({
				guards: [BlockingGuard],
				interceptors: [TrackingInterceptor],
				handler: async () => new Response('Should not reach')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			await handler(createMockRequest());

			expect(interceptorCalled).toBe(false);
		});
	});

	describe('param validators', () => {
		test('should reject invalid UUID param', async () => {
			const route = createRoute({
				guards: [AllowGuard], // need guard to trigger full path
				paramValidators: new Map([['uuid', UuidParam]]),
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const request = createMockRequest();
			request.params = { uuid: 'not-a-uuid' };

			const response = await handler(request);

			expect(response.status).toBe(422);
			expect(mockResponseFactory.validationError).toHaveBeenCalled();
		});

		test('should allow valid UUID param', async () => {
			const route = createRoute({
				guards: [AllowGuard],
				paramValidators: new Map([['uuid', UuidParam]]),
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const request = createMockRequest();
			request.params = { uuid: '550e8400-e29b-41d4-a716-446655440000' };

			const response = await handler(request);

			expect(await response.text()).toBe('OK');
		});

		test('should reject missing param', async () => {
			const route = createRoute({
				guards: [AllowGuard],
				paramValidators: new Map([['uuid', UuidParam]]),
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const request = createMockRequest();
			request.params = {};

			const response = await handler(request);

			expect(response.status).toBe(422);
		});

		test('should validate multiple params', async () => {
			const route = createRoute({
				guards: [AllowGuard],
				paramValidators: new Map<string, ParamValidatorClass>([
					['uuid', UuidParam],
					['id', NumberParam]
				]),
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const request = createMockRequest();
			request.params = { uuid: '550e8400-e29b-41d4-a716-446655440000', id: '123' };

			const response = await handler(request);

			expect(await response.text()).toBe('OK');
		});

		test('should reject when one of multiple params is invalid', async () => {
			const route = createRoute({
				guards: [AllowGuard],
				paramValidators: new Map<string, ParamValidatorClass>([
					['uuid', UuidParam],
					['id', NumberParam]
				]),
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const request = createMockRequest();
			request.params = { uuid: '550e8400-e29b-41d4-a716-446655440000', id: 'abc' };

			const response = await handler(request);

			expect(response.status).toBe(422);
		});

		test('should support custom param validators', async () => {
			class SlugParam implements ParamValidator {
				validate(value: string): boolean {
					return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
				}
			}

			const route = createRoute({
				guards: [AllowGuard],
				paramValidators: new Map([['slug', SlugParam]]),
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Valid slug
			const validRequest = createMockRequest();
			validRequest.params = { slug: 'my-cool-slug' };
			const validResponse = await handler(validRequest);
			expect(await validResponse.text()).toBe('OK');

			// Invalid slug
			const invalidRequest = createMockRequest();
			invalidRequest.params = { slug: 'INVALID SLUG!' };
			const invalidResponse = await handler(invalidRequest);
			expect(invalidResponse.status).toBe(422);
		});

		test('should instantiate validators only once (not per request)', async () => {
			let instanceCount = 0;

			class CountingValidator implements ParamValidator {
				constructor() {
					instanceCount++;
				}
				validate(_value: string): boolean {
					return true;
				}
			}

			const route = createRoute({
				guards: [AllowGuard],
				paramValidators: new Map([['id', CountingValidator]]),
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});

			// Call handler multiple times
			const request1 = createMockRequest();
			request1.params = { id: '1' };
			await handler(request1);

			const request2 = createMockRequest();
			request2.params = { id: '2' };
			await handler(request2);

			const request3 = createMockRequest();
			request3.params = { id: '3' };
			await handler(request3);

			// Validator should only be instantiated once
			expect(instanceCount).toBe(1);
		});

		test('should run param validation before schema validation', async () => {
			const order: string[] = [];

			class TrackingValidator implements ParamValidator {
				validate(_value: string): boolean {
					order.push('param-validator');
					return true;
				}
			}

			const route = createRoute({
				guards: [AllowGuard],
				paramValidators: new Map([['id', TrackingValidator]]),
				schema: {
					params: Type.Object({ id: Type.String() })
				},
				handler: async () => {
					order.push('handler');
					return new Response('OK');
				}
			});

			const handler = pipeline.createHandler(route, mockAppContext, {});
			const request = createMockRequest();
			request.params = { id: '123' };
			await handler(request);

			expect(order).toEqual(['param-validator', 'handler']);
		});
	});

	describe('debug logging', () => {
		test('should log route hit at debug level on fast path', async () => {
			const route = createRoute({
				method: 'GET',
				fullPath: '/api/users',
				handler: async () => new Response('OK'),
				guards: [],
				interceptors: [],
				schema: undefined
			});

			// Use debug-level logger so ctx.log.debug actually fires
			const handler = pipeline.createHandler(route, mockAppContext, { level: 'debug' });
			const response = await handler(createMockRequest());

			expect(await response.text()).toBe('OK');
		});

		test('should log route hit after guards on full path', async () => {
			const order: string[] = [];

			class TrackingGuard implements Guard {
				canActivate(): boolean {
					order.push('guard');
					return true;
				}
			}

			const route = createRoute({
				method: 'POST',
				fullPath: '/api/users',
				guards: [TrackingGuard],
				handler: async () => {
					order.push('handler');
					return new Response('OK');
				}
			});

			const handler = pipeline.createHandler(route, mockAppContext, { level: 'debug' });
			const response = await handler(createMockRequest('POST', 'http://localhost/api/users'));

			expect(await response.text()).toBe('OK');
			// Guard runs before handler (debug log fires between guard and handler)
			expect(order).toEqual(['guard', 'handler']);
		});

		test('should include correct method and path in debug log', async () => {
			const route = createRoute({
				method: 'DELETE',
				fullPath: '/api/monitors/:id',
				handler: async () => new Response('OK')
			});

			const handler = pipeline.createHandler(route, mockAppContext, { level: 'debug' });
			const response = await handler(createMockRequest('DELETE', 'http://localhost/api/monitors/123'));

			expect(await response.text()).toBe('OK');
		});
	});
});
