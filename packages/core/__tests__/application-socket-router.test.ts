/**
 * Integration tests for Socket Router pattern.
 *
 * Verifies:
 * - .socketRouter() fluent API
 * - Connection guards execution (run ONCE on connect)
 * - Message routing to handlers
 * - State persistence across messages
 * - Schema validation
 * - Guard and handler coordination
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Application, Ori } from '../src/index.ts';
import { Logger } from '@orijs/logging';
import type {
	OriSocketRouter,
	SocketRouteBuilder as ISocketRouteBuilder,
	SocketGuard,
	SocketContextLike
} from '../src/types/index.ts';
import type { SocketContext } from '../src/sockets/socket-context.ts';
import { Type } from '@orijs/validation';

/**
 * Polls a condition until it returns true or timeout is reached.
 */
async function waitFor(
	condition: () => boolean,
	options: { timeout?: number; interval?: number } = {}
): Promise<void> {
	const { timeout = 2000, interval = 10 } = options;
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeout) {
			throw new Error(`waitFor timed out after ${timeout}ms`);
		}
		await Bun.sleep(interval);
	}
}

/**
 * Parsed WebSocket message shape.
 */
interface ParsedMessage {
	type?: string;
	data?: unknown;
	error?: string;
	correlationId?: string;
}

/**
 * Waits for a WebSocket message matching a predicate.
 */
async function waitForMessage(
	messages: string[],
	predicate: (msg: ParsedMessage) => boolean,
	options: { timeout?: number } = {}
): Promise<ParsedMessage> {
	const { timeout = 2000 } = options;
	const start = Date.now();

	while (Date.now() - start < timeout) {
		for (const msg of messages) {
			try {
				const parsed = JSON.parse(msg);
				if (predicate(parsed)) {
					return parsed;
				}
			} catch {
				// Not JSON, skip
			}
		}
		await Bun.sleep(10);
	}

	throw new Error(`waitForMessage timed out after ${timeout}ms`);
}

