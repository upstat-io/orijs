import { describe, test, expect, beforeEach } from 'bun:test';
import { RouteBuilder } from '../src/controllers/route-builder.ts';
import type { Guard, Interceptor, RequestContext, Pipe } from '../src/types/index.ts';

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
});
