/**
 * Integration tests for Application WebSocket support.
 *
 * Verifies:
 * - .websocket() fluent API configuration
 * - .onWebSocket() handler registration
 * - ctx.socket access in controllers
 * - appContext.socket access in services
 * - WebSocket upgrade and connection flow
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Application, Ori } from '../src/index.ts';
import { Logger } from '@orijs/logging';
import type { OriController, RouteBuilder } from '../src/types/index.ts';
import type { SocketEmitter, WebSocketConnection } from '@orijs/websocket';
import { InProcWsProvider } from '@orijs/websocket';

/**
 * Polls a condition until it returns true or timeout is reached.
 * More robust than fixed Bun.sleep for async operations.
 */
async function waitFor(
	condition: () => boolean,
	options: { timeout?: number; interval?: number } = {}
): Promise<void> {
	const { timeout = 1000, interval = 10 } = options;
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeout) {
			throw new Error(`waitFor timed out after ${timeout}ms`);
		}
		await Bun.sleep(interval);
	}
}

describe('Application WebSocket Integration', () => {
	let app: Application;
	let port = 18000;

	const getPort = () => ++port;
	const getBaseUrl = () => `http://localhost:${port}`;
	const getWsUrl = () => `ws://localhost:${port}/ws`;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(async () => {
		await app?.stop();
	});

	describe('.websocket() configuration', () => {
		test('should configure websocket with default provider', async () => {
			app = Ori.create().websocket();

			expect(app.getWebSocketProvider()).toBeDefined();
			expect(app.getWebSocketCoordinator()).toBeDefined();
		});

		test('should configure websocket with custom provider', async () => {
			const provider = new InProcWsProvider();

			app = Ori.create().websocket(provider);

			expect(app.getWebSocketProvider()).toBe(provider);
			expect(app.getWebSocketCoordinator()).toBeDefined();
		});

		test('should configure websocket with custom emitter class', async () => {
			// Custom emitter with domain-specific methods
			class NotificationEmitter implements SocketEmitter {
				constructor(private readonly provider: import('@orijs/websocket').WebSocketProvider) {}

				// Domain-specific method
				notifyUser(userId: string, payload: object): void {
					this.publish(`user:${userId}`, JSON.stringify(payload)).catch(() => {});
				}

				// Standard SocketEmitter interface
				publish(topic: string, message: string | ArrayBuffer): Promise<void> {
					return this.provider.publish(topic, message);
				}

				send(socketId: string, message: string | ArrayBuffer): void {
					this.provider.send(socketId, message);
				}

				broadcast(message: string | ArrayBuffer): void {
					this.provider.broadcast(message);
				}

				emit<TData>(
					message: import('@orijs/websocket').SocketMessageLike<TData>,
					topic: string,
					data: TData
				): Promise<void> {
					return this.provider.emit(message, topic, data);
				}
			}

			app = Ori.create().websocket(undefined, { emitter: NotificationEmitter });

			await app.listen(getPort());

			// Get the emitter and verify it's our custom class
			const emitter = app.getSocketEmitter<NotificationEmitter>();
			expect(emitter).toBeInstanceOf(NotificationEmitter);
			expect(typeof emitter.notifyUser).toBe('function');
		});

		test('should chain after .websocket()', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().websocket().controller('/api', TestController);

			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(response.status).toBe(200);
		});

		test('should throw when accessing socket without .websocket() configuration', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (ctx) => {
						// This should throw because websocket is not configured
						const socket = ctx.socket;
						return Response.json({ hasSocket: !!socket });
					});
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			// The error is caught by the request pipeline and returns 500
			expect(response.status).toBe(500);
		});

		test('should throw when calling getSocketEmitter without .websocket() configuration', () => {
			app = Ori.create();

			expect(() => app.getSocketEmitter()).toThrow('WebSocket not configured');
			expect(() => app.getSocketEmitter()).toThrow('.websocket()');
		});
	});

	describe('.onWebSocket() handlers', () => {
		test('should register WebSocket handlers', async () => {
			const connections: string[] = [];

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						connections.push(ws.data?.socketId ?? 'unknown');
					},
					message: () => {},
					close: () => {}
				});

			await app.listen(getPort());

			// Connect via WebSocket
			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Wait for connection to be tracked
			await waitFor(() => connections.length >= 1);

			expect(connections.length).toBe(1);
			ws.close();
		});

		test('should chain after .onWebSocket()', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: () => {},
					message: () => {},
					close: () => {}
				})
				.controller('/api', TestController);

			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(response.status).toBe(200);
		});
	});

	describe('ctx.socket in controllers', () => {
		test('should provide socket emitter in request context', async () => {
			let capturedSocket: SocketEmitter | undefined;

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (ctx) => {
						capturedSocket = ctx.socket;
						return Response.json({ hasSocket: !!ctx.socket });
					});
				}
			}

			app = Ori.create().websocket().controller('/api', TestController);

			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(response.status).toBe(200);
			expect(capturedSocket).toBeDefined();
			expect(typeof capturedSocket?.publish).toBe('function');
		});

		test('should allow publishing from controller via ctx.socket', async () => {
			const receivedMessages: string[] = [];

			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/notify', (ctx) => {
						ctx.socket.publish('test-topic', 'notification');
						return Response.json({ sent: true });
					});
				}
			}

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// Use the native Bun WebSocket subscribe method
						ws.subscribe('test-topic');
					},
					message: () => {},
					close: () => {}
				})
				.controller('/api', TestController);

			await app.listen(getPort());

			// Connect WebSocket client and subscribe to topic
			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Set up message handler
			let subscriptionReady = false;
			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Brief delay to ensure subscription is registered on server
			await Bun.sleep(20);
			subscriptionReady = true;

			// Call controller endpoint to publish
			await waitFor(() => subscriptionReady);
			const response = await fetch(`${getBaseUrl()}/api/notify`, { method: 'POST' });
			expect(response.status).toBe(200);

			// Wait for message to be received
			await waitFor(() => receivedMessages.length > 0);

			expect(receivedMessages.length).toBeGreaterThan(0);
			expect(receivedMessages).toContain('notification');

			ws.close();
		});
	});

	describe('appContext.socket in services', () => {
		test('should provide socket emitter via AppContext', async () => {
			let hasSocket = false;

			class NotificationService {
				constructor(private readonly ctx: import('../src/app-context.ts').AppContext) {}

				checkSocket(): boolean {
					return this.ctx.hasWebSocket;
				}
			}

			class TestController implements OriController {
				constructor(private notificationService: NotificationService) {}
				configure(r: RouteBuilder) {
					r.get('/', () => {
						hasSocket = this.notificationService.checkSocket();
						return Response.json({ hasSocket });
					});
				}
			}

			const { AppContext } = await import('../src/app-context.ts');

			app = Ori.create()
				.websocket()
				.provider(NotificationService, [AppContext])
				.controller('/api', TestController, [NotificationService]);

			await app.listen(getPort());

			const response = await fetch(`${getBaseUrl()}/api`);
			expect(response.status).toBe(200);
			expect(hasSocket).toBe(true);
		});

		test('should allow publishing from service via appContext.socket', async () => {
			const receivedMessages: string[] = [];

			class NotificationService {
				constructor(private readonly ctx: import('../src/app-context.ts').AppContext) {}

				sendNotification(topic: string, message: string): void {
					this.ctx.socket.publish(topic, message);
				}
			}

			class TestController implements OriController {
				constructor(private notificationService: NotificationService) {}
				configure(r: RouteBuilder) {
					r.post('/notify', () => {
						this.notificationService.sendNotification('service-topic', 'from-service');
						return Response.json({ sent: true });
					});
				}
			}

			const { AppContext } = await import('../src/app-context.ts');

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// Use native Bun WebSocket subscribe
						ws.subscribe('service-topic');
					},
					message: () => {},
					close: () => {}
				})
				.provider(NotificationService, [AppContext])
				.controller('/api', TestController, [NotificationService]);

			await app.listen(getPort());

			// Connect WebSocket client
			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Brief delay to ensure subscription is registered on server
			await Bun.sleep(20);

			// Call controller endpoint
			const response = await fetch(`${getBaseUrl()}/api/notify`, { method: 'POST' });
			expect(response.status).toBe(200);

			// Wait for message to be received
			await waitFor(() => receivedMessages.length > 0);

			expect(receivedMessages).toContain('from-service');

			ws.close();
		});
	});

	describe('WebSocket connection flow', () => {
		test('should establish WebSocket connection via /ws path', async () => {
			let connectionOpened = false;
			let connectionClosed = false;

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: () => {
						connectionOpened = true;
					},
					message: () => {},
					close: () => {
						connectionClosed = true;
					}
				});

			await app.listen(getPort());

			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			expect(connectionOpened).toBe(true);

			ws.close();
			await waitFor(() => connectionClosed);

			expect(connectionClosed).toBe(true);
		});

		test('should handle custom WebSocket path', async () => {
			let connectionOpened = false;

			app = Ori.create()
				.websocket(undefined, { path: '/custom-ws' })
				.onWebSocket({
					open: () => {
						connectionOpened = true;
					},
					message: () => {},
					close: () => {}
				});

			await app.listen(getPort());

			const ws = new WebSocket(`ws://localhost:${port}/custom-ws`);
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = () => reject(new Error('Connection failed'));
			});

			expect(connectionOpened).toBe(true);
			ws.close();
		});

		test('should reject WebSocket connection when upgrade handler returns null', async () => {
			let connectionOpened = false;
			let connectionErrored = false;

			app = Ori.create()
				.websocket(undefined, {
					upgrade: () => {
						// Return null to reject the connection
						return null;
					}
				})
				.onWebSocket({
					open: () => {
						connectionOpened = true;
					},
					message: () => {},
					close: () => {}
				});

			await app.listen(getPort());

			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => {
					connectionOpened = true;
					resolve();
				};
				ws.onerror = () => {
					connectionErrored = true;
					resolve();
				};
				ws.onclose = () => {
					resolve();
				};
			});

			// Connection should have been rejected
			expect(connectionOpened).toBe(false);
			expect(connectionErrored).toBe(true);
		});

		test('should reject WebSocket connection when upgrade handler throws', async () => {
			let connectionOpened = false;
			let connectionErrored = false;

			app = Ori.create()
				.websocket(undefined, {
					upgrade: () => {
						throw new Error('Upgrade validation failed');
					}
				})
				.onWebSocket({
					open: () => {
						connectionOpened = true;
					},
					message: () => {},
					close: () => {}
				});

			await app.listen(getPort());

			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => {
					connectionOpened = true;
					resolve();
				};
				ws.onerror = () => {
					connectionErrored = true;
					resolve();
				};
				ws.onclose = () => {
					resolve();
				};
			});

			// Connection should have been rejected due to error
			expect(connectionOpened).toBe(false);
			expect(connectionErrored).toBe(true);
		});

		test('should receive messages from WebSocket clients', async () => {
			const receivedMessages: string[] = [];

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: () => {},
					message: (_ws: WebSocketConnection<unknown>, message: string | Buffer) => {
						receivedMessages.push(message.toString());
					},
					close: () => {}
				});

			await app.listen(getPort());

			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.send('hello from client');
			await waitFor(() => receivedMessages.length > 0);

			expect(receivedMessages).toContain('hello from client');
			ws.close();
		});

		test('should automatically track connections in coordinator', async () => {
			// No manual tracking needed - the framework handles it automatically
			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: () => {},
					message: () => {},
					close: () => {}
				});

			await app.listen(getPort());

			const coordinator = app.getWebSocketCoordinator();
			expect(coordinator?.getConnectionCount()).toBe(0);

			// Connect - framework should automatically add to coordinator
			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			await waitFor(() => coordinator?.getConnectionCount() === 1);
			expect(coordinator?.getConnectionCount()).toBe(1);

			// Disconnect - framework should automatically remove from coordinator
			ws.close();
			await waitFor(() => coordinator?.getConnectionCount() === 0);
			expect(coordinator?.getConnectionCount()).toBe(0);
		});
	});

	describe('WebSocket provider lifecycle', () => {
		test('should start provider during listen()', async () => {
			const provider = new InProcWsProvider();

			app = Ori.create().websocket(provider);

			// Provider not started yet
			expect(provider.getConnectionCount()).toBe(0);

			await app.listen(getPort());

			// Provider should be started
			expect(app.getWebSocketProvider()).toBe(provider);
		});

		test('should stop provider during app.stop()', async () => {
			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// Subscribe to topic via native Bun
						ws.subscribe('test');
					},
					message: () => {},
					close: () => {}
				});

			await app.listen(getPort());

			// Connect a client
			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Brief delay to ensure connection is fully tracked
			await Bun.sleep(20);

			const provider = app.getWebSocketProvider();
			// Provider has connections tracked
			expect(provider).toBeDefined();

			// Stop the app
			await app.stop();

			// Provider should be cleaned up
			expect(provider?.getConnectionCount()).toBe(0);

			ws.close();
		});

		test('should close connections during graceful shutdown', async () => {
			let serverSideCloseTriggered = false;

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: () => {},
					message: () => {},
					close: () => {
						serverSideCloseTriggered = true;
					}
				});

			await app.listen(getPort());

			// Connect a client
			const ws = new WebSocket(getWsUrl());
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Brief delay to ensure connection is tracked
			await Bun.sleep(20);

			// Verify connection is tracked
			expect(app.getWebSocketCoordinator()?.getConnectionCount()).toBe(1);

			// Stop the app - should drain connections
			await app.stop();

			// Server-side close handler should have been called
			expect(serverSideCloseTriggered).toBe(true);

			// Coordinator should have no connections
			expect(app.getWebSocketCoordinator()?.getConnectionCount()).toBe(0);

			ws.close();
		});
	});

	describe('hasWebSocket check', () => {
		test('should return false when websocket not configured', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().controller('/api', TestController);
			await app.listen(getPort());

			expect(app.context.hasWebSocket).toBe(false);
		});

		test('should return true when websocket is configured', async () => {
			class TestController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', () => Response.json({ ok: true }));
				}
			}

			app = Ori.create().websocket().controller('/api', TestController);

			await app.listen(getPort());

			expect(app.context.hasWebSocket).toBe(true);
		});
	});

	describe('async handler error handling', () => {
		test('should catch and log errors from async message handlers', async () => {
			const loggedErrors: unknown[] = [];

			const port = getPort();

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: () => {},
					message: async () => {
						// Simulate async error
						await Promise.resolve();
						throw new Error('Async handler error');
					},
					close: () => {}
				});

			// Capture log errors
			const originalError = app['appLogger'].error;
			app['appLogger'].error = (msg: string, meta?: Record<string, unknown>) => {
				loggedErrors.push({ msg, meta });
				originalError.call(app['appLogger'], msg, meta);
			};

			await app.listen(port);

			// Connect and send message
			const ws = new WebSocket(`ws://localhost:${port}/ws`);

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Send message to trigger async error
			ws.send('test message');

			// Wait for async error to be caught and logged
			await waitFor(
				() => loggedErrors.some((e) => (e as { msg: string }).msg.includes('message handler error')),
				{ timeout: 500 }
			);

			ws.close();

			expect(loggedErrors.some((e) => (e as { msg: string }).msg.includes('message handler error'))).toBe(
				true
			);
		});

		test('should catch and log errors from sync handlers', async () => {
			const loggedErrors: unknown[] = [];

			const port = getPort();

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: () => {},
					message: () => {
						// Sync error
						throw new Error('Sync handler error');
					},
					close: () => {}
				});

			// Capture log errors
			const originalError = app['appLogger'].error;
			app['appLogger'].error = (msg: string, meta?: Record<string, unknown>) => {
				loggedErrors.push({ msg, meta });
				originalError.call(app['appLogger'], msg, meta);
			};

			await app.listen(port);

			// Connect and send message
			const ws = new WebSocket(`ws://localhost:${port}/ws`);

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Send message to trigger sync error
			ws.send('test message');

			// Wait for error to be logged
			await waitFor(
				() => loggedErrors.some((e) => (e as { msg: string }).msg.includes('message handler error')),
				{ timeout: 500 }
			);

			ws.close();

			expect(loggedErrors.some((e) => (e as { msg: string }).msg.includes('message handler error'))).toBe(
				true
			);
		});
	});

	describe('open handler with direct provider access', () => {
		/**
		 * This test replicates the issue where users call both:
		 * 1. ws.subscribe(topic) - which is intercepted by the proxy
		 * 2. provider.subscribe(socketId, topic) - direct call to provider
		 *
		 * This is a common pattern when users explicitly manage Redis subscriptions
		 * like in redis-server.ts test harness.
		 */
		test('should NOT throw error when open handler subscribes to topics via proxy', async () => {
			const loggedErrors: unknown[] = [];
			const provider = new InProcWsProvider();

			const port = getPort();

			app = Ori.create()
				.websocket(provider)
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// This simulates what redis-server.ts does:
						// 1. Subscribe via ws.subscribe (proxied to coordinator)
						ws.subscribe('test-room');
						// 2. Subscribe to socket-specific channel
						ws.subscribe(`__socket__:${ws.data.socketId}`);
					},
					message: () => {},
					close: () => {}
				});

			// Capture log errors
			const originalError = app['appLogger'].error;
			app['appLogger'].error = (msg: string, meta?: Record<string, unknown>) => {
				loggedErrors.push({ msg, meta });
				originalError.call(app['appLogger'], msg, meta);
			};

			await app.listen(port);

			// Connect
			const ws = new WebSocket(`ws://localhost:${port}/ws`);
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Wait a bit for any async errors to surface
			await Bun.sleep(50);

			ws.close();

			// Should NOT have logged any open handler errors
			const openHandlerErrors = loggedErrors.filter((e) =>
				(e as { msg: string }).msg.includes('open handler error')
			);
			expect(openHandlerErrors.length).toBe(0);
		});

		test('should NOT throw error when open handler also directly calls provider.subscribe', async () => {
			const loggedErrors: unknown[] = [];
			const provider = new InProcWsProvider();

			const port = getPort();

			app = Ori.create()
				.websocket(provider)
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// This is what redis-server.ts currently does (redundantly):
						// 1. Subscribe via ws.subscribe (proxied)
						ws.subscribe('test-room');
						// 2. ALSO directly call provider.subscribe (redundant but should not error)
						provider.subscribe(ws.data.socketId, 'test-room');
					},
					message: () => {},
					close: () => {}
				});

			// Capture log errors
			const originalError = app['appLogger'].error;
			app['appLogger'].error = (msg: string, meta?: Record<string, unknown>) => {
				loggedErrors.push({ msg, meta });
				originalError.call(app['appLogger'], msg, meta);
			};

			await app.listen(port);

			// Connect
			const ws = new WebSocket(`ws://localhost:${port}/ws`);
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Wait a bit for any async errors to surface
			await Bun.sleep(50);

			ws.close();

			// Should NOT have logged any open handler errors
			const openHandlerErrors = loggedErrors.filter((e) =>
				(e as { msg: string }).msg.includes('open handler error')
			);
			expect(openHandlerErrors.length).toBe(0);
		});

		test('should properly route subscriptions through coordinator proxy', async () => {
			const provider = new InProcWsProvider();
			const receivedMessages: string[] = [];

			const port = getPort();

			app = Ori.create()
				.websocket(provider)
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// Subscribe via the proxy (should work with coordinator)
						ws.subscribe('notifications');
					},
					message: () => {},
					close: () => {}
				});

			await app.listen(port);

			// Connect client
			const ws = new WebSocket(`ws://localhost:${port}/ws`);
			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			// Brief delay to ensure subscription is registered
			await Bun.sleep(20);

			// Publish via provider
			await provider.publish('notifications', 'test-message');

			// Wait for message
			await waitFor(() => receivedMessages.length > 0, { timeout: 1000 });

			expect(receivedMessages).toContain('test-message');

			ws.close();
		});

		test('should NOT throw error when open handler calls ws.send()', async () => {
			const loggedErrors: unknown[] = [];
			const provider = new InProcWsProvider();
			const receivedMessages: string[] = [];

			const port = getPort();

			app = Ori.create()
				.websocket(provider)
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// This simulates redis-server.ts sending welcome message
						ws.send(
							JSON.stringify({
								name: 'server.welcome',
								data: { socketId: ws.data.socketId },
								timestamp: Date.now()
							})
						);
					},
					message: () => {},
					close: () => {}
				});

			// Capture log errors
			const originalError = app['appLogger'].error;
			app['appLogger'].error = (msg: string, meta?: Record<string, unknown>) => {
				loggedErrors.push({ msg, meta });
				originalError.call(app['appLogger'], msg, meta);
			};

			await app.listen(port);

			// Connect
			const ws = new WebSocket(`ws://localhost:${port}/ws`);
			ws.onmessage = (event) => {
				receivedMessages.push(event.data.toString());
			};

			await new Promise<void>((resolve) => {
				ws.onopen = () => resolve();
			});

			// Wait for welcome message
			await waitFor(() => receivedMessages.length > 0, { timeout: 1000 });

			ws.close();

			// Should have received welcome message
			expect(receivedMessages.length).toBe(1);
			const parsed = JSON.parse(receivedMessages[0]!);
			expect(parsed.name).toBe('server.welcome');

			// Should NOT have logged any open handler errors
			const openHandlerErrors = loggedErrors.filter((e) =>
				(e as { msg: string }).msg.includes('open handler error')
			);
			expect(openHandlerErrors.length).toBe(0);
		});
	});
});
