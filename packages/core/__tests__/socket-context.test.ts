import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { SocketContext, SocketContextFactory } from '../src/sockets/socket-context.ts';
import type { AppContext } from '../src/app-context.ts';
import type { WebSocketConnection } from '@orijs/websocket';
import { Logger } from '@orijs/logging';

describe('SocketContext', () => {
	let mockAppContext: AppContext;
	let mockWebSocket: WebSocketConnection<{ token: string }>;

	beforeEach(() => {
		Logger.reset();

		// Create mock app context
		mockAppContext = {
			container: {},
			event: {
				publish: mock(() => {})
			},
			eventCoordinator: {
				emit: mock(async () => {})
			},
			workflowCoordinator: {
				execute: mock(async () => ({}))
			},
			socket: {
				publish: mock(async () => {}),
				send: mock(() => {}),
				broadcast: mock(() => {}),
				emit: mock(async () => {})
			},
			hasWebSocket: true
		} as unknown as AppContext;

		// Create mock WebSocket
		mockWebSocket = {
			data: {
				socketId: 'socket-123',
				data: { token: 'test-token' },
				topics: new Set<string>()
			},
			send: mock(() => {}),
			subscribe: mock(() => {}),
			unsubscribe: mock(() => {}),
			publish: mock(() => {}),
			close: mock(() => {}),
			isSubscribed: mock(() => false),
			readyState: 1
		} as unknown as WebSocketConnection<{ token: string }>;
	});

	describe('basic properties', () => {
		test('should expose socketId', () => {
			const ctx = new SocketContext(
				mockAppContext,
				mockWebSocket,
				'heartbeat',
				{ timestamp: Date.now() },
				'corr-123',
				{}
			);

			expect(ctx.socketId).toBe('socket-123');
		});

		test('should expose messageType', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'heartbeat', {}, 'corr-123', {});

			expect(ctx.messageType).toBe('heartbeat');
		});

		test('should expose correlationId', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'my-correlation-id', {});

			expect(ctx.correlationId).toBe('my-correlation-id');
		});

		test('should expose message data', () => {
			const messageData = { room: 'lobby', action: 'join' };
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', messageData, 'corr-123', {});

			expect(ctx.data).toEqual(messageData);
		});

		test('should expose userData from WebSocket upgrade', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			expect(ctx.userData).toEqual({ token: 'test-token' });
		});

		test('should expose WebSocket connection', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			expect(ctx.ws).toBe(mockWebSocket);
		});

		test('should expose app context', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			expect(ctx.app).toBe(mockAppContext);
		});
	});

	describe('state management', () => {
		test('should initialize state lazily', () => {
			interface TestState {
				user?: { id: string };
			}

			const ctx = new SocketContext<TestState>(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			// Accessing state should create empty object
			expect(Object.keys(ctx.state)).toHaveLength(0);
		});

		test('should set and get state values', () => {
			interface TestState {
				user: { id: string; name: string };
			}

			const ctx = new SocketContext<TestState>(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			ctx.set('user', { id: 'user-123', name: 'Alice' });

			expect(ctx.state.user).toEqual({ id: 'user-123', name: 'Alice' });
			expect(ctx.get('user')).toEqual({ id: 'user-123', name: 'Alice' });
		});

		test('should support multiple state keys', () => {
			interface TestState {
				user: { id: string };
				permissions: string[];
				sessionId: string;
			}

			const ctx = new SocketContext<TestState>(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			ctx.set('user', { id: 'user-123' });
			ctx.set('permissions', ['read', 'write']);
			ctx.set('sessionId', 'session-456');

			expect(ctx.state.user).toEqual({ id: 'user-123' });
			expect(ctx.state.permissions).toEqual(['read', 'write']);
			expect(ctx.state.sessionId).toBe('session-456');
		});
	});

	describe('logger', () => {
		test('should provide logger with socket metadata', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'heartbeat', {}, 'corr-123', {});

			const log = ctx.log;

			expect(log).toBeInstanceOf(Logger);
		});

		test('should cache logger instance', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			const log1 = ctx.log;
			const log2 = ctx.log;

			expect(log1).toBe(log2);
		});
	});

	describe('WebSocket operations', () => {
		test('send() should stringify and send objects', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			ctx.send({ type: 'response', data: { ok: true } });

			expect(mockWebSocket.send).toHaveBeenCalledWith('{"type":"response","data":{"ok":true}}');
		});

		test('send() should send strings directly', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			ctx.send('plain text message');

			expect(mockWebSocket.send).toHaveBeenCalledWith('plain text message');
		});

		test('subscribe() should delegate to WebSocket', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			ctx.subscribe('my-topic');

			expect(mockWebSocket.subscribe).toHaveBeenCalledWith('my-topic');
		});

		test('unsubscribe() should delegate to WebSocket', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			ctx.unsubscribe('my-topic');

			expect(mockWebSocket.unsubscribe).toHaveBeenCalledWith('my-topic');
		});

		test('publish() should stringify and publish objects', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			ctx.publish('notifications', { event: 'new-message' });

			expect(mockWebSocket.publish).toHaveBeenCalledWith('notifications', '{"event":"new-message"}');
		});

		test('publish() should publish strings directly', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			ctx.publish('notifications', 'plain message');

			expect(mockWebSocket.publish).toHaveBeenCalledWith('notifications', 'plain message');
		});
	});

	describe('json()', () => {
		test('should return data as-is when already an object', () => {
			const messageData = { room: 'lobby', user: 'Alice' };
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', messageData, 'corr-123', {});

			const parsed = ctx.json<{ room: string; user: string }>();

			expect(parsed).toEqual(messageData);
		});

		test('should parse JSON string data', () => {
			const messageData = '{"room":"lobby","user":"Alice"}';
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', messageData, 'corr-123', {});

			const parsed = ctx.json<{ room: string; user: string }>();

			expect(parsed).toEqual({ room: 'lobby', user: 'Alice' });
		});
	});

	describe('events', () => {
		test('should provide event emitter', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			const events = ctx.events;

			expect(events).toBeDefined();
			expect(typeof events.emit).toBe('function');
		});

		test('should throw when event system not configured', () => {
			const appWithoutEvents = {
				...mockAppContext,
				eventCoordinator: undefined
			} as unknown as AppContext;

			const ctx = new SocketContext(appWithoutEvents, mockWebSocket, 'test', {}, 'corr-123', {});

			expect(() => ctx.events).toThrow('Event system not configured');
		});
	});

	describe('workflows', () => {
		test('should provide workflow executor', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			const workflows = ctx.workflows;

			expect(workflows).toBeDefined();
			expect(typeof workflows.execute).toBe('function');
		});

		test('should throw when workflow system not configured', () => {
			const appWithoutWorkflows = {
				...mockAppContext,
				workflowCoordinator: undefined
			} as unknown as AppContext;

			const ctx = new SocketContext(appWithoutWorkflows, mockWebSocket, 'test', {}, 'corr-123', {});

			expect(() => ctx.workflows).toThrow('Workflow system not configured');
		});
	});

	describe('socket emitter', () => {
		test('should provide socket emitter', () => {
			const ctx = new SocketContext(mockAppContext, mockWebSocket, 'test', {}, 'corr-123', {});

			const socket = ctx.socket;

			expect(socket).toBeDefined();
			expect(typeof socket.publish).toBe('function');
			expect(typeof socket.send).toBe('function');
			expect(typeof socket.broadcast).toBe('function');
		});
	});
});

