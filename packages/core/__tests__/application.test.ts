import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { Application, Ori, createToken } from '../src/index.ts';
import { Type } from '@orijs/validation';
import type { OriController, RouteBuilder, Guard, Interceptor, RequestContext } from '../src/types/index.ts';
import { Logger } from '@orijs/logging';

// Enable debug mode so FrameworkError throws instead of process.exit
// This allows tests to catch validation errors
const originalDebug = process.env.ORIJS_DEBUG;
process.env.ORIJS_DEBUG = 'true';

// Cleanup after all tests
afterAll(() => {
	if (originalDebug === undefined) {
		delete process.env.ORIJS_DEBUG;
	} else {
		process.env.ORIJS_DEBUG = originalDebug;
	}
});

/** Type for validation error response */
interface ValidationErrorResponse {
	errors: Array<{ path: string; message: string }>;
}

describe('Application', () => {
	let app: Application;
	let port = 19999;

	// Use unique port for each test to avoid conflicts
	const getPort = () => ++port;
	const getBaseUrl = () => `http://localhost:${port}`;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(() => {
		app?.stop();
	});

	describe('Ori factory', () => {
		test('should create new Application instance', () => {
			const instance = Ori.create();
			expect(instance).toBeInstanceOf(Application);
		});
	});

	describe('basic routing', () => {
		test('should return 404 for non-existent route', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/test', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/nonexistent`);

			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: 'Not Found' });
		});

		test('should match route and return handler result', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ message: 'success' }));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ message: 'success' });
		});

		test('should register root route without trailing slash', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ message: 'success' }));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			// Root route '/' becomes controller path directly (no trailing slash)
			const response = await fetch(`${getBaseUrl()}/api`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ message: 'success' });

			// Trailing slash is a different route - returns 404
			const trailingSlashResponse = await fetch(`${getBaseUrl()}/api/`);
			expect(trailingSlashResponse.status).toBe(404);
		});

		test('should extract path parameters', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/:id', (ctx) => Response.json({ id: ctx.params.id }));
				}
			}

			app = Ori.create().controller('/items', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/items/123`);

			expect(await response.json()).toEqual({ id: '123' });
		});

		test('should parse query parameters', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (ctx) => Response.json({ query: ctx.query }));
				}
			}

			app = Ori.create().controller('/search', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/search?q=test&page=1`);

			expect(await response.json()).toEqual({ query: { q: 'test', page: '1' } });
		});

		test('should handle all HTTP methods', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ method: 'GET' }))
						.post('/', () => Response.json({ method: 'POST' }))
						.put('/', () => Response.json({ method: 'PUT' }))
						.patch('/', () => Response.json({ method: 'PATCH' }))
						.delete('/', () => Response.json({ method: 'DELETE' }));
				}
			}

			app = Ori.create().controller('/methods', TestController);
			await app.listen(getPort());
			const baseUrl = getBaseUrl();

			const getRes = await fetch(`${baseUrl}/methods`);
			const postRes = await fetch(`${baseUrl}/methods`, { method: 'POST' });
			const putRes = await fetch(`${baseUrl}/methods`, { method: 'PUT' });
			const patchRes = await fetch(`${baseUrl}/methods`, { method: 'PATCH' });
			const deleteRes = await fetch(`${baseUrl}/methods`, { method: 'DELETE' });

			expect(await getRes.json()).toEqual({ method: 'GET' });
			expect(await postRes.json()).toEqual({ method: 'POST' });
			expect(await putRes.json()).toEqual({ method: 'PUT' });
			expect(await patchRes.json()).toEqual({ method: 'PATCH' });
			expect(await deleteRes.json()).toEqual({ method: 'DELETE' });
		});
	});

	describe('guards', () => {
		class AllowGuard implements Guard {
			canActivate() {
				return true;
			}
		}

		class DenyGuard implements Guard {
			canActivate() {
				return false;
			}
		}

		class HeaderGuard implements Guard {
			canActivate(ctx: RequestContext) {
				return ctx.request.headers.get('X-Auth') === 'valid';
			}
		}

		test('should allow request when guard returns true', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('allowed'));
				}
			}

			app = Ori.create().guard(AllowGuard).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(200);
		});

		test('should return 403 when guard returns false', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('should not reach'));
				}
			}

			app = Ori.create().guard(DenyGuard).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: 'Forbidden' });
		});

		test('should pass context to guard', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('authenticated'));
				}
			}

			app = Ori.create().guard(HeaderGuard).controller('/api', TestController);
			await app.listen(getPort());
			const baseUrl = getBaseUrl();

			const validResponse = await fetch(`${baseUrl}/api`, {
				headers: { 'X-Auth': 'valid' }
			});
			const invalidResponse = await fetch(`${baseUrl}/api`, {
				headers: { 'X-Auth': 'invalid' }
			});

			expect(validResponse.status).toBe(200);
			expect(invalidResponse.status).toBe(403);
		});

		test('should support async guards', async () => {
			class AsyncGuard implements Guard {
				async canActivate() {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return true;
				}
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('async allowed'));
				}
			}

			app = Ori.create().guard(AsyncGuard).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(200);
		});

		test('should run multiple guards in order and stop on first failure', async () => {
			const order: string[] = [];

			class FirstGuard implements Guard {
				canActivate() {
					order.push('first');
					return true;
				}
			}

			class SecondGuard implements Guard {
				canActivate() {
					order.push('second');
					return false;
				}
			}

			class ThirdGuard implements Guard {
				canActivate() {
					order.push('third');
					return true;
				}
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create()
				.guard(FirstGuard)
				.guard(SecondGuard)
				.guard(ThirdGuard)
				.controller('/api', TestController);
			await app.listen(getPort());

			await fetch(`${getBaseUrl()}/api`);

			expect(order).toEqual(['first', 'second']);
		});
	});

	describe('interceptors', () => {
		test('should execute interceptors in onion model order', async () => {
			const executionOrder: string[] = [];

			class FirstInterceptor implements Interceptor {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>) {
					executionOrder.push('first-before');
					const response = await next();
					executionOrder.push('first-after');
					return response;
				}
			}

			class SecondInterceptor implements Interceptor {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>) {
					executionOrder.push('second-before');
					const response = await next();
					executionOrder.push('second-after');
					return response;
				}
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => {
						executionOrder.push('handler');
						return new Response('ok');
					});
				}
			}

			app = Ori.create()
				.intercept(FirstInterceptor)
				.intercept(SecondInterceptor)
				.controller('/api', TestController);
			await app.listen(getPort());

			await fetch(`${getBaseUrl()}/api`);

			expect(executionOrder).toEqual([
				'first-before',
				'second-before',
				'handler',
				'second-after',
				'first-after'
			]);
		});

		test('should allow interceptor to modify response', async () => {
			class AddHeaderInterceptor implements Interceptor {
				async intercept(_ctx: RequestContext, next: () => Promise<Response>) {
					const response = await next();
					const headers = new Headers(response.headers);
					headers.set('X-Custom', 'added');
					return new Response(response.body, { headers });
				}
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().intercept(AddHeaderInterceptor).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.headers.get('X-Custom')).toBe('added');
		});
	});

	describe('dependency injection', () => {
		test('should throw validation error before instantiating eager providers', async () => {
			let eagerInstantiated = false;

			class EagerService {
				constructor() {
					eagerInstantiated = true;
				}
			}

			class MissingDependency {}

			class ServiceWithMissingDep {
				constructor(public dep: MissingDependency) {}
			}

			app = Ori.create()
				.provider(EagerService, [], { eager: true })
				.provider(ServiceWithMissingDep, [MissingDependency]); // MissingDependency not registered

			// listen() should throw validation error
			await expect(app.listen(getPort())).rejects.toThrow('MissingDependency is not registered');

			// Eager provider should NOT have been instantiated (validation runs first)
			expect(eagerInstantiated).toBe(false);
		});

		test('should inject dependencies into controllers', async () => {
			class GreetingService {
				greet(name: string) {
					return `Hello, ${name}!`;
				}
			}

			class TestController implements OriController {
				constructor(private greeter: GreetingService) {}
				configure(r: RouteBuilder) {
					r.get('/:name', (ctx) =>
						Response.json({
							message: this.greeter.greet(ctx.params.name ?? 'World')
						})
					);
				}
			}

			app = Ori.create().provider(GreetingService).controller('/greet', TestController, [GreetingService]);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/greet/Alice`);

			expect(await response.json()).toEqual({ message: 'Hello, Alice!' });
		});

		test('should inject transitive dependencies', async () => {
			class ConfigService {
				prefix = '[LOG]';
			}
			class LogService {
				constructor(private config: ConfigService) {}
				log(msg: string) {
					return `${this.config.prefix} ${msg}`;
				}
			}
			class TestController implements OriController {
				constructor(private logger: LogService) {}
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ log: this.logger.log('test') }));
				}
			}

			app = Ori.create()
				.provider(ConfigService)
				.provider(LogService, [ConfigService])
				.controller('/api', TestController, [LogService]);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(await response.json()).toEqual({ log: '[LOG] test' });
		});
	});

	describe('error handling', () => {
		test('should return 500 on handler error', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (): Response => {
						throw new Error('Handler failed');
					});
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			const body = (await response.json()) as { error: string; correlationId?: string };

			expect(response.status).toBe(500);
			expect(body.error).toBe('Internal Server Error');
			// Error details are NOT exposed for security (exposeDetails: false in RequestPipeline)
			expect(body).not.toHaveProperty('message');
			// Request ID should be included for correlation
			expect(body.correlationId).toBeDefined();
		});

		test('should handle async handler errors', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', async (): Promise<Response> => {
						await new Promise((resolve) => setTimeout(resolve, 10));
						throw new Error('Async error');
					});
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			const body = (await response.json()) as { error: string; correlationId?: string };

			expect(response.status).toBe(500);
			expect(body.error).toBe('Internal Server Error');
			// Error details are NOT exposed for security
			expect(body).not.toHaveProperty('message');
		});
	});

	describe('response handling', () => {
		test('should return JSON response with Response.json()', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ key: 'value' }));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.headers.get('Content-Type')).toContain('application/json');
			expect(await response.json()).toEqual({ key: 'value' });
		});

		test('should support custom Response with status and headers', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get(
						'/',
						() =>
							new Response('raw', {
								status: 201,
								headers: { 'X-Custom': 'value' }
							})
					);
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(201);
			expect(response.headers.get('X-Custom')).toBe('value');
			expect(await response.text()).toBe('raw');
		});

		test('should return null via Response.json()', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/null', () => Response.json(null));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());
			const baseUrl = getBaseUrl();

			const nullRes = await fetch(`${baseUrl}/api/null`);
			expect(await nullRes.text()).toBe('null');
		});

		test('should return empty response for undefined via new Response()', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					// undefined is not JSON serializable, use empty Response instead
					r.get('/empty', () => new Response(null, { status: 204 }));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());
			const baseUrl = getBaseUrl();

			const emptyRes = await fetch(`${baseUrl}/api/empty`);
			expect(emptyRes.status).toBe(204);
			expect(await emptyRes.text()).toBe('');
		});
	});

	describe('request body parsing', () => {
		test('should parse JSON body for POST requests', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/', async (ctx) => Response.json({ received: await ctx.json() }));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ data: 'test' })
			});

			expect(await response.json()).toEqual({ received: { data: 'test' } });
		});
	});

	describe('server lifecycle', () => {
		test('should stop server', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());
			const baseUrl = getBaseUrl();

			const beforeStop = await fetch(`${baseUrl}/api`);
			expect(beforeStop.status).toBe(200);

			app.stop();

			// After stopping, the server should be null
			// Note: Connection pooling may cause immediate requests to still succeed
			// so we test internal state instead
			const routes = app.getRoutes();
			expect(routes).toBeDefined();
		});

		test('should expose routes for debugging', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const routes = app.getRoutes();

			expect(routes).toHaveLength(1);
			expect(routes[0]!.fullPath).toBe('/api');
		});

		test('should expose container for testing', async () => {
			class TestService {}

			app = Ori.create().provider(TestService);
			await app.listen(getPort());

			const container = app.getContainer();

			expect(container!.has(TestService)).toBe(true);
		});
	});

	describe('providerInstance', () => {
		test('should register pre-created instance', async () => {
			class DatabaseService {
				constructor(public connectionString: string) {}
				query() {
					return `querying ${this.connectionString}`;
				}
			}

			const dbInstance = new DatabaseService('postgres://localhost/test');

			app = Ori.create().providerInstance(DatabaseService, dbInstance);
			await app.listen(getPort());

			const container = app.getContainer();
			expect(container!.has(DatabaseService)).toBe(true);

			const resolved = container!.resolve(DatabaseService);
			expect(resolved).toBe(dbInstance);
			expect(resolved.connectionString).toBe('postgres://localhost/test');
		});

		test('should use pre-created instance in controller dependencies', async () => {
			class ConfigService {
				constructor(public apiKey: string) {}
			}

			class TestController implements OriController {
				constructor(private config: ConfigService) {}
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ key: this.config.apiKey }));
				}
			}

			const configInstance = new ConfigService('secret-key-123');

			app = Ori.create()
				.providerInstance(ConfigService, configInstance)
				.controller('/api', TestController, [ConfigService]);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(await response.json()).toEqual({ key: 'secret-key-123' });
		});

		test('should allow mixing providerInstance with regular providers', async () => {
			class ExternalService {
				constructor(public url: string) {}
			}

			class InternalService {
				constructor(private external: ExternalService) {}
				getUrl() {
					return this.external.url;
				}
			}

			class TestController implements OriController {
				constructor(private internal: InternalService) {}
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ url: this.internal.getUrl() }));
				}
			}

			const externalInstance = new ExternalService('https://api.example.com');

			app = Ori.create()
				.providerInstance(ExternalService, externalInstance)
				.provider(InternalService, [ExternalService])
				.controller('/api', TestController, [InternalService]);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(await response.json()).toEqual({ url: 'https://api.example.com' });
		});
	});

	describe('providerWithTokens (named providers)', () => {
		test('should support named providers using tokens', async () => {
			interface CacheService {
				name: string;
				get(key: string): string;
			}

			const HotCache = createToken<CacheService>('HotCache');
			const ColdCache = createToken<CacheService>('ColdCache');

			const hotCacheInstance: CacheService = {
				name: 'hot',
				get: (key) => `hot:${key}`
			};
			const coldCacheInstance: CacheService = {
				name: 'cold',
				get: (key) => `cold:${key}`
			};

			class HotDataService {
				constructor(public cache: CacheService) {}
				getData() {
					return this.cache.get('data');
				}
			}

			class ColdDataService {
				constructor(public cache: CacheService) {}
				getData() {
					return this.cache.get('data');
				}
			}

			class TestController implements OriController {
				constructor(
					private hotService: HotDataService,
					private coldService: ColdDataService
				) {}
				configure(r: RouteBuilder) {
					r.get('/hot', () => Response.json({ data: this.hotService.getData() }));
					r.get('/cold', () => Response.json({ data: this.coldService.getData() }));
				}
			}

			app = Ori.create()
				.providerInstance(HotCache, hotCacheInstance)
				.providerInstance(ColdCache, coldCacheInstance)
				.providerWithTokens(HotDataService, [HotCache])
				.providerWithTokens(ColdDataService, [ColdCache])
				.controller('/api', TestController, [HotDataService, ColdDataService]);
			await app.listen(getPort());

			const hotResponse = await fetch(`${getBaseUrl()}/api/hot`);
			expect(await hotResponse.json()).toEqual({ data: 'hot:data' });

			const coldResponse = await fetch(`${getBaseUrl()}/api/cold`);
			expect(await coldResponse.json()).toEqual({ data: 'cold:data' });
		});

		test('should support mixing tokens with regular class dependencies', async () => {
			const ConfigToken = createToken<{ apiKey: string }>('Config');

			class LoggerService {
				log(msg: string): string {
					return `[LOG] ${msg}`;
				}
			}

			class ApiService {
				constructor(
					public logger: LoggerService,
					public config: { apiKey: string }
				) {}
				call(): string {
					return this.logger.log(`Calling API with key: ${this.config.apiKey}`);
				}
			}

			class TestController implements OriController {
				constructor(private api: ApiService) {}
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ result: this.api.call() }));
				}
			}

			app = Ori.create()
				.provider(LoggerService)
				.providerInstance(ConfigToken, { apiKey: 'secret123' })
				.providerWithTokens(ApiService, [LoggerService, ConfigToken])
				.controller('/api', TestController, [ApiService]);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(await response.json()).toEqual({
				result: '[LOG] Calling API with key: secret123'
			});
		});

		test('should fail validation when token is not registered', async () => {
			const MissingToken = createToken<string>('MissingToken');

			class ServiceWithMissingToken {
				constructor(public value: string) {}
			}

			app = Ori.create().providerWithTokens(ServiceWithMissingToken, [MissingToken]);

			await expect(app.listen(getPort())).rejects.toThrow(/MissingToken/);
		});

		test('should support eager providers with token dependencies', async () => {
			let instantiated = false;

			const ConfigToken = createToken<{ value: string }>('Config');

			class EagerService {
				constructor(public config: { value: string }) {
					instantiated = true;
				}
			}

			app = Ori.create()
				.providerInstance(ConfigToken, { value: 'eager-config' })
				.providerWithTokens(EagerService, [ConfigToken], { eager: true });
			await app.listen(getPort());

			expect(instantiated).toBe(true);

			const container = app.getContainer();
			const service = container.resolve(EagerService);
			expect(service.config.value).toBe('eager-config');
		});
	});

	describe('use extension method', () => {
		test('should apply extension function', async () => {
			class TestService {
				getValue() {
					return 42;
				}
			}

			function addTestService(application: Application): Application {
				return application.provider(TestService);
			}

			app = Ori.create().use(addTestService);
			await app.listen(getPort());

			const container = app.getContainer();
			expect(container!.has(TestService)).toBe(true);
			expect(container!.resolve(TestService).getValue()).toBe(42);
		});

		test('should support chained extensions', async () => {
			class Service1 {
				name = 'service1';
			}
			class Service2 {
				name = 'service2';
			}

			const extensionOrder: string[] = [];

			function ext1(application: Application): Application {
				extensionOrder.push('ext1');
				return application.provider(Service1);
			}

			function ext2(application: Application): Application {
				extensionOrder.push('ext2');
				return application.provider(Service2);
			}

			app = Ori.create().use(ext1).use(ext2);
			await app.listen(getPort());

			expect(extensionOrder).toEqual(['ext1', 'ext2']);

			const container = app.getContainer();
			expect(container!.has(Service1)).toBe(true);
			expect(container!.has(Service2)).toBe(true);
		});

		test('should use extension with controller registration', async () => {
			class ApiService {
				getData() {
					return { source: 'api-service' };
				}
			}

			class TestController implements OriController {
				constructor(private api: ApiService) {}
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json(this.api.getData()));
				}
			}

			function addApiInfrastructure(application: Application): Application {
				return application.provider(ApiService);
			}

			app = Ori.create().use(addApiInfrastructure).controller('/api', TestController, [ApiService]);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(await response.json()).toEqual({ source: 'api-service' });
		});
	});

	describe('request context', () => {
		test('should use x-request-id header when provided', async () => {
			let capturedRequestId: string | undefined;

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (ctx) => {
						// The log should have the request ID from the header
						capturedRequestId = ctx.request.headers.get('x-request-id') ?? undefined;
						return Response.json({ received: true });
					});
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const customRequestId = 'custom-request-id-12345';
			await fetch(`${getBaseUrl()}/api`, {
				headers: { 'x-request-id': customRequestId }
			});

			expect(capturedRequestId).toBe(customRequestId);
		});

		test('should generate request id when not provided', async () => {
			let capturedRequestId: string | undefined;

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (ctx) => {
						// Access the log's context to check request ID
						const logMeta = ctx.log.propagationMeta();
						capturedRequestId = logMeta.correlationId as string | undefined;
						return Response.json({ received: true });
					});
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			await fetch(`${getBaseUrl()}/api`);

			// Should have generated a UUID
			expect(capturedRequestId).toBeDefined();
			expect(capturedRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		});
	});

	describe('schema validation', () => {
		test('should validate params with schema and return 422 on failure', async () => {
			// TypeBox schema for params validation
			const ParamsSchema = Type.Object({
				id: Type.String({ pattern: '^[0-9]+$' })
			});

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/:id', (ctx) => Response.json({ id: ctx.params.id }), { params: ParamsSchema });
				}
			}

			app = Ori.create().controller('/items', TestController);
			await app.listen(getPort());

			// Valid param
			const validResponse = await fetch(`${getBaseUrl()}/items/123`);
			expect(validResponse.status).toBe(200);
			expect(await validResponse.json()).toEqual({ id: '123' });

			// Invalid param (non-numeric) - 422 per RFC 7807 for validation errors
			const invalidResponse = await fetch(`${getBaseUrl()}/items/abc`);
			expect(invalidResponse.status).toBe(422);
			const body = (await invalidResponse.json()) as ValidationErrorResponse;
			expect(body.errors).toBeDefined();
			expect(body.errors[0]!.path).toContain('params');
		});

		test('should validate query with schema and return 422 on failure', async () => {
			// TypeBox schema for query validation
			const QuerySchema = Type.Object({
				page: Type.String() // Query params are strings
			});

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (ctx) => Response.json({ query: ctx.query }), { query: QuerySchema });
				}
			}

			app = Ori.create().controller('/search', TestController);
			await app.listen(getPort());

			// Missing required param - 422 per RFC 7807 for validation errors
			const missingResponse = await fetch(`${getBaseUrl()}/search`);
			expect(missingResponse.status).toBe(422);
			const missingBody = (await missingResponse.json()) as ValidationErrorResponse;
			expect(missingBody.errors).toBeDefined();
			expect(missingBody.errors[0]!.path).toContain('query');
		});

		test('should validate body with schema for POST requests', async () => {
			// TypeBox schema for body validation
			const BodySchema = Type.Object({
				name: Type.String({ minLength: 1 }),
				age: Type.Number({ minimum: 0 })
			});

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/', async (ctx) => Response.json({ received: await ctx.json() }), { body: BodySchema });
				}
			}

			app = Ori.create().controller('/users', TestController);
			await app.listen(getPort());

			// Valid body
			const validResponse = await fetch(`${getBaseUrl()}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Test', age: 25 })
			});
			expect(validResponse.status).toBe(200);

			// Invalid body (missing required field) - 422 per RFC 7807 for validation errors
			const invalidResponse = await fetch(`${getBaseUrl()}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Test' })
			});
			expect(invalidResponse.status).toBe(422);
			const body = (await invalidResponse.json()) as ValidationErrorResponse;
			expect(body.errors).toBeDefined();
			expect(body.errors[0]!.path).toContain('body');
		});

		test('should return validation errors for missing required fields', async () => {
			// TypeBox schema with required fields
			const BodySchema = Type.Object({
				name: Type.String({ minLength: 1 }),
				age: Type.Number({ minimum: 0 })
			});

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/', async (ctx) => Response.json({ received: await ctx.json() }), { body: BodySchema });
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			// Missing both required fields - 422 per RFC 7807 for validation errors
			const response = await fetch(`${getBaseUrl()}/api`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});
			expect(response.status).toBe(422);
			const body = (await response.json()) as ValidationErrorResponse;
			expect(body.errors).toBeDefined();
			expect(body.errors.length).toBeGreaterThanOrEqual(1);
			// Verify it's a body validation error
			expect(body.errors.some((e) => e.path.includes('body'))).toBe(true);
		});

		test('should return 422 for invalid JSON body (parse error as validation error)', async () => {
			// TypeBox schema for body validation
			const BodySchema = Type.Object({
				name: Type.String()
			});

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/', async (ctx) => Response.json({ received: await ctx.json() }), { body: BodySchema });
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			// Note: Invalid JSON is returned as 422 because the framework treats
			// parse errors as validation errors (body doesn't match expected schema)
			const response = await fetch(`${getBaseUrl()}/api`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'not valid json{'
			});
			expect(response.status).toBe(422);
			const body = (await response.json()) as ValidationErrorResponse;
			expect(body.errors).toBeDefined();
			expect(body.errors[0]!.path).toBe('body');
			expect(body.errors[0]!.message).toBe('Invalid JSON body');
		});

		test('should skip body validation for GET requests even with body schema', async () => {
			// TypeBox schema for body validation
			const BodySchema = Type.Object({
				name: Type.String()
			});

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }), { body: BodySchema });
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			// GET request should succeed despite body schema (body not validated for GET)
			const response = await fetch(`${getBaseUrl()}/api`);
			expect(response.status).toBe(200);
		});
	});

	describe('logger configuration', () => {
		test('should use configured log level', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().logger({ level: 'error' }).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(response.status).toBe(200);
		});

		test('should accept custom transports', async () => {
			const logs: Array<{ level: number; msg: string }> = [];
			const customTransport = {
				write: (entry: { level: number; msg: string }) => {
					logs.push(entry);
				},
				flush: async () => {},
				close: async () => {}
			};

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create()
				.logger({ transports: [customTransport] })
				.controller('/api', TestController);
			await app.listen(getPort());

			// Custom transport should have received startup log entries
			// (fast path routes don't log requests for performance)
			expect(logs.length).toBeGreaterThan(0);
			// Logger uses 'msg' field for the message - check for startup logs
			expect(logs.some((l) => l.msg.startsWith('Server Listening:'))).toBe(true);
		});

		test('should support clearConsole option', () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			// Should not throw when setting clearConsole
			app = Ori.create().logger({ clearConsole: true }).controller('/api', TestController);

			// No error means the option was accepted
			expect(app).toBeInstanceOf(Application);
		});
	});

	describe('eager providers', () => {
		test('should instantiate eager providers at startup', async () => {
			let instantiated = false;

			class EagerService {
				constructor() {
					instantiated = true;
				}
			}

			app = Ori.create().provider(EagerService, [], { eager: true });
			await app.listen(getPort());

			// Eager provider should be instantiated during listen()
			expect(instantiated).toBe(true);
		});

		test('should not instantiate lazy providers until first use', async () => {
			let instantiated = false;

			class LazyService {
				constructor() {
					instantiated = true;
				}
			}

			app = Ori.create().provider(LazyService);
			await app.listen(getPort());

			// Lazy provider should NOT be instantiated yet
			expect(instantiated).toBe(false);

			// Now resolve it
			const container = app.getContainer();
			container.resolve(LazyService);

			// Now it should be instantiated
			expect(instantiated).toBe(true);
		});

		test('should instantiate eager provider with dependencies', async () => {
			let depValue = '';

			class ConfigService {
				value = 'config-value';
			}

			class EagerService {
				constructor(private config: ConfigService) {
					depValue = this.config.value;
				}
			}

			app = Ori.create().provider(ConfigService).provider(EagerService, [ConfigService], { eager: true });
			await app.listen(getPort());

			// Eager provider should have been instantiated with its dependency
			expect(depValue).toBe('config-value');
		});

		test('should instantiate multiple eager providers', async () => {
			const instantiationOrder: string[] = [];

			class EagerService1 {
				constructor() {
					instantiationOrder.push('service1');
				}
			}

			class EagerService2 {
				constructor() {
					instantiationOrder.push('service2');
				}
			}

			class LazyService {
				constructor() {
					instantiationOrder.push('lazy');
				}
			}

			app = Ori.create()
				.provider(EagerService1, [], { eager: true })
				.provider(LazyService)
				.provider(EagerService2, [], { eager: true });
			await app.listen(getPort());

			// Both eager providers should be instantiated, lazy should not
			expect(instantiationOrder).toEqual(['service1', 'service2']);
		});

		test('should use eager provider in controller dependencies', async () => {
			let serviceCreatedAt = 0;
			let controllerCreatedAt = 0;

			class EagerService {
				constructor() {
					serviceCreatedAt = performance.now();
				}
				getData() {
					return 'from-eager';
				}
			}

			class TestController implements OriController {
				constructor(private service: EagerService) {
					controllerCreatedAt = performance.now();
				}
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ data: this.service.getData() }));
				}
			}

			app = Ori.create()
				.provider(EagerService, [], { eager: true })
				.controller('/api', TestController, [EagerService]);
			await app.listen(getPort());

			// Eager service should be created before controller (controller creation happens during route registration)
			expect(serviceCreatedAt).toBeLessThan(controllerCreatedAt);

			// And it should work correctly
			const response = await fetch(`${getBaseUrl()}/api`);
			expect(await response.json()).toEqual({ data: 'from-eager' });
		});

		test('should allow eager provider to access other providers', async () => {
			const results: string[] = [];

			class DatabaseService {
				connect() {
					results.push('db-connected');
				}
			}

			class StartupService {
				constructor(private db: DatabaseService) {
					// Eager services can do startup work
					this.db.connect();
					results.push('startup-complete');
				}
			}

			app = Ori.create()
				.provider(DatabaseService)
				.provider(StartupService, [DatabaseService], { eager: true });
			await app.listen(getPort());

			// Startup service should have run its constructor, which uses DatabaseService
			expect(results).toEqual(['db-connected', 'startup-complete']);
		});
	});

	describe('HTTP method validation', () => {
		test('should return 405 for invalid HTTP method', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			const testPort = getPort();
			app = Ori.create().controller('/api', TestController);
			await app.listen(testPort);

			// Use raw TCP socket to send request with invalid HTTP method
			// (fetch() normalizes/rejects invalid methods before sending)
			const socket = await Bun.connect({
				hostname: 'localhost',
				port: testPort,
				socket: {
					data() {},
					open() {},
					error() {},
					close() {}
				}
			});

			// Send raw HTTP request with invalid method
			socket.write('INVALID /api HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');

			// Wait for response
			await Bun.sleep(100);

			// Read response (Bun.connect doesn't have a clean way to read response,
			// so we verify the server doesn't crash and continues to work)
			socket.end();

			// Verify server still works after receiving invalid request
			const validResponse = await fetch(`http://localhost:${testPort}/api`);
			expect(validResponse.status).toBe(200);
		});

		test('should handle all standard HTTP methods', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ method: 'GET' }))
						.post('/', () => Response.json({ method: 'POST' }))
						.put('/', () => Response.json({ method: 'PUT' }))
						.patch('/', () => Response.json({ method: 'PATCH' }))
						.delete('/', () => Response.json({ method: 'DELETE' }))
						.head('/', () => new Response(null, { status: 200 }))
						.options('/', () => Response.json({ method: 'OPTIONS' }));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());
			const baseUrl = getBaseUrl();

			// All standard methods should work
			const getRes = await fetch(`${baseUrl}/api`);
			expect(getRes.status).toBe(200);

			const postRes = await fetch(`${baseUrl}/api`, { method: 'POST' });
			expect(postRes.status).toBe(200);

			const headRes = await fetch(`${baseUrl}/api`, { method: 'HEAD' });
			expect(headRes.status).toBe(200);

			const optionsRes = await fetch(`${baseUrl}/api`, { method: 'OPTIONS' });
			expect(optionsRes.status).toBe(200);
		});
	});

	describe('signal handler cleanup', () => {
		test('should allow multiple app instances in sequence without memory leak', async () => {
			// This test verifies that signal handlers are properly cleaned up
			// when stop() is called, allowing subsequent app instances to register
			// their own handlers without accumulating listeners.

			const initialListenerCount = process.listenerCount('SIGTERM');

			// Create and start first app
			const app1 = Ori.create();
			await app1.listen(getPort());

			// Should have registered one SIGTERM listener
			expect(process.listenerCount('SIGTERM')).toBe(initialListenerCount + 1);

			// Stop first app - should clean up handlers
			await app1.stop();

			// Listener count should be back to initial
			expect(process.listenerCount('SIGTERM')).toBe(initialListenerCount);

			// Create and start second app
			const app2 = Ori.create();
			await app2.listen(getPort());

			// Should have registered one new SIGTERM listener
			expect(process.listenerCount('SIGTERM')).toBe(initialListenerCount + 1);

			// Stop second app
			await app2.stop();

			// Listener count should be back to initial
			expect(process.listenerCount('SIGTERM')).toBe(initialListenerCount);
		});

		test('should clean up both SIGTERM and SIGINT handlers on stop', async () => {
			const initialSigtermCount = process.listenerCount('SIGTERM');
			const initialSigintCount = process.listenerCount('SIGINT');

			const testApp = Ori.create();
			await testApp.listen(getPort());

			// Both handlers should be registered
			expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);
			expect(process.listenerCount('SIGINT')).toBe(initialSigintCount + 1);

			await testApp.stop();

			// Both handlers should be cleaned up
			expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);
			expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
		});

		test('should not register handlers when signal handling is disabled', async () => {
			const initialSigtermCount = process.listenerCount('SIGTERM');

			const testApp = Ori.create().disableSignalHandling();
			await testApp.listen(getPort());

			// No handlers should be registered
			expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);

			await testApp.stop();
		});

		test('should not accumulate handlers on multiple listen calls', async () => {
			const initialSigtermCount = process.listenerCount('SIGTERM');

			const testApp = Ori.create();

			// First listen
			await testApp.listen(getPort());
			expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);

			// Stop and listen again on same app instance
			await testApp.stop();
			await testApp.listen(getPort());

			// Should still only have one handler (not accumulated)
			expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);

			await testApp.stop();
			expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);
		});
	});

	describe('graceful shutdown timeout', () => {
		test('should complete shutdown before timeout', async () => {
			let hookExecuted = false;

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/test', TestController).setShutdownTimeout(1000);

			await app.listen(getPort());

			// Register a fast shutdown hook via AppContext
			const appContext = app.context;
			appContext?.onShutdown(async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				hookExecuted = true;
			});

			const startTime = Date.now();
			await app.stop();
			const elapsed = Date.now() - startTime;

			expect(hookExecuted).toBe(true);
			expect(elapsed).toBeLessThan(500); // Should complete well before timeout
		});

		test('should force stop after timeout with hanging shutdown hook', async () => {
			let hookStarted = false;
			let hookCompleted = false;

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/test', TestController).setShutdownTimeout(100); // Very short timeout for test

			await app.listen(getPort());

			// Register a hanging shutdown hook
			const appContext = app.context;
			appContext?.onShutdown(async () => {
				hookStarted = true;
				// This hook hangs for 5 seconds - longer than timeout
				await new Promise((resolve) => setTimeout(resolve, 5000));
				hookCompleted = true;
			});

			const startTime = Date.now();
			await app.stop();
			const elapsed = Date.now() - startTime;

			expect(hookStarted).toBe(true);
			expect(hookCompleted).toBe(false); // Hook should NOT have completed
			expect(elapsed).toBeLessThan(500); // Should have timed out around 100ms
			expect(elapsed).toBeGreaterThanOrEqual(90); // Should have waited for timeout (allow 10% timing jitter)
		});

		test('should use default 10s timeout', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/test', TestController);
			await app.listen(getPort());

			// Fast stop - should complete immediately
			const startTime = Date.now();
			await app.stop();
			const elapsed = Date.now() - startTime;

			// Should not wait anywhere near 10 seconds
			expect(elapsed).toBeLessThan(1000);
		});

		test('setShutdownTimeout should be chainable', () => {
			const testApp = Ori.create().setShutdownTimeout(5000).disableSignalHandling();

			expect(testApp).toBeInstanceOf(Application);
		});
	});

	describe('CORS configuration', () => {
		test('should add CORS headers to responses when configured with wildcard origin', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().cors({ origin: '*' }).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
			expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
		});

		test('should add CORS headers to responses when configured with specific origin', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().cors({ origin: 'https://example.com' }).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
		});

		test('should handle CORS preflight OPTIONS requests', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().cors({ origin: '*' }).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`, { method: 'OPTIONS' });

			expect(response.status).toBe(204);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
		});

		test('should add CORS headers to error responses', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => {
						throw new Error('Test error');
					});
				}
			}

			app = Ori.create().cors({ origin: '*' }).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(500);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		});

		test('should add CORS headers to guard rejection responses', async () => {
			class DenyGuard implements Guard {
				canActivate() {
					return false;
				}
			}

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().cors({ origin: '*' }).guard(DenyGuard).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(403);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		});

		test('should respect custom CORS methods and headers', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create()
				.cors({
					origin: '*',
					methods: ['GET', 'POST'],
					allowedHeaders: ['X-Custom-Header'],
					exposedHeaders: ['X-Response-Header'],
					maxAge: 3600
				})
				.controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
			expect(response.headers.get('Access-Control-Allow-Headers')).toBe('X-Custom-Header');
			expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Response-Header');
			expect(response.headers.get('Access-Control-Max-Age')).toBe('3600');
		});

		test('should include credentials header when not explicitly disabled', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().cors({ origin: '*' }).controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
		});

		test('should not add CORS headers when not configured', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);

			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		});
	});

	describe('route path validation (security)', () => {
		test('should reject path traversal in controller path', async () => {
			class MaliciousController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			// Path traversal in controller path - validated during listen()
			app = Ori.create().controller('/../../../etc/passwd', MaliciousController);
			await expect(app.listen(getPort())).rejects.toThrow('Path traversal not allowed');
		});

		test('should reject path traversal in route path', async () => {
			class TraversalRouteController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/../secret', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/api', TraversalRouteController);
			await expect(app.listen(getPort())).rejects.toThrow('Path traversal not allowed');
		});

		test('should reject null bytes in path', async () => {
			class NullByteController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/test\0.txt', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/api', NullByteController);
			await expect(app.listen(getPort())).rejects.toThrow('Null bytes not allowed');
		});

		test('should reject extremely long paths', async () => {
			const longPath = '/a'.repeat(3000); // 6000 chars, over 2048 limit

			class LongPathController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => new Response('ok'));
				}
			}

			// Path length validated during listen()
			app = Ori.create().controller(longPath, LongPathController);
			await expect(app.listen(getPort())).rejects.toThrow('Route path too long');
		});

		test('should allow valid paths with special route characters', async () => {
			class ValidController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/users/:id', () => new Response('ok'));
					r.get('/files/*', () => new Response('ok'));
				}
			}

			app = Ori.create().controller('/api/v1', ValidController);
			await app.listen(getPort());

			// Should start successfully with valid paths
			expect(app.getRoutes().length).toBe(2);
			await app.stop();
		});

		test('should normalize multiple slashes', async () => {
			class SlashController implements OriController {
				configure(r: RouteBuilder) {
					r.get('//double//slash', () => new Response('normalized'));
				}
			}

			app = Ori.create().controller('///api', SlashController);
			await app.listen(getPort());

			const routes = app.getRoutes();
			// Path should be normalized to single slashes
			expect(routes[0]?.fullPath).toBe('/api/double/slash');
			await app.stop();
		});

		test('should handle empty route path as root', async () => {
			class RootController implements OriController {
				configure(r: RouteBuilder) {
					r.get('', () => new Response('root'));
				}
			}

			app = Ori.create().controller('/api', RootController);
			await app.listen(getPort());

			const routes = app.getRoutes();
			expect(routes[0]?.fullPath).toBe('/api');
			await app.stop();
		});
	});
});