describe('Application Socket Router Integration', () => {
	let app: Application;
	let port = 19000;

	const getPort = () => ++port;
	const getWsUrl = () => `ws://localhost:${port}/ws`;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(async () => {
		await app?.stop();
	});

	describe('.socketRouter() registration', () => {
		test('should register socket router', async () => {
			interface TestState {
				greeting: string;
			}

			class HelloRouter implements OriSocketRouter<TestState> {
				configure(r: ISocketRouteBuilder<TestState>) {
					r.on('hello', this.handleHello);
				}

				private handleHello = (_ctx: SocketContext<TestState>) => {
					return { message: 'Hello, World!' };
				};
			}

			app = Ori.create().websocket().socketRouter(HelloRouter);

			await app.listen(getPort());

			// Connect and send message
			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Send hello message
			ws.send(JSON.stringify({ type: 'hello' }));

			// Wait for response
			const response = await waitForMessage(receivedMessages, (msg) => msg.type === 'hello');

			expect(response).toMatchObject({
				type: 'hello',
				data: { message: 'Hello, World!' }
			});

			ws.close();
		});

		test('should chain after .socketRouter()', async () => {
			class DummyRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.on('ping', () => ({ pong: true }));
				}
			}

			class AnotherRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.on('status', () => ({ status: 'ok' }));
				}
			}

			app = Ori.create().websocket().socketRouter(DummyRouter).socketRouter(AnotherRouter);

			await app.listen(getPort());

			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Test both routers
			ws.send(JSON.stringify({ type: 'ping' }));
			ws.send(JSON.stringify({ type: 'status' }));

			await waitForMessage(receivedMessages, (msg) => msg.type === 'ping');
			await waitForMessage(receivedMessages, (msg) => msg.type === 'status');

			ws.close();
		});
	});

	describe('connection guards', () => {
		test('should run connection guard ONCE and allow connection', async () => {
			let guardCalled = false;

			class AllowGuard implements SocketGuard {
				canActivate(): boolean {
					guardCalled = true;
					return true;
				}
			}

			class GuardedRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.connectionGuard(AllowGuard);
					r.on('test', () => ({ ok: true }));
				}
			}

			app = Ori.create().websocket().socketRouter(GuardedRouter);

			await app.listen(getPort());

			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Guard runs asynchronously after connection opens
			await waitFor(() => guardCalled);
			expect(guardCalled).toBe(true);

			// Verify we can send a message (proves connection stayed open)
			const receivedMessages: string[] = [];
			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};
			ws.send(JSON.stringify({ type: 'test' }));
			await waitForMessage(receivedMessages, (msg) => msg.type === 'test');

			ws.close();
		});

		test('should reject connection when guard returns false', async () => {
			class DenyGuard implements SocketGuard {
				canActivate(): boolean {
					return false;
				}
			}

			class GuardedRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.connectionGuard(DenyGuard);
					r.on('test', () => ({ ok: true }));
				}
			}

			app = Ori.create().websocket().socketRouter(GuardedRouter);

			await app.listen(getPort());

			let connectionClosed = false;
			let closeCode: number | undefined;

			const ws = new WebSocket(getWsUrl());

			// The connection opens first (WebSocket handshake completes),
			// then the connection guard runs async and closes it if rejected.
			await new Promise<void>((resolve) => {
				ws.onopen = () => {
					// Connection opened - guard will close it shortly
				};
				ws.onclose = (event) => {
					connectionClosed = true;
					closeCode = event.code;
					resolve();
				};
				ws.onerror = () => {
					// May or may not fire depending on timing
				};
			});

			// Connection should be closed by the guard
			expect(connectionClosed).toBe(true);
			// Close code 1008 = Policy Violation (connection rejected by guard)
			expect(closeCode).toBe(1008);
		});

		test('should persist state from connection guard across messages', async () => {
			interface AuthState {
				userId: string;
				role: string;
			}

			class AuthGuard implements SocketGuard {
				canActivate(ctx: SocketContextLike): boolean {
					ctx.set('userId', 'user-123');
					ctx.set('role', 'admin');
					return true;
				}
			}

			class StatefulRouter implements OriSocketRouter<AuthState> {
				configure(r: ISocketRouteBuilder<AuthState>) {
					r.connectionGuard(AuthGuard);
					r.on('whoami', this.handleWhoami);
				}

				private handleWhoami = (ctx: SocketContext<AuthState>) => {
					return { userId: ctx.state.userId, role: ctx.state.role };
				};
			}

			app = Ori.create().websocket().socketRouter(StatefulRouter);

			await app.listen(getPort());

			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Wait a bit for connection guard to run
			await Bun.sleep(50);

			// Send first message and wait for response
			ws.send(JSON.stringify({ type: 'whoami' }));
			await waitFor(() => receivedMessages.length >= 1);

			// Send second message and wait for response
			ws.send(JSON.stringify({ type: 'whoami' }));
			await waitFor(() => receivedMessages.length >= 2);

			// Parse responses
			const response1 = JSON.parse(receivedMessages[0]!);
			const response2 = JSON.parse(receivedMessages[1]!);

			// Both messages should have the same state from connection guard
			expect(response1).toMatchObject({
				type: 'whoami',
				data: { userId: 'user-123', role: 'admin' }
			});
			expect(response2).toMatchObject({
				type: 'whoami',
				data: { userId: 'user-123', role: 'admin' }
			});

			ws.close();
		});
	});

	describe('message guards', () => {
		test('should run message guard on each message', async () => {
			let guardCallCount = 0;

			class CountingGuard implements SocketGuard {
				canActivate(): boolean {
					guardCallCount++;
					return true;
				}
			}

			class GuardedMessageRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.guard(CountingGuard);
					r.on('test', () => ({ ok: true }));
				}
			}

			app = Ori.create().websocket().socketRouter(GuardedMessageRouter);

			await app.listen(getPort());

			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Send 3 messages
			ws.send(JSON.stringify({ type: 'test' }));
			ws.send(JSON.stringify({ type: 'test' }));
			ws.send(JSON.stringify({ type: 'test' }));

			await waitFor(() => guardCallCount >= 3);

			expect(guardCallCount).toBe(3);

			ws.close();
		});

		test('should send Forbidden when message guard denies', async () => {
			class DenyMessageGuard implements SocketGuard {
				canActivate(): boolean {
					return false;
				}
			}

			class GuardedMessageRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.guard(DenyMessageGuard);
					r.on('test', () => ({ ok: true }));
				}
			}

			app = Ori.create().websocket().socketRouter(GuardedMessageRouter);

			await app.listen(getPort());

			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			ws.send(JSON.stringify({ type: 'test' }));

			const response = await waitForMessage(receivedMessages, (msg) => msg.type === 'test');

			expect(response).toMatchObject({
				type: 'test',
				error: 'Forbidden'
			});

			ws.close();
		});
	});

	describe('schema validation', () => {
		test('should validate message data against schema', async () => {
			const SubscribeSchema = Type.Object({
				room: Type.String({ minLength: 1 }),
				options: Type.Optional(
					Type.Object({
						silent: Type.Boolean()
					})
				)
			});

			class ValidatedRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.on('subscribe', this.handleSubscribe, SubscribeSchema);
				}

				private handleSubscribe = (ctx: SocketContext) => {
					const data = ctx.data as { room: string };
					return { subscribed: data.room };
				};
			}

			app = Ori.create().websocket().socketRouter(ValidatedRouter);

			await app.listen(getPort());

			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Send invalid data (empty room)
			ws.send(JSON.stringify({ type: 'subscribe', data: { room: '' } }));

			const errorResponse = await waitForMessage(receivedMessages, (msg) => !!msg.error);

			expect(errorResponse).toMatchObject({
				type: 'subscribe',
				error: expect.stringContaining('Validation failed')
			});

			// Send valid data
			ws.send(JSON.stringify({ type: 'subscribe', data: { room: 'lobby' } }));

			const successResponse = await waitForMessage(
				receivedMessages,
				(msg) => msg.type === 'subscribe' && !msg.error
			);

			expect(successResponse).toMatchObject({
				type: 'subscribe',
				data: { subscribed: 'lobby' }
			});

			ws.close();
		});
	});

	describe('correlation ID', () => {
		test('should echo back correlationId when provided', async () => {
			class EchoRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.on('echo', (ctx) => ({ received: ctx.data }));
				}
			}

			app = Ori.create().websocket().socketRouter(EchoRouter);

			await app.listen(getPort());

			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			ws.send(
				JSON.stringify({
					type: 'echo',
					data: { message: 'hello' },
					correlationId: 'corr-12345'
				})
			);

			const response = await waitForMessage(receivedMessages, (msg) => msg.correlationId === 'corr-12345');

			expect(response).toMatchObject({
				type: 'echo',
				correlationId: 'corr-12345'
			});

			ws.close();
		});
	});

	describe('dependency injection', () => {
		test('should inject dependencies into socket router', async () => {
			class GreetingService {
				greet(name: string): string {
					return `Hello, ${name}!`;
				}
			}

			class GreetingRouter implements OriSocketRouter {
				constructor(private greetingService: GreetingService) {}

				configure(r: ISocketRouteBuilder) {
					r.on('greet', this.handleGreet);
				}

				private handleGreet = (ctx: SocketContext) => {
					const data = ctx.data as { name: string };
					return { greeting: this.greetingService.greet(data.name) };
				};
			}

			app = Ori.create()
				.websocket()
				.provider(GreetingService)
				.socketRouter(GreetingRouter, [GreetingService]);

			await app.listen(getPort());

			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			ws.send(JSON.stringify({ type: 'greet', data: { name: 'Alice' } }));

			const response = await waitForMessage(receivedMessages, (msg) => msg.type === 'greet');

			expect(response).toMatchObject({
				type: 'greet',
				data: { greeting: 'Hello, Alice!' }
			});

			ws.close();
		});
	});

	describe('unhandled messages', () => {
		test('should fall back to onWebSocket handler for unhandled message types', async () => {
			const fallbackMessages: string[] = [];

			class PartialRouter implements OriSocketRouter {
				configure(r: ISocketRouteBuilder) {
					r.on('handled', () => ({ handled: true }));
				}
			}

			app = Ori.create()
				.websocket()
				.socketRouter(PartialRouter)
				.onWebSocket({
					open: () => {},
					message: (_ws, msg) => {
						if (typeof msg === 'string') {
							fallbackMessages.push(msg);
						}
					},
					close: () => {}
				});

			await app.listen(getPort());

			const receivedMessages: string[] = [];
			const ws = new WebSocket(getWsUrl());

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Send handled message
			ws.send(JSON.stringify({ type: 'handled' }));
			await waitForMessage(receivedMessages, (msg) => msg.type === 'handled');

			// Send unhandled message (should go to fallback)
			ws.send(JSON.stringify({ type: 'unknown' }));
			await waitFor(() => fallbackMessages.length > 0);

			expect(fallbackMessages[0]).toContain('unknown');

			ws.close();
		});
	});
});
