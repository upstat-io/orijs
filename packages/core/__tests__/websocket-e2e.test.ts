/**
 * End-to-end tests for WebSocket integration.
 *
 * Tests the complete flow: HTTP Request → Controller → ctx.socket → WebSocket Client
 *
 * These tests verify realistic production scenarios:
 * - Multiple clients receiving topic-based messages
 * - HTTP API triggering WebSocket broadcasts
 * - Client disconnect handling during publish
 * - Service layer WebSocket integration
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { type Application, Ori } from '../src/index.ts';
import { Logger } from '@orijs/logging';
import type { OriController, RouteBuilder } from '../src/types/index.ts';
import type { WebSocketConnection } from '@orijs/websocket';
import { AppContext } from '../src/app-context.ts';

/**
 * Waits for a WebSocket connection to open with timeout protection.
 * Prevents tests from hanging indefinitely if connection fails.
 */
const waitForConnection = (ws: WebSocket, timeoutMs = 5000): Promise<void> => {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms`));
		}, timeoutMs);

		ws.onopen = () => {
			clearTimeout(timeout);
			resolve();
		};
		ws.onerror = (e) => {
			clearTimeout(timeout);
			reject(e);
		};
	});
};

describe('WebSocket E2E', () => {
	let app: Application;
	let port = 19000;
	/** Track all WebSockets for cleanup on test failure */
	const activeWebSockets: WebSocket[] = [];

	const getPort = () => ++port;
	const getBaseUrl = () => `http://localhost:${port}`;
	const getWsUrl = () => `ws://localhost:${port}/ws`;

	/** Creates a WebSocket and tracks it for automatic cleanup */
	const createTrackedWebSocket = (url: string): WebSocket => {
		const ws = new WebSocket(url);
		activeWebSockets.push(ws);
		return ws;
	};

	beforeEach(() => {
		Logger.reset();
		activeWebSockets.length = 0; // Clear tracking array
	});

	afterEach(async () => {
		// Close all tracked WebSockets to prevent leaks on test failure
		for (const ws of activeWebSockets) {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				ws.close();
			}
		}
		activeWebSockets.length = 0;
		await app?.stop();
	});

	describe('HTTP Request → ctx.socket → WebSocket Client', () => {
		it('should broadcast notification from API endpoint to all subscribed WebSocket clients', async () => {
			const client1Messages: string[] = [];
			const client2Messages: string[] = [];
			const client3Messages: string[] = [];

			class NotificationController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/broadcast', (ctx) => {
						// Broadcast to all clients subscribed to 'announcements'
						ctx.socket.publish('announcements', JSON.stringify({ type: 'alert', message: 'System update' }));
						return Response.json({ broadcasted: true });
					});
				}
			}

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// All clients subscribe to announcements
						ws.subscribe('announcements');
					},
					message: () => {},
					close: () => {}
				})
				.controller('/api', NotificationController);

			await app.listen(getPort());

			// Connect three WebSocket clients
			const ws1 = createTrackedWebSocket(getWsUrl());
			const ws2 = createTrackedWebSocket(getWsUrl());
			const ws3 = createTrackedWebSocket(getWsUrl());

			await Promise.all([waitForConnection(ws1), waitForConnection(ws2), waitForConnection(ws3)]);

			ws1.onmessage = (e) => client1Messages.push(e.data.toString());
			ws2.onmessage = (e) => client2Messages.push(e.data.toString());
			ws3.onmessage = (e) => client3Messages.push(e.data.toString());

			await Bun.sleep(50);

			// Make HTTP request to broadcast
			const response = await fetch(`${getBaseUrl()}/api/broadcast`, { method: 'POST' });
			expect(response.status).toBe(200);

			await Bun.sleep(100);

			// All clients should receive the message
			const expectedMessage = JSON.stringify({ type: 'alert', message: 'System update' });
			expect(client1Messages).toContain(expectedMessage);
			expect(client2Messages).toContain(expectedMessage);
			expect(client3Messages).toContain(expectedMessage);

			ws1.close();
			ws2.close();
			ws3.close();
		});

		it('should route messages to specific topics based on API payload', async () => {
			const premiumClientMessages: string[] = [];
			const freeClientMessages: string[] = [];

			class NotificationController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/notify/:tier', (ctx) => {
						const tier = ctx.params.tier;
						ctx.socket.publish(`tier:${tier}`, JSON.stringify({ tier, message: 'Tier-specific update' }));
						return Response.json({ notified: tier });
					});
				}
			}

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (_ws: WebSocketConnection<unknown>) => {
						// Clients will subscribe via message
					},
					message: (ws: WebSocketConnection<unknown>, message: string | Buffer) => {
						// Process subscribe requests from clients
						try {
							const data = JSON.parse(message.toString());
							if (data.action === 'subscribe' && data.topic) {
								ws.subscribe(data.topic);
							}
						} catch {
							// Ignore invalid JSON
						}
					},
					close: () => {}
				})
				.controller('/api', NotificationController);

			await app.listen(getPort());

			// Connect two WebSocket clients
			const premiumWs = createTrackedWebSocket(getWsUrl());
			const freeWs = createTrackedWebSocket(getWsUrl());

			await Promise.all([waitForConnection(premiumWs), waitForConnection(freeWs)]);

			premiumWs.onmessage = (e) => premiumClientMessages.push(e.data.toString());
			freeWs.onmessage = (e) => freeClientMessages.push(e.data.toString());

			// Subscribe clients to different tiers (via server messages)
			premiumWs.send(JSON.stringify({ action: 'subscribe', topic: 'tier:premium' }));
			freeWs.send(JSON.stringify({ action: 'subscribe', topic: 'tier:free' }));

			// Wait for subscriptions to be processed
			await Bun.sleep(50);

			// Notify premium tier only
			const premiumResponse = await fetch(`${getBaseUrl()}/api/notify/premium`, { method: 'POST' });
			expect(premiumResponse.status).toBe(200);

			await Bun.sleep(50);

			// Premium client should receive premium message
			expect(premiumClientMessages.length).toBe(1);
			expect(JSON.parse(premiumClientMessages[0]!).tier).toBe('premium');

			// Free tier should NOT receive premium message
			expect(freeClientMessages.length).toBe(0);

			// Notify free tier
			const freeResponse = await fetch(`${getBaseUrl()}/api/notify/free`, { method: 'POST' });
			expect(freeResponse.status).toBe(200);

			await Bun.sleep(50);

			// Free client should now receive free message
			expect(freeClientMessages.length).toBe(1);
			expect(JSON.parse(freeClientMessages[0]!).tier).toBe('free');

			// Premium should still only have 1 message (not the free one)
			expect(premiumClientMessages.length).toBe(1);

			premiumWs.close();
			freeWs.close();
		});
	});

	describe('Service Layer → appContext.socket → WebSocket Client', () => {
		it('should publish from service layer via AppContext', async () => {
			const clientMessages: string[] = [];

			class EventService {
				constructor(private readonly ctx: AppContext) {}

				emitUserEvent(userId: string, event: string): void {
					this.ctx.socket.publish(`user:${userId}`, JSON.stringify({ event, timestamp: Date.now() }));
				}
			}

			class UserController implements OriController {
				constructor(private eventService: EventService) {}
				configure(r: RouteBuilder) {
					r.post('/users/:userId/ping', (ctx) => {
						this.eventService.emitUserEvent(ctx.params.userId ?? '', 'ping');
						return Response.json({ pinged: true });
					});
				}
			}

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						// Subscribe to user-specific topic
						ws.subscribe('user:123');
					},
					message: () => {},
					close: () => {}
				})
				.provider(EventService, [AppContext])
				.controller('/api', UserController, [EventService]);

			await app.listen(getPort());

			const ws = createTrackedWebSocket(getWsUrl());
			await waitForConnection(ws);
			ws.onmessage = (e) => clientMessages.push(e.data.toString());

			await Bun.sleep(50);

			// Trigger API that uses service to publish
			const response = await fetch(`${getBaseUrl()}/api/users/123/ping`, { method: 'POST' });
			expect(response.status).toBe(200);

			await Bun.sleep(100);

			// Client should receive the event
			expect(clientMessages.length).toBe(1);
			const parsed = JSON.parse(clientMessages[0]!);
			expect(parsed.event).toBe('ping');
			expect(parsed.timestamp).toBeDefined();

			ws.close();
		});
	});

	describe('Connection state during publish', () => {
		it('should handle publish when clients disconnect during request', async () => {
			class NotificationController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/notify', async (ctx) => {
						// Simulate some async work
						await Bun.sleep(50);
						// Publish - some clients may have disconnected
						ctx.socket.publish('updates', 'late notification');
						return Response.json({ published: true });
					});
				}
			}

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						ws.subscribe('updates');
					},
					message: () => {},
					close: () => {}
				})
				.controller('/api', NotificationController);

			await app.listen(getPort());

			const ws = createTrackedWebSocket(getWsUrl());
			await waitForConnection(ws);

			await Bun.sleep(20);

			// Start the request (takes 50ms)
			const responsePromise = fetch(`${getBaseUrl()}/api/notify`, { method: 'POST' });

			// Close client while request is in progress
			ws.close();

			// Request should still complete successfully
			const response = await responsePromise;
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ published: true });
		});

		it('should not throw when publishing to topic with no subscribers', async () => {
			class NotificationController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/notify', (ctx) => {
						// Publish to topic that has no subscribers
						ctx.socket.publish('empty-topic', 'message to nobody');
						return Response.json({ published: true });
					});
				}
			}

			app = Ori.create().websocket().controller('/api', NotificationController);

			await app.listen(getPort());

			// No WebSocket clients connected
			const response = await fetch(`${getBaseUrl()}/api/notify`, { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ published: true });
		});
	});

	describe('Multiple sequential publishes', () => {
		it('should handle rapid sequential publishes from API', async () => {
			const clientMessages: string[] = [];

			class NotificationController implements OriController {
				configure(r: RouteBuilder) {
					r.post('/batch', (ctx) => {
						// Rapid sequential publishes
						for (let i = 1; i <= 5; i++) {
							ctx.socket.publish('batch', `message-${i}`);
						}
						return Response.json({ count: 5 });
					});
				}
			}

			app = Ori.create()
				.websocket()
				.onWebSocket({
					open: (ws: WebSocketConnection<unknown>) => {
						ws.subscribe('batch');
					},
					message: () => {},
					close: () => {}
				})
				.controller('/api', NotificationController);

			await app.listen(getPort());

			const ws = createTrackedWebSocket(getWsUrl());
			await waitForConnection(ws);
			ws.onmessage = (e) => clientMessages.push(e.data.toString());

			await Bun.sleep(50);

			const response = await fetch(`${getBaseUrl()}/api/batch`, { method: 'POST' });
			expect(response.status).toBe(200);

			await Bun.sleep(100);

			// All 5 messages should be received
			expect(clientMessages.length).toBe(5);
			expect(clientMessages).toContain('message-1');
			expect(clientMessages).toContain('message-2');
			expect(clientMessages).toContain('message-3');
			expect(clientMessages).toContain('message-4');
			expect(clientMessages).toContain('message-5');

			ws.close();
		});
	});
});
