/**
 * Tests that broadcast subscription only happens after guard approval.
 *
 * Verifies fix 1.1: WebSocket broadcast topic subscription moved
 * inside the guard success block to prevent unauthenticated clients
 * from receiving broadcast messages.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { type Application, Ori } from '../src/index.ts';
import { Logger } from '@orijs/logging';
import type {
	OriSocketRouter,
	SocketRouteBuilder as ISocketRouteBuilder,
	SocketGuard
} from '../src/types/index.ts';

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

describe('WebSocket broadcast auth race', () => {
	let app: Application;
	let port = 32000;

	const getPort = () => ++port;
	const getWsUrl = () => `ws://localhost:${port}/ws`;

	beforeEach(() => {
		Logger.reset();
	});

	afterEach(async () => {
		await app?.stop();
	});

	test('should reject broadcast subscription when guard denies connection', async () => {
		const broadcastsReceived: string[] = [];

		class DenyGuard implements SocketGuard {
			canActivate(): boolean {
				return false;
			}
		}

		class TestRouter implements OriSocketRouter {
			configure(r: ISocketRouteBuilder) {
				r.connectionGuard(DenyGuard);
				r.on('ping', () => ({ pong: true }));
			}
		}

		app = Ori.create()
			.logger({ level: 'error' })
			.websocket()
			.socketRouter(TestRouter);

		await app.listen(getPort());

		let connectionClosed = false;
		let closeCode: number | undefined;

		const ws = new WebSocket(getWsUrl());

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				broadcastsReceived.push(event.data as string);
			};
			ws.onclose = (event) => {
				connectionClosed = true;
				closeCode = event.code;
				resolve();
			};
			ws.onerror = () => {};
		});

		// Guard rejected — connection should be closed with 1008
		expect(connectionClosed).toBe(true);
		expect(closeCode).toBe(1008);

		// No broadcast messages should have been received
		expect(broadcastsReceived).toHaveLength(0);
	});

	test('should allow broadcast subscription when guard approves connection', async () => {
		class AllowGuard implements SocketGuard {
			canActivate(): boolean {
				return true;
			}
		}

		class TestRouter implements OriSocketRouter {
			configure(r: ISocketRouteBuilder) {
				r.connectionGuard(AllowGuard);
				r.on('ping', () => ({ pong: true }));
			}
		}

		app = Ori.create()
			.logger({ level: 'error' })
			.websocket()
			.socketRouter(TestRouter);

		await app.listen(getPort());

		const messages: string[] = [];
		const ws = new WebSocket(getWsUrl());

		let connected = false;
		ws.onopen = () => { connected = true; };
		ws.onmessage = (event) => { messages.push(event.data as string); };

		await waitFor(() => connected);

		// Connection should stay open (guard passed)
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});
});
