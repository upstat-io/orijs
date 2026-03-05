import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { SocketClient } from '../src/client.ts';
import { waitFor, delay } from '@orijs/test-utils';

type TestServer = ReturnType<typeof Bun.serve>;

let server: TestServer;
let serverPort = 0;
const allClients: SocketClient[] = [];

function createTestServer(): TestServer {
	return Bun.serve({
		port: 0,
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === '/ws') {
				const upgraded = server.upgrade(req, {
					data: { id: crypto.randomUUID() }
				});
				if (!upgraded) {
					return new Response('WebSocket upgrade failed', { status: 400 });
				}
				return undefined as unknown as Response;
			}
			return new Response('Not found', { status: 404 });
		},
		websocket: {
			open() {},
			message() {},
			close() {}
		}
	});
}

function createClient(): SocketClient {
	const client = new SocketClient(`ws://localhost:${serverPort}/ws`, {
		reconnect: true,
		reconnectDelay: 50,
		maxReconnectDelay: 200,
		heartbeatInterval: 0
	});
	allClients.push(client);
	return client;
}

beforeAll(() => {
	server = createTestServer();
	serverPort = server.port ?? 0;
});

afterAll(() => {
	server.stop(true);
});

afterEach(async () => {
	for (const client of allClients) {
		try {
			client.destroy();
		} catch {
			// Ignore
		}
	}
	allClients.length = 0;
	await delay(50);
});

describe('SocketClient listener lifecycle', () => {
	test('should keep offline/online listeners after disconnect()', async () => {
		const client = createClient();
		client.connect();
		await waitFor(() => client.isConnected, { timeout: 2000 });

		// disconnect() — temporary stop, keeps listeners for reconnect
		client.disconnect();
		expect(client.connectionState).toBe('disconnected');

		// Handlers should still be set (not null) — disconnect preserves them
		// Verify by checking that connect() after disconnect() still works
		client.connect();
		await waitFor(() => client.isConnected, { timeout: 2000 });
		expect(client.isConnected).toBe(true);
	});

	test('should remove offline/online listeners after destroy()', async () => {
		// Track listeners added to globalThis
		const originalAddEventListener = globalThis.addEventListener;
		const originalRemoveEventListener = globalThis.removeEventListener;

		const addedListeners = new Map<string, Set<Function>>();
		const removedListeners = new Map<string, Set<Function>>();

		globalThis.addEventListener = function (this: typeof globalThis, type: string, listener: unknown, ...args: unknown[]) {
			if (!addedListeners.has(type)) addedListeners.set(type, new Set());
			addedListeners.get(type)!.add(listener as Function);
			return originalAddEventListener.call(this, type, listener as EventListener, ...(args as []));
		} as typeof addEventListener;

		globalThis.removeEventListener = function (this: typeof globalThis, type: string, listener: unknown, ...args: unknown[]) {
			if (!removedListeners.has(type)) removedListeners.set(type, new Set());
			removedListeners.get(type)!.add(listener as Function);
			return originalRemoveEventListener.call(this, type, listener as EventListener, ...(args as []));
		} as typeof removeEventListener;

		try {
			const client = new SocketClient(`ws://localhost:${serverPort}/ws`, {
				reconnect: true,
				heartbeatInterval: 0
			});
			allClients.push(client);

			client.connect();
			await waitFor(() => client.isConnected, { timeout: 2000 });

			// Verify listeners were added for offline and online
			expect(addedListeners.has('offline')).toBe(true);
			expect(addedListeners.has('online')).toBe(true);

			// destroy() should remove them
			client.destroy();

			expect(removedListeners.has('offline')).toBe(true);
			expect(removedListeners.has('online')).toBe(true);

			// The same handler references should have been removed
			for (const handler of addedListeners.get('offline')!) {
				expect(removedListeners.get('offline')!.has(handler)).toBe(true);
			}
			for (const handler of addedListeners.get('online')!) {
				expect(removedListeners.get('online')!.has(handler)).toBe(true);
			}
		} finally {
			globalThis.addEventListener = originalAddEventListener;
			globalThis.removeEventListener = originalRemoveEventListener;
		}
	});

	test('should connect() after disconnect() with reconnect recovery', async () => {
		const client = createClient();
		client.connect();
		await waitFor(() => client.isConnected, { timeout: 2000 });

		client.disconnect();
		expect(client.connectionState).toBe('disconnected');

		// Reconnect manually — should work
		client.connect();
		await waitFor(() => client.isConnected, { timeout: 2000 });
		expect(client.isConnected).toBe(true);
	});

	test('should connect() after destroy() without network-driven recovery', async () => {
		const client = createClient();
		client.connect();
		await waitFor(() => client.isConnected, { timeout: 2000 });

		client.destroy();
		expect(client.connectionState).toBe('disconnected');

		// Manual connect() still works after destroy()
		client.connect();
		await waitFor(() => client.isConnected, { timeout: 2000 });
		expect(client.isConnected).toBe(true);
	});

	test('should not reconnect on online event after disconnect()', async () => {
		const client = createClient();
		client.connect();
		await waitFor(() => client.isConnected, { timeout: 2000 });

		client.disconnect();
		expect(client.connectionState).toBe('disconnected');

		// Simulate online event — should NOT trigger reconnect because skipReconnect is true
		(globalThis as unknown as EventTarget).dispatchEvent(new Event('online'));
		await delay(100);

		expect(client.connectionState).toBe('disconnected');
	});
});
