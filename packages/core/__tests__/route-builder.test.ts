import { describe, test, expect, beforeEach } from 'bun:test';
import { RouteBuilder } from '../src/controllers/route-builder.ts';
import type { Guard, Interceptor, RequestContext, Pipe, ParamValidator } from '../src/types/index.ts';
import { UuidParam, StringParam, NumberParam } from '../src/controllers/param-validators';
import { createRouteKey } from '../src/route-key.ts';

class MockGuard implements Guard {
	canActivate(): boolean {
		return true;
	}
}

class AnotherGuard implements Guard {
	canActivate(): boolean {
		return true;
	}
}

class MockInterceptor implements Interceptor {
	async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
		return next();
	}
}

class AnotherInterceptor implements Interceptor {
	async intercept(_ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
		return next();
	}
}

class MockPipe implements Pipe {
	transform(value: unknown): unknown {
		return value;
	}
}

// Dummy handler that satisfies the Handler type - used for route registration tests
const dummyHandler = () => new Response('ok');

describe('RouteBuilder', () => {
	let builder: RouteBuilder;

	beforeEach(() => {
		builder = new RouteBuilder();
	});

	describe('HTTP method routes', () => {
		test('should register GET route', () => {
			builder.get('/users', dummyHandler);
			const routes = builder.getRoutes();

			expect(routes).toHaveLength(1);
			expect(routes[0]!.method).toBe('GET');
			expect(routes[0]!.path).toBe('/users');
		});

		test('should register all HTTP methods', () => {
			builder
				.get('/get', dummyHandler)
				.post('/post', dummyHandler)
				.put('/put', dummyHandler)
				.patch('/patch', dummyHandler)
				.delete('/delete', dummyHandler)
				.head('/head', dummyHandler)
				.options('/options', dummyHandler);

			const routes = builder.getRoutes();
			const methods = routes.map((r) => r.method);

			expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
		});
	});

	describe('guards', () => {
		test('should apply controller-level guard to all routes', () => {
			builder.guard(MockGuard).get('/first', dummyHandler).get('/second', dummyHandler);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toContain(MockGuard);
			expect(routes[1]!.guards).toContain(MockGuard);
		});

		test('should add route-level guard after controller guards', () => {
			builder.guard(MockGuard).get('/protected', dummyHandler).guard(AnotherGuard);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toEqual([MockGuard, AnotherGuard]);
		});

		test('should apply route guard only to that route', () => {
			builder.get('/first', dummyHandler).get('/second', dummyHandler).guard(MockGuard);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toHaveLength(0);
			expect(routes[1]!.guards).toContain(MockGuard);
		});

		test('guards() should replace all guards for route', () => {
			builder.guard(MockGuard).get('/route', dummyHandler).guards([AnotherGuard]);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toEqual([AnotherGuard]);
		});

		test('clearGuards() should remove all guards for route', () => {
			builder.guard(MockGuard).get('/route', dummyHandler).clearGuards();

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toHaveLength(0);
		});

		test('clearGuards() at controller level should clear inherited and controller guards', () => {
			const builderWithInherited = new RouteBuilder([MockGuard], []);
			builderWithInherited.clearGuards().get('/route', dummyHandler);

			const routes = builderWithInherited.getRoutes();

			expect(routes[0]!.guards).toHaveLength(0);
		});
	});

	describe('inherited guards', () => {
		test('should include inherited global guards', () => {
			const builderWithInherited = new RouteBuilder([MockGuard], []);
			builderWithInherited.get('/route', dummyHandler);

			const routes = builderWithInherited.getRoutes();

			expect(routes[0]!.guards).toContain(MockGuard);
		});

		test('controller guards should stack after inherited', () => {
			const builderWithInherited = new RouteBuilder([MockGuard], []);
			builderWithInherited.guard(AnotherGuard).get('/route', dummyHandler);

			const routes = builderWithInherited.getRoutes();

			expect(routes[0]!.guards).toEqual([MockGuard, AnotherGuard]);
		});
	});

	describe('interceptors', () => {
		test('should apply controller-level interceptor to all routes', () => {
			builder.intercept(MockInterceptor).get('/first', dummyHandler).get('/second', dummyHandler);

			const routes = builder.getRoutes();

			expect(routes[0]!.interceptors).toContain(MockInterceptor);
			expect(routes[1]!.interceptors).toContain(MockInterceptor);
		});

		test('should add route-level interceptor after controller interceptors', () => {
			builder.intercept(MockInterceptor).get('/route', dummyHandler).intercept(AnotherInterceptor);

			const routes = builder.getRoutes();

			expect(routes[0]!.interceptors).toEqual([MockInterceptor, AnotherInterceptor]);
		});

		test('interceptors() should replace all interceptors for route', () => {
			builder.intercept(MockInterceptor).get('/route', dummyHandler).interceptors([AnotherInterceptor]);

			const routes = builder.getRoutes();

			expect(routes[0]!.interceptors).toEqual([AnotherInterceptor]);
		});

		test('clearInterceptors() should remove all interceptors for route', () => {
			builder.intercept(MockInterceptor).get('/route', dummyHandler).clearInterceptors();

			const routes = builder.getRoutes();

			expect(routes[0]!.interceptors).toHaveLength(0);
		});
	});

	describe('pipes', () => {
		test('should apply controller-level pipe to all routes', () => {
			builder.pipe(MockPipe).get('/first', dummyHandler).get('/second', dummyHandler);

			const routes = builder.getRoutes();

			expect(routes[0]!.pipes).toHaveLength(1);
			expect(routes[0]!.pipes[0]!.pipe).toBe(MockPipe);
			expect(routes[1]!.pipes).toHaveLength(1);
		});

		test('should add route-level pipe to specific route', () => {
			builder.get('/first', dummyHandler).get('/second', dummyHandler).pipe(MockPipe);

			const routes = builder.getRoutes();

			expect(routes[0]!.pipes).toHaveLength(0);
			expect(routes[1]!.pipes).toHaveLength(1);
		});

		test('should include schema with pipe', () => {
			// Use a validator function as the schema (one of the valid Schema types)
			const schema = (data: unknown) => data as string;
			builder.get('/route', dummyHandler).pipe(MockPipe, schema);

			const routes = builder.getRoutes();

			expect(routes[0]!.pipes[0]!.schema).toBe(schema);
		});
	});

	describe('clear', () => {
		test('should remove both guards and interceptors', () => {
			builder.guard(MockGuard).intercept(MockInterceptor).clear().get('/route', dummyHandler);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toHaveLength(0);
			expect(routes[0]!.interceptors).toHaveLength(0);
		});
	});

	describe('chaining', () => {
		test('should support fluent chaining', () => {
			const result = builder
				.guard(MockGuard)
				.intercept(MockInterceptor)
				.get('/first', dummyHandler)
				.post('/second', dummyHandler)
				.guard(AnotherGuard);

			expect(result).toBe(builder);
			expect(builder.getRoutes()).toHaveLength(2);
		});
	});

	describe('param validators', () => {
		test('should attach UuidParam to routes with :uuid param', () => {
			builder.param('uuid', UuidParam);
			builder.get('/:uuid', dummyHandler);

			const routes = builder.getRoutes();
			expect(routes[0]!.paramValidators).toBeDefined();
			expect(routes[0]!.paramValidators!.get('uuid')).toBe(UuidParam);
		});

		test('should not attach validators to routes without matching param', () => {
			builder.param('uuid', UuidParam);
			builder.get('/', dummyHandler);

			const routes = builder.getRoutes();
			expect(routes[0]!.paramValidators).toBeUndefined();
		});

		test('should support multiple param validators', () => {
			builder.param('uuid', UuidParam);
			builder.param('id', NumberParam);
			builder.get('/:uuid/items/:id', dummyHandler);

			const routes = builder.getRoutes();
			expect(routes[0]!.paramValidators!.size).toBe(2);
			expect(routes[0]!.paramValidators!.get('uuid')).toBe(UuidParam);
			expect(routes[0]!.paramValidators!.get('id')).toBe(NumberParam);
		});

		test('should only include params present in the route path', () => {
			builder.param('uuid', UuidParam);
			builder.param('id', NumberParam);
			builder.get('/:uuid', dummyHandler);

			const routes = builder.getRoutes();
			expect(routes[0]!.paramValidators!.size).toBe(1);
			expect(routes[0]!.paramValidators!.has('id')).toBe(false);
		});

		test('should support custom param validators', () => {
			class SlugParam implements ParamValidator {
				validate(value: string): boolean {
					return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
				}
			}

			builder.param('slug', SlugParam);
			builder.get('/:slug', dummyHandler);

			const routes = builder.getRoutes();
			expect(routes[0]!.paramValidators!.get('slug')).toBe(SlugParam);
		});

		test('built-in UuidParam should validate UUIDs correctly', () => {
			const validator = new UuidParam();
			expect(validator.validate('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
			expect(validator.validate('not-a-uuid')).toBe(false);
			expect(validator.validate('')).toBe(false);
		});

		test('built-in StringParam should validate non-empty strings', () => {
			const validator = new StringParam();
			expect(validator.validate('hello')).toBe(true);
			expect(validator.validate('')).toBe(false);
		});

		test('built-in NumberParam should validate numeric strings', () => {
			const validator = new NumberParam();
			expect(validator.validate('123')).toBe(true);
			expect(validator.validate('0')).toBe(true);
			expect(validator.validate('abc')).toBe(false);
			expect(validator.validate('')).toBe(false);
		});
	});

	describe('route data (set)', () => {
		test('should attach controller-level data to all routes', () => {
			const key = createRouteKey<number>('Limit');
			builder.set(key, 100);

			builder.get('/first', dummyHandler);
			builder.get('/second', dummyHandler);

			const routes = builder.getRoutes();
			expect(routes[0]!.data).toBeDefined();
			expect(routes[0]!.data!.get(key)).toBe(100);
			expect(routes[1]!.data).toBeDefined();
			expect(routes[1]!.data!.get(key)).toBe(100);
		});

		test('should attach route-level data only to that route', () => {
			const key = createRouteKey<string>('Tag');

			builder.get('/first', dummyHandler);
			builder.set(key, 'strict');
			builder.get('/second', dummyHandler);

			const routes = builder.getRoutes();
			expect(routes[0]!.data!.get(key)).toBe('strict');
			expect(routes[1]!.data).toBeUndefined();
		});

		test('should merge controller and route-level data', () => {
			const controllerKey = createRouteKey<number>('Global');
			const routeKey = createRouteKey<string>('Local');

			builder.set(controllerKey, 42);
			builder.get('/route', dummyHandler);
			builder.set(routeKey, 'override');

			const routes = builder.getRoutes();
			expect(routes[0]!.data!.get(controllerKey)).toBe(42);
			expect(routes[0]!.data!.get(routeKey)).toBe('override');
		});

		test('should allow route-level data to override controller-level data', () => {
			const key = createRouteKey<number>('Limit');

			builder.set(key, 100);
			builder.get('/route', dummyHandler);
			builder.set(key, 10);

			const routes = builder.getRoutes();
			expect(routes[0]!.data!.get(key)).toBe(10);
		});

		test('should not have data when none is set', () => {
			builder.get('/route', dummyHandler);

			const routes = builder.getRoutes();
			expect(routes[0]!.data).toBeUndefined();
		});

		test('should isolate route data between routes', () => {
			const key = createRouteKey<string>('Config');

			builder.get('/first', dummyHandler);
			builder.set(key, 'first-config');
			builder.get('/second', dummyHandler);
			builder.set(key, 'second-config');

			const routes = builder.getRoutes();
			expect(routes[0]!.data!.get(key)).toBe('first-config');
			expect(routes[1]!.data!.get(key)).toBe('second-config');
		});

		test('should reset route data override between routes', () => {
			const controllerKey = createRouteKey<number>('Base');
			const routeKey = createRouteKey<string>('Extra');

			builder.set(controllerKey, 50);
			builder.get('/first', dummyHandler);
			builder.set(routeKey, 'extra-for-first');
			builder.get('/second', dummyHandler);

			const routes = builder.getRoutes();
			// First route has both controller and route data
			expect(routes[0]!.data!.get(controllerKey)).toBe(50);
			expect(routes[0]!.data!.get(routeKey)).toBe('extra-for-first');
			// Second route only has controller data
			expect(routes[1]!.data!.get(controllerKey)).toBe(50);
			expect(routes[1]!.data!.has(routeKey)).toBe(false);
		});
	});
});
