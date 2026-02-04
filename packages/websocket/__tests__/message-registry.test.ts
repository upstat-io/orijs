/**
 * Unit tests for MessageRegistry
 *
 * Tests the opinionated message handling with schema validation.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { Type } from '@orijs/validation';
import {
	MessageRegistry,
	createMessageRegistry,
	ServerMessage,
	JoinRoom,
	LeaveRoom,
	Heartbeat
} from '../src/index';
import type { SocketData } from '../src/types';

/** Mock WebSocket type */
type MockWebSocket = ServerWebSocket<SocketData<unknown>>;

/** Create a mock WebSocket */
function createMockWebSocket(): {
	ws: MockWebSocket;
	mocks: {
		subscribe: ReturnType<typeof mock>;
		unsubscribe: ReturnType<typeof mock>;
		send: ReturnType<typeof mock>;
	};
} {
	const subscribeMock = mock(() => {});
	const unsubscribeMock = mock(() => {});
	const sendMock = mock(() => {});

	const ws = {
		data: {
			socketId: '550e8400-e29b-41d4-a716-446655440001',
			data: {},
			topics: new Set<string>()
		},
		subscribe: subscribeMock,
		unsubscribe: unsubscribeMock,
		send: sendMock
	} as unknown as MockWebSocket;

	return {
		ws,
		mocks: {
			subscribe: subscribeMock,
			unsubscribe: unsubscribeMock,
			send: sendMock
		}
	};
}

