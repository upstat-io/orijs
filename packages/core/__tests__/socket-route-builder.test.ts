import { describe, test, expect, beforeEach } from 'bun:test';
import { SocketRouteBuilder } from '../src/sockets/socket-route-builder.ts';
import type { SocketGuard, SocketContextLike } from '../src/types/socket-router.ts';

class MockGuard implements SocketGuard {
	canActivate(): boolean {
		return true;
	}
}

class AnotherGuard implements SocketGuard {
	canActivate(): boolean {
		return true;
	}
}

class ConnectionGuard implements SocketGuard {
	canActivate(): boolean {
		return true;
	}
}

// Dummy handler for route registration tests
const dummyHandler = (_ctx: SocketContextLike) => ({ ok: true });

describe('SocketRouteBuilder', () => {
	let builder: SocketRouteBuilder;

	beforeEach(() => {
		builder = new SocketRouteBuilder();
	});

	describe('message routes', () => {
		test('should register message handler with on()', () => {
			builder.on('heartbeat', dummyHandler);
			const routes = builder.getRoutes();

			expect(routes).toHaveLength(1);
			expect(routes[0]!.messageType).toBe('heartbeat');
			expect(routes[0]!.handler).toBe(dummyHandler);
		});

		test('should register multiple message handlers', () => {
			builder.on('heartbeat', dummyHandler).on('subscribe', dummyHandler).on('unsubscribe', dummyHandler);

			const routes = builder.getRoutes();

			expect(routes).toHaveLength(3);
			expect(routes.map((r) => r.messageType)).toEqual(['heartbeat', 'subscribe', 'unsubscribe']);
		});

		test('should include schema when provided', () => {
			const schema = { type: 'object' } as never; // Mock schema
			builder.on('message', dummyHandler, schema);

			const routes = builder.getRoutes();

			expect(routes[0]!.schema).toBe(schema);
		});

		test('should have undefined schema when not provided', () => {
			builder.on('message', dummyHandler);

			const routes = builder.getRoutes();

			expect(routes[0]!.schema).toBeUndefined();
		});
	});

	describe('connection guards', () => {
		test('should register connection guard', () => {
			builder.connectionGuard(ConnectionGuard);
			const guards = builder.getConnectionGuards();

			expect(guards).toHaveLength(1);
			expect(guards[0]).toBe(ConnectionGuard);
		});

		test('should register multiple connection guards', () => {
			builder.connectionGuard(ConnectionGuard).connectionGuard(MockGuard);

			const guards = builder.getConnectionGuards();

			expect(guards).toHaveLength(2);
			expect(guards).toEqual([ConnectionGuard, MockGuard]);
		});

		test('connection guards should be separate from message guards', () => {
			builder.connectionGuard(ConnectionGuard).guard(MockGuard).on('message', dummyHandler);

			const connectionGuards = builder.getConnectionGuards();
			const routes = builder.getRoutes();

			expect(connectionGuards).toEqual([ConnectionGuard]);
			expect(routes[0]!.guards).toContain(MockGuard);
			expect(routes[0]!.guards).not.toContain(ConnectionGuard);
		});
	});

	describe('message guards', () => {
		test('should apply controller-level guard to all routes', () => {
			builder.guard(MockGuard).on('first', dummyHandler).on('second', dummyHandler);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toContain(MockGuard);
			expect(routes[1]!.guards).toContain(MockGuard);
		});

		test('should add route-level guard after controller guards', () => {
			builder.guard(MockGuard).on('protected', dummyHandler).guard(AnotherGuard);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toEqual([MockGuard, AnotherGuard]);
		});

		test('should apply route guard only to that route', () => {
			builder.on('first', dummyHandler).on('second', dummyHandler).guard(MockGuard);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toHaveLength(0);
			expect(routes[1]!.guards).toContain(MockGuard);
		});

		test('guards() should replace all guards for route', () => {
			builder.guard(MockGuard).on('route', dummyHandler).guards([AnotherGuard]);

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toEqual([AnotherGuard]);
		});

		test('clearGuards() should remove all guards for route', () => {
			builder.guard(MockGuard).on('route', dummyHandler).clearGuards();

			const routes = builder.getRoutes();

			expect(routes[0]!.guards).toHaveLength(0);
		});

		test('clearGuards() at controller level should clear all guards', () => {
			const builderWithInherited = new SocketRouteBuilder([MockGuard]);
			builderWithInherited.clearGuards().on('route', dummyHandler);

			const routes = builderWithInherited.getRoutes();

			expect(routes[0]!.guards).toHaveLength(0);
		});
	});

	describe('inherited guards', () => {
		test('should include inherited global guards', () => {
			const builderWithInherited = new SocketRouteBuilder([MockGuard]);
			builderWithInherited.on('route', dummyHandler);

			const routes = builderWithInherited.getRoutes();

			expect(routes[0]!.guards).toContain(MockGuard);
		});

		test('controller guards should stack after inherited', () => {
			const builderWithInherited = new SocketRouteBuilder([MockGuard]);
			builderWithInherited.guard(AnotherGuard).on('route', dummyHandler);

			const routes = builderWithInherited.getRoutes();

			expect(routes[0]!.guards).toEqual([MockGuard, AnotherGuard]);
		});
	});

	describe('chaining', () => {
		test('should support fluent chaining', () => {
			const result = builder
				.connectionGuard(ConnectionGuard)
				.guard(MockGuard)
				.on('first', dummyHandler)
				.on('second', dummyHandler)
				.guard(AnotherGuard);

			expect(result).toBe(builder);
			expect(builder.getRoutes()).toHaveLength(2);
			expect(builder.getConnectionGuards()).toHaveLength(1);
		});

		test('getRoutes() should freeze the route list', () => {
			builder.on('message', dummyHandler);
			const routes = builder.getRoutes();

			// Attempting to modify should fail
			expect(() => {
				(routes as SocketRouteBuilder['routes']).push({
					messageType: 'test',
					handler: dummyHandler,
					guards: []
				});
			}).toThrow();
		});

		test('getConnectionGuards() should freeze the guard list', () => {
			builder.connectionGuard(ConnectionGuard);
			const guards = builder.getConnectionGuards();

			// Attempting to modify should fail
			expect(() => {
				(guards as SocketRouteBuilder['connectionGuards']).push(MockGuard);
			}).toThrow();
		});
	});
});
