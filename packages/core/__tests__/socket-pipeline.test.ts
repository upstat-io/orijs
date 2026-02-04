import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { SocketPipeline, type CompiledSocketRoute } from '../src/sockets/socket-pipeline.ts';
import type { Container } from '../src/container.ts';
import type { Logger } from '@orijs/logging';
import type { AppContext } from '../src/app-context.ts';
import type { SocketGuard, SocketContextLike } from '../src/types/socket-router.ts';
import type { WebSocketConnection, SocketData } from '@orijs/websocket';
import { Type } from '@orijs/validation';

describe('SocketPipeline', () => {
	let pipeline: SocketPipeline;
	let mockContainer: Container;
	let mockLogger: Logger;
	let mockAppContext: AppContext;

	// Test guards
	class AllowGuard implements SocketGuard {
		canActivate(): boolean | Promise<boolean> {
			return true;
		}
	}

	class DenyGuard implements SocketGuard {
		canActivate(): boolean | Promise<boolean> {
			return false;
		}
	}

	class AsyncGuard implements SocketGuard {
		async canActivate(): Promise<boolean> {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return true;
		}
	}

	class StateSettingGuard implements SocketGuard {
		canActivate(ctx: SocketContextLike): boolean {
			ctx.set('user', { id: 'test-user', name: 'Test User' });
			return true;
		}
	}

	class ThrowingGuard implements SocketGuard {
		canActivate(): boolean {
			throw new Error('Guard error');
		}
	}

	beforeEach(() => {
		// Create mock container that caches instances
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

		// Create mock logger
		mockLogger = {
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {})
		} as unknown as Logger;

		// Create mock app context
		mockAppContext = {
			container: mockContainer,
			eventCoordinator: undefined,
			workflowCoordinator: undefined
		} as unknown as AppContext;

		pipeline = new SocketPipeline(mockContainer, mockAppContext, mockLogger, {});
	});

	function createMockWebSocket<TData = unknown>(
		data?: Partial<SocketData & { data: TData }>
	): WebSocketConnection<TData> {
		const socketId = data?.socketId ?? 'test-socket-id';
		return {
			data: {
				socketId,
				data: data?.data as TData,
				connectionTime: Date.now(),
				...data
			},
			send: mock(() => {}),
			subscribe: mock(() => {}),
			unsubscribe: mock(() => {}),
			publish: mock(() => {}),
			close: mock(() => {}),
			isSubscribed: mock(() => false),
			readyState: 1
		} as unknown as WebSocketConnection<TData>;
	}

	function createRoute(overrides: Partial<CompiledSocketRoute> = {}): CompiledSocketRoute {
		return {
			messageType: 'test',
			handler: async () => ({ ok: true }),
			guards: [],
			...overrides
		};
	}

	describe('compileRoute()', () => {
		test('should pre-resolve guards', () => {
			const route = {
				messageType: 'test',
				handler: async () => ({}),
				guards: [AllowGuard]
			};

			const compiled = pipeline.compileRoute(route);

			expect(compiled.guards).toHaveLength(1);
			expect(compiled.guards[0]).toBeInstanceOf(AllowGuard);
			expect(mockContainer.resolve).toHaveBeenCalledWith(AllowGuard);
		});

		test('should preserve schema', () => {
			const schema = Type.Object({ name: Type.String() });
			const route = {
				messageType: 'test',
				handler: async () => ({}),
				guards: [],
				schema
			};

			const compiled = pipeline.compileRoute(route);

			expect(compiled.schema).toBe(schema);
		});
	});

	describe('runConnectionGuards()', () => {
		test('should allow connection when no guards', async () => {
			const ws = createMockWebSocket();

			const ctx = await pipeline.runConnectionGuards(ws, []);

			expect(ctx).not.toBeNull();
		});

		test('should allow connection when guard returns true', async () => {
			const ws = createMockWebSocket();

			const ctx = await pipeline.runConnectionGuards(ws, [AllowGuard]);

			expect(ctx).not.toBeNull();
		});

		test('should reject connection when guard returns false', async () => {
			const ws = createMockWebSocket();

			const ctx = await pipeline.runConnectionGuards(ws, [DenyGuard]);

			expect(ctx).toBeNull();
			expect(mockLogger.debug).toHaveBeenCalled();
		});

		test('should support async guards', async () => {
			const ws = createMockWebSocket();

			const ctx = await pipeline.runConnectionGuards(ws, [AsyncGuard]);

			expect(ctx).not.toBeNull();
		});

		test('should reject on guard error', async () => {
			const ws = createMockWebSocket();

			const ctx = await pipeline.runConnectionGuards(ws, [ThrowingGuard]);

			expect(ctx).toBeNull();
			expect(mockLogger.error).toHaveBeenCalled();
		});

		test('should run guards in order and stop at first rejection', async () => {
			const order: string[] = [];

			class FirstGuard implements SocketGuard {
				canActivate(): boolean {
					order.push('first');
					return false;
				}
			}

			class SecondGuard implements SocketGuard {
				canActivate(): boolean {
					order.push('second');
					return true;
				}
			}

			// Reset container to use fresh guards
			(mockContainer.resolve as ReturnType<typeof mock>).mockImplementation((ctor: new () => unknown) => {
				return new ctor();
			});

			const ws = createMockWebSocket();

			await pipeline.runConnectionGuards(ws, [FirstGuard, SecondGuard]);

			expect(order).toEqual(['first']);
		});

		test('should allow guard to set context state', async () => {
			const ws = createMockWebSocket();

			const ctx = await pipeline.runConnectionGuards(ws, [StateSettingGuard]);

			expect(ctx).not.toBeNull();
			expect(ctx!.state.user).toEqual({ id: 'test-user', name: 'Test User' });
		});
	});

	describe('handleMessage()', () => {
		test('should call handler and send response', async () => {
			const ws = createMockWebSocket();
			const route = createRoute({
				handler: async () => ({ result: 'success' })
			});

			await pipeline.handleMessage(ws, route, 'test', {}, undefined, {});

			expect(ws.send).toHaveBeenCalled();
			const sentData = (ws.send as ReturnType<typeof mock>).mock.calls[0]![0];
			const parsed = JSON.parse(sentData);
			expect(parsed.type).toBe('test');
			expect(parsed.data).toEqual({ result: 'success' });
		});

		test('should include correlationId in response when provided', async () => {
			const ws = createMockWebSocket();
			const route = createRoute();

			await pipeline.handleMessage(ws, route, 'test', {}, 'correlation-123', {});

			const sentData = (ws.send as ReturnType<typeof mock>).mock.calls[0]![0];
			const parsed = JSON.parse(sentData);
			expect(parsed.correlationId).toBe('correlation-123');
		});

		test('should run message guards before handler', async () => {
			const order: string[] = [];

			class TrackingGuard implements SocketGuard {
				canActivate(): boolean {
					order.push('guard');
					return true;
				}
			}

			const ws = createMockWebSocket();
			const route = createRoute({
				guards: [new TrackingGuard()],
				handler: async () => {
					order.push('handler');
					return {};
				}
			});

			await pipeline.handleMessage(ws, route, 'test', {}, undefined, {});

			expect(order).toEqual(['guard', 'handler']);
		});

		test('should send Forbidden error when guard denies', async () => {
			const ws = createMockWebSocket();
			const route = createRoute({
				guards: [new DenyGuard()]
			});

			await pipeline.handleMessage(ws, route, 'test', {}, undefined, {});

			const sentData = (ws.send as ReturnType<typeof mock>).mock.calls[0]![0];
			const parsed = JSON.parse(sentData);
			expect(parsed.error).toBe('Forbidden');
		});

		test('should validate message data with schema', async () => {
			const ws = createMockWebSocket();
			const route = createRoute({
				schema: Type.Object({
					name: Type.String({ minLength: 1 })
				}),
				handler: async () => ({ ok: true })
			});

			// Invalid data
			await pipeline.handleMessage(ws, route, 'test', { name: '' }, undefined, {});

			const sentData = (ws.send as ReturnType<typeof mock>).mock.calls[0]![0];
			const parsed = JSON.parse(sentData);
			expect(parsed.error).toContain('Validation failed');
		});

		test('should pass valid data to handler', async () => {
			let receivedData: unknown;
			const ws = createMockWebSocket();
			const route = createRoute({
				schema: Type.Object({
					name: Type.String()
				}),
				handler: async (ctx) => {
					receivedData = ctx.data;
					return { ok: true };
				}
			});

			await pipeline.handleMessage(ws, route, 'test', { name: 'valid' }, undefined, {});

			expect(receivedData).toEqual({ name: 'valid' });
		});

		test('should copy connection state to message context', async () => {
			let receivedState: unknown;
			const ws = createMockWebSocket();
			const route = createRoute({
				handler: async (ctx) => {
					receivedState = ctx.state;
					return {};
				}
			});

			await pipeline.handleMessage(ws, route, 'test', {}, undefined, {
				user: { id: 'user-123' },
				sessionId: 'session-456'
			});

			expect(receivedState).toEqual({
				user: { id: 'user-123' },
				sessionId: 'session-456'
			});
		});

		test('should handle handler errors and send error response', async () => {
			const ws = createMockWebSocket();
			const route = createRoute({
				handler: async () => {
					throw new Error('Handler exploded');
				}
			});

			await pipeline.handleMessage(ws, route, 'test', {}, 'corr-id', {});

			const sentData = (ws.send as ReturnType<typeof mock>).mock.calls[0]![0];
			const parsed = JSON.parse(sentData);
			expect(parsed.type).toBe('test');
			expect(parsed.error).toBe('Handler exploded');
			expect(parsed.correlationId).toBe('corr-id');
			expect(mockLogger.error).toHaveBeenCalled();
		});

		test('should cache guard instances across multiple messages', async () => {
			let instanceCount = 0;

			class CountingGuard implements SocketGuard {
				constructor() {
					instanceCount++;
				}
				canActivate(): boolean {
					return true;
				}
			}

			const compiledRoute = pipeline.compileRoute({
				messageType: 'test',
				handler: async () => ({}),
				guards: [CountingGuard]
			});

			const ws = createMockWebSocket();

			// Handle multiple messages with the same compiled route
			await pipeline.handleMessage(ws, compiledRoute, 'test', {}, undefined, {});
			await pipeline.handleMessage(ws, compiledRoute, 'test', {}, undefined, {});
			await pipeline.handleMessage(ws, compiledRoute, 'test', {}, undefined, {});

			// Guard should only be instantiated once during compile
			expect(instanceCount).toBe(1);
		});
	});
});