describe('MessageRegistry', () => {
	let registry: MessageRegistry;

	beforeEach(() => {
		registry = new MessageRegistry();
	});

	describe('constructor', () => {
		it('should create registry with default options', () => {
			const r = new MessageRegistry();
			expect(r).toBeInstanceOf(MessageRegistry);
		});

		it('should create registry with custom logger', () => {
			const customLogger = {
				info: mock(() => {}),
				warn: mock(() => {}),
				error: mock(() => {}),
				debug: mock(() => {})
			};
			const r = new MessageRegistry({ logger: customLogger as never });
			expect(r).toBeInstanceOf(MessageRegistry);
		});
	});

	describe('factory function', () => {
		it('should create registry via createMessageRegistry', () => {
			const r = createMessageRegistry();
			expect(r).toBeInstanceOf(MessageRegistry);
		});

		it('should pass options to constructor', () => {
			const customLogger = {
				info: mock(() => {}),
				warn: mock(() => {}),
				error: mock(() => {}),
				debug: mock(() => {})
			};
			const r = createMessageRegistry({ logger: customLogger as never });
			expect(r).toBeInstanceOf(MessageRegistry);
		});
	});

	describe('on - handler registration', () => {
		it('should register a handler for a message type', () => {
			registry.on(JoinRoom, () => {});
			expect(registry.has('room.join')).toBe(true);
		});

		it('should return this for chaining', () => {
			const result = registry.on(JoinRoom, () => {});
			expect(result).toBe(registry);
		});

		it('should allow chaining multiple handlers', () => {
			const result = registry
				.on(JoinRoom, () => {})
				.on(LeaveRoom, () => {})
				.on(Heartbeat, () => {});

			expect(result).toBe(registry);
			expect(registry.has('room.join')).toBe(true);
			expect(registry.has('room.leave')).toBe(true);
			expect(registry.has('heartbeat')).toBe(true);
		});

		it('should warn when overwriting existing handler', () => {
			const warnMock = mock(() => {});
			const r = new MessageRegistry({
				logger: {
					info: mock(() => {}),
					warn: warnMock,
					error: mock(() => {}),
					debug: mock(() => {})
				} as never
			});

			r.on(JoinRoom, () => {});
			r.on(JoinRoom, () => {}); // Overwrite

			expect(warnMock).toHaveBeenCalled();
		});
	});

	describe('has - check handler existence', () => {
		it('should return false for unregistered type', () => {
			expect(registry.has('unknown.type')).toBe(false);
		});

		it('should return true for registered type', () => {
			registry.on(JoinRoom, () => {});
			expect(registry.has('room.join')).toBe(true);
		});
	});

	describe('getRegisteredTypes', () => {
		it('should return empty array when no handlers registered', () => {
			expect(registry.getRegisteredTypes()).toEqual([]);
		});

		it('should return all registered type names', () => {
			registry.on(JoinRoom, () => {}).on(LeaveRoom, () => {});

			const types = registry.getRegisteredTypes();
			expect(types).toContain('room.join');
			expect(types).toContain('room.leave');
			expect(types.length).toBe(2);
		});
	});

	describe('handle - message handling', () => {
		describe('unknown message types', () => {
			it('should return unknown_type for unregistered message', async () => {
				const { ws } = createMockWebSocket();

				const result = await registry.handle(ws, 'unknown.type', {});

				expect(result.handled).toBe(false);
				if (!result.handled) {
					expect(result.reason).toBe('unknown_type');
				}
			});
		});

		describe('validation', () => {
			it('should return validation_failed for invalid data', async () => {
				const { ws } = createMockWebSocket();
				registry.on(JoinRoom, () => {});

				// JoinRoom expects { room: string } with minLength: 1
				const result = await registry.handle(ws, 'room.join', { room: '' });

				expect(result.handled).toBe(false);
				if (!result.handled) {
					expect(result.reason).toBe('validation_failed');
					expect(result.details).toBeDefined();
				}
			});

			it('should return validation_failed for missing required fields', async () => {
				const { ws } = createMockWebSocket();
				registry.on(JoinRoom, () => {});

				const result = await registry.handle(ws, 'room.join', {});

				expect(result.handled).toBe(false);
				if (!result.handled) {
					expect(result.reason).toBe('validation_failed');
				}
			});

			it('should return validation_failed for wrong field types', async () => {
				const { ws } = createMockWebSocket();
				registry.on(JoinRoom, () => {});

				const result = await registry.handle(ws, 'room.join', { room: 123 });

				expect(result.handled).toBe(false);
				if (!result.handled) {
					expect(result.reason).toBe('validation_failed');
				}
			});
		});

		describe('successful handling', () => {
			it('should call handler with validated data for valid message', async () => {
				const { ws } = createMockWebSocket();
				const handlerMock = mock(() => {});
				registry.on(JoinRoom, handlerMock);

				const result = await registry.handle(ws, 'room.join', { room: 'test-room' });

				expect(result.handled).toBe(true);
				expect(handlerMock).toHaveBeenCalledWith(ws, { room: 'test-room' });
			});

			it('should pass correct data to handler for complex schema', async () => {
				const { ws } = createMockWebSocket();
				const handlerMock = mock(() => {});

				const ComplexMessage = ServerMessage.define({
					name: 'complex.message',
					data: Type.Object({
						id: Type.String(),
						count: Type.Number(),
						active: Type.Boolean()
					})
				});

				registry.on(ComplexMessage, handlerMock);

				const data = { id: 'abc', count: 42, active: true };
				const result = await registry.handle(ws, 'complex.message', data);

				expect(result.handled).toBe(true);
				expect(handlerMock).toHaveBeenCalledWith(ws, data);
			});

			it('should handle async handlers', async () => {
				const { ws } = createMockWebSocket();
				let resolved = false;

				registry.on(JoinRoom, async () => {
					await Promise.resolve();
					resolved = true;
				});

				const result = await registry.handle(ws, 'room.join', { room: 'test-room' });

				expect(result.handled).toBe(true);
				expect(resolved).toBe(true);
			});
		});

		describe('handler errors', () => {
			it('should throw when handler throws', async () => {
				const { ws } = createMockWebSocket();
				registry.on(JoinRoom, () => {
					throw new Error('Handler error');
				});

				await expect(registry.handle(ws, 'room.join', { room: 'test' })).rejects.toThrow('Handler error');
			});

			it('should throw when async handler rejects', async () => {
				const { ws } = createMockWebSocket();
				registry.on(JoinRoom, async () => {
					throw new Error('Async handler error');
				});

				await expect(registry.handle(ws, 'room.join', { room: 'test' })).rejects.toThrow(
					'Async handler error'
				);
			});
		});
	});

	describe('built-in control messages', () => {
		describe('JoinRoom', () => {
			it('should validate room field is required', async () => {
				const { ws } = createMockWebSocket();
				registry.on(JoinRoom, () => {});

				const result = await registry.handle(ws, 'room.join', {});
				expect(result.handled).toBe(false);
			});

			it('should validate room minimum length', async () => {
				const { ws } = createMockWebSocket();
				registry.on(JoinRoom, () => {});

				const result = await registry.handle(ws, 'room.join', { room: '' });
				expect(result.handled).toBe(false);
			});

			it('should validate room maximum length', async () => {
				const { ws } = createMockWebSocket();
				registry.on(JoinRoom, () => {});

				const result = await registry.handle(ws, 'room.join', { room: 'a'.repeat(256) });
				expect(result.handled).toBe(false);
			});

			it('should accept valid room name', async () => {
				const { ws } = createMockWebSocket();
				const handlerMock = mock(() => {});
				registry.on(JoinRoom, handlerMock);

				const result = await registry.handle(ws, 'room.join', { room: 'account:123' });
				expect(result.handled).toBe(true);
				expect(handlerMock).toHaveBeenCalled();
			});
		});

		describe('LeaveRoom', () => {
			it('should validate room field is required', async () => {
				const { ws } = createMockWebSocket();
				registry.on(LeaveRoom, () => {});

				const result = await registry.handle(ws, 'room.leave', {});
				expect(result.handled).toBe(false);
			});

			it('should accept valid room name', async () => {
				const { ws } = createMockWebSocket();
				const handlerMock = mock(() => {});
				registry.on(LeaveRoom, handlerMock);

				const result = await registry.handle(ws, 'room.leave', { room: 'account:123' });
				expect(result.handled).toBe(true);
				expect(handlerMock).toHaveBeenCalled();
			});
		});

		describe('Heartbeat', () => {
			it('should accept empty object', async () => {
				const { ws } = createMockWebSocket();
				const handlerMock = mock(() => {});
				registry.on(Heartbeat, handlerMock);

				const result = await registry.handle(ws, 'heartbeat', {});
				expect(result.handled).toBe(true);
				expect(handlerMock).toHaveBeenCalled();
			});
		});
	});

	describe('ServerMessage.define', () => {
		it('should create frozen message definition', () => {
			const message = ServerMessage.define({
				name: 'test.message',
				data: Type.Object({ value: Type.String() })
			});

			expect(message.name).toBe('test.message');
			expect(message.dataSchema).toBeDefined();
			expect(Object.isFrozen(message)).toBe(true);
		});

		it('should work with complex schemas', () => {
			const message = ServerMessage.define({
				name: 'complex.message',
				data: Type.Object({
					nested: Type.Object({
						value: Type.Number()
					}),
					array: Type.Array(Type.String()),
					optional: Type.Optional(Type.Boolean())
				})
			});

			expect(message.name).toBe('complex.message');
		});
	});

	describe('integration with mock WebSocket', () => {
		it('should allow handler to call ws.subscribe', async () => {
			const { ws, mocks } = createMockWebSocket();

			registry.on(JoinRoom, (socket, data) => {
				// data.room is properly typed as string
				socket.subscribe(data.room);
			});

			await registry.handle(ws, 'room.join', { room: 'my-room' });

			expect(mocks.subscribe).toHaveBeenCalledWith('my-room');
		});

		it('should allow handler to call ws.unsubscribe', async () => {
			const { ws, mocks } = createMockWebSocket();

			registry.on(LeaveRoom, (socket, data) => {
				// data.room is properly typed as string
				socket.unsubscribe(data.room);
			});

			await registry.handle(ws, 'room.leave', { room: 'my-room' });

			expect(mocks.unsubscribe).toHaveBeenCalledWith('my-room');
		});

		it('should allow handler to call ws.send', async () => {
			const { ws, mocks } = createMockWebSocket();

			registry.on(Heartbeat, (socket) => {
				socket.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
			});

			await registry.handle(ws, 'heartbeat', {});

			expect(mocks.send).toHaveBeenCalled();
		});
	});
});