describe('SocketContextFactory', () => {
	let mockAppContext: AppContext;
	let mockWebSocket: WebSocketConnection<unknown>;

	beforeEach(() => {
		Logger.reset();

		mockAppContext = {
			container: {},
			eventCoordinator: undefined,
			workflowCoordinator: undefined
		} as unknown as AppContext;

		mockWebSocket = {
			data: {
				socketId: 'socket-factory-test',
				data: undefined,
				connectionTime: Date.now()
			},
			send: mock(() => {}),
			subscribe: mock(() => {}),
			unsubscribe: mock(() => {}),
			publish: mock(() => {}),
			close: mock(() => {}),
			isSubscribed: mock(() => false),
			readyState: 1
		} as unknown as WebSocketConnection<unknown>;
	});

	test('should create context with provided parameters', () => {
		const factory = new SocketContextFactory(mockAppContext, {});

		const ctx = factory.create(mockWebSocket, 'heartbeat', { beat: true }, 'corr-456');

		expect(ctx).toBeInstanceOf(SocketContext);
		expect(ctx.messageType).toBe('heartbeat');
		expect(ctx.data).toEqual({ beat: true });
		expect(ctx.correlationId).toBe('corr-456');
	});

	test('should generate correlationId when not provided', () => {
		const factory = new SocketContextFactory(mockAppContext, {});

		const ctx = factory.create(mockWebSocket, 'test', {});

		expect(ctx.correlationId).toBeDefined();
		expect(ctx.correlationId.length).toBeGreaterThan(0);
		// Should be a valid UUID format
		expect(ctx.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});
