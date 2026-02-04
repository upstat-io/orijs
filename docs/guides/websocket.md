# WebSocket Support

Real-time bidirectional communication using WebSockets with pub/sub messaging patterns.

---

## Overview

OriJS provides WebSocket support with:

- **Native Bun Integration**: Uses Bun's built-in WebSocket server for optimal performance
- **Pub/Sub Messaging**: Topic-based publish/subscribe pattern for scalable real-time communication
- **Provider Architecture**: Pluggable providers for single-instance (InProcWsProvider) or distributed (Redis) deployments
- **Custom Emitters**: Define domain-specific emitter methods with full type safety
- **Request Context Integration**: Access socket emitter via `ctx.socket` with correlation ID binding

---

## Quick Start

### Basic WebSocket Server

```typescript
import { Ori } from '@orijs/core';

Ori.create()
	.websocket()
	.onWebSocket({
		open: (ws) => {
			console.log('Client connected:', ws.data.socketId);
			ws.subscribe('global'); // Subscribe to a topic
		},
		message: (ws, msg) => {
			console.log('Received:', msg);
			// Echo back to sender
			ws.send(msg);
		},
		close: (ws) => {
			console.log('Client disconnected:', ws.data.socketId);
		}
	})
	.listen(3000, () => {
		console.log('WebSocket server running at ws://localhost:3000/ws');
	});
```

### Publishing from HTTP Handlers

```typescript
import { Ori, RequestContext, RouteBuilder, OriController } from '@orijs/core';

class NotificationController implements OriController {
	configure(r: RouteBuilder) {
		r.post('/notify/:topic', this.notify);
	}

	private notify = async (ctx: RequestContext) => {
		const topic = ctx.params.topic;
		const body = await ctx.json<{ message: string }>();

		// Publish to all subscribers of the topic
		await ctx.socket.publish(
			topic,
			JSON.stringify({
				type: 'notification',
				message: body.message,
				timestamp: Date.now()
			})
		);

		return Response.json({ sent: true });
	};
}

Ori.create()
	.websocket()
	.onWebSocket({
		open: (ws) => ws.subscribe('notifications')
	})
	.controller('/api', NotificationController, [])
	.listen(3000);
```

---

## Configuration

### websocket() Method

Configures WebSocket support on the application.

```typescript
app.websocket<TEmitter, TData>(provider?, options?)
```

| Parameter         | Type                              | Description                                                 |
| ----------------- | --------------------------------- | ----------------------------------------------------------- |
| `provider`        | `WebSocketProvider`               | Optional. Provider instance. Defaults to `InProcWsProvider` |
| `options.path`    | `string`                          | WebSocket endpoint path. Default: `/ws`                     |
| `options.emitter` | `SocketEmitterConstructor`        | Custom emitter class for domain-specific methods            |
| `options.upgrade` | `(req: Request) => TData \| null` | Authentication/upgrade handler                              |

**Type Parameters:**

- `TEmitter extends SocketEmitter` - Custom emitter type for type-safe access
- `TData` - Type of user data returned by upgrade handler

### onWebSocket() Method

Registers WebSocket lifecycle event handlers.

```typescript
app.onWebSocket<TData>(handlers);
```

| Handler   | Signature                    | Description                   |
| --------- | ---------------------------- | ----------------------------- |
| `open`    | `(ws) => void`               | Called when connection opens  |
| `message` | `(ws, msg) => void`          | Called when message received  |
| `close`   | `(ws, code, reason) => void` | Called when connection closes |
| `ping`    | `(ws, data) => void`         | Called on ping                |
| `pong`    | `(ws, data) => void`         | Called on pong                |
| `drain`   | `(ws) => void`               | Called when buffer drains     |

---

## Authentication

### Upgrade Handler

Validate connections before accepting them:

```typescript
interface UserData {
	userId: string;
	role: 'admin' | 'user';
}

Ori.create()
	.websocket<SocketEmitter, UserData>(undefined, {
		path: '/ws',
		upgrade: async (req) => {
			const token = req.headers.get('Authorization')?.replace('Bearer ', '');
			if (!token) return null; // Reject connection

			try {
				const payload = await verifyJwt(token);
				return { userId: payload.sub, role: payload.role };
			} catch {
				return null; // Reject invalid tokens
			}
		}
	})
	.onWebSocket<UserData>({
		open: (ws) => {
			// Access authenticated user data
			console.log('User connected:', ws.data.data.userId);

			// Subscribe to user-specific topic
			ws.subscribe(`user:${ws.data.data.userId}`);

			// Admins get extra subscriptions
			if (ws.data.data.role === 'admin') {
				ws.subscribe('admin-alerts');
			}
		}
	})
	.listen(3000);
```

### Connection Rejection

Return `null` from the upgrade handler to reject connections:

```typescript
upgrade: async (req) => {
	const origin = req.headers.get('Origin');
	if (!isAllowedOrigin(origin)) {
		return null; // Rejects with 401
	}
	return { authenticated: true };
};
```

---

## Pub/Sub Messaging

### Topics

Topics are string identifiers for message routing. Sockets subscribe to topics and receive messages published to them.

```typescript
// In WebSocket handlers
.onWebSocket({
  open: (ws) => {
    ws.subscribe('global');           // Subscribe to topic
    ws.subscribe(`user:${userId}`);   // User-specific topic
  },
  message: (ws, msg) => {
    ws.unsubscribe('global');         // Unsubscribe from topic
  }
})
```

### Publishing Messages

From any context with socket access:

```typescript
// From HTTP handler (ctx.socket)
await ctx.socket.publish('room:123', JSON.stringify({ event: 'update' }));

// From service (AppContext.socket)
this.ctx.socket.publish('alerts', JSON.stringify({ level: 'critical' }));

// Direct send to specific socket
ctx.socket.send(socketId, JSON.stringify({ type: 'direct' }));

// Broadcast to all connected sockets
ctx.socket.broadcast(JSON.stringify({ type: 'system', message: 'Maintenance in 5 min' }));
```

### Message Format

Messages are `string` or `ArrayBuffer`. For structured data, use JSON:

```typescript
// Sending
await ctx.socket.publish(
	'events',
	JSON.stringify({
		type: 'user.created',
		payload: { userId: '123', name: 'Alice' },
		timestamp: Date.now()
	})
);

// Receiving (in client)
ws.onmessage = (event) => {
	const data = JSON.parse(event.data);
	if (data.type === 'user.created') {
		handleUserCreated(data.payload);
	}
};
```

---

## Custom Emitters

Create domain-specific emitter methods with full type safety.

### Defining a Custom Emitter

```typescript
import { SocketEmitter, WebSocketProvider } from '@orijs/websocket';

export class AppSocketEmitter implements SocketEmitter {
	constructor(private provider: WebSocketProvider) {}

	// Implement base SocketEmitter methods
	publish(topic: string, message: string | ArrayBuffer): Promise<void> {
		return this.provider.publish(topic, message);
	}

	send(socketId: string, message: string | ArrayBuffer): boolean {
		return this.provider.send(socketId, message);
	}

	broadcast(message: string | ArrayBuffer): void {
		this.provider.broadcast(message);
	}

	// Custom domain methods
	emitToAccount(accountUuid: string, event: string, payload: unknown): void {
		this.provider.publish(
			`account:${accountUuid}`,
			JSON.stringify({ event, payload, timestamp: Date.now() })
		);
	}

	emitToUser(userUuid: string, event: string, payload: unknown): void {
		this.provider.publish(`user:${userUuid}`, JSON.stringify({ event, payload, timestamp: Date.now() }));
	}

	emitIncidentUpdate(incidentUuid: string, update: IncidentUpdate): void {
		this.provider.publish(
			`incident:${incidentUuid}`,
			JSON.stringify({ event: 'incident.updated', payload: update })
		);
	}
}
```

### Using Custom Emitter

```typescript
// Configure with custom emitter
Ori.create()
	.websocket<AppSocketEmitter>(undefined, {
		emitter: AppSocketEmitter
	})
	.onWebSocket({
		open: (ws) => {
			ws.subscribe(`account:${ws.data.data.accountUuid}`);
		}
	})
	.listen(3000);
```

### Type-Safe Access

**In AppContext (services):**

```typescript
import { AppContext } from '@orijs/core';
import { AppSocketEmitter } from './socket-emitter';

class IncidentService {
	constructor(private readonly ctx: AppContext<AppSocketEmitter>) {}

	async createIncident(data: CreateIncidentInput): Promise<Incident> {
		const incident = await this.repo.create(data);

		// Type-safe! TypeScript knows about emitToAccount
		this.ctx.socket.emitToAccount(data.accountUuid, 'incident.created', {
			incidentUuid: incident.uuid,
			title: incident.title
		});

		return incident;
	}
}
```

**In RequestContext (controllers):**

```typescript
import { RequestContext, AppContext } from '@orijs/core';
import { AppSocketEmitter } from './socket-emitter';

class IncidentController implements OriController {
  private createIncident = async (ctx: RequestContext) => {
    // Access via app context for custom methods
    const socket = (ctx.app as AppContext<AppSocketEmitter>).socket;
    socket.emitToAccount(accountUuid, 'incident.created', {...});

    // Or use ctx.socket for base methods with correlation binding
    await ctx.socket.publish(`incident:${uuid}`, JSON.stringify(data));

    return Response.json({ created: true });
  };
}
```

---

## Providers

### InProcWsProvider (Default)

For single-instance deployments. Uses Bun's native pub/sub.

```typescript
import { InProcWsProvider } from '@orijs/websocket';

Ori.create().websocket(new InProcWsProvider()).listen(3000);
```

**Characteristics:**

- Zero latency (in-process)
- No external dependencies
- Does not support horizontal scaling

### Redis Provider (Distributed)

For multi-instance deployments. Requires `@orijs/websocket-redis`.

```typescript
import { RedisWsProvider } from '@orijs/websocket-redis';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

Ori.create().websocket(new RedisWsProvider(redis)).listen(3000);
```

**Characteristics:**

- Supports horizontal scaling
- Messages routed via Redis pub/sub
- Slight latency for cross-instance messages

---

## WebSocket Connection Object

The `ws` object passed to handlers:

```typescript
interface WebSocketConnection<TData> {
	data: {
		socketId: string; // Unique connection ID (UUID v4)
		data: TData; // User data from upgrade handler
		topics: Set<string>; // Currently subscribed topics
	};

	// Methods
	subscribe(topic: string): void;
	unsubscribe(topic: string): void;
	send(message: string | ArrayBuffer): void;
	close(code?: number, reason?: string): void;

	// Properties
	readyState: number;
	remoteAddress: string;
}
```

---

## SocketEmitter Interface

The base interface for socket emitters (ctx.socket, AppContext.socket):

```typescript
interface SocketEmitter {
	/** Publish to all subscribers of a topic */
	publish(topic: string, message: string | ArrayBuffer): Promise<void>;

	/** Send directly to a specific socket */
	send(socketId: string, message: string | ArrayBuffer): boolean;

	/** Broadcast to all connected sockets */
	broadcast(message: string | ArrayBuffer): void;
}
```

---

## Request Context Integration

### ctx.socket

Access the socket emitter from request handlers:

```typescript
private notify = async (ctx: RequestContext) => {
  // Publish to topic
  await ctx.socket.publish('updates', JSON.stringify({ type: 'refresh' }));

  // Send to specific socket
  const sent = ctx.socket.send(socketId, JSON.stringify({ direct: true }));

  // Broadcast to all
  ctx.socket.broadcast(JSON.stringify({ system: 'announcement' }));

  return Response.json({ ok: true });
};
```

### Correlation ID

Request-bound socket emitters carry the request's correlation ID for tracing:

```typescript
import { RequestBoundSocketEmitter } from '@orijs/core';

private notify = async (ctx: RequestContext) => {
  // Access correlation ID if needed for message payload
  const correlationId = (ctx.socket as RequestBoundSocketEmitter).correlationId;

  await ctx.socket.publish('events', JSON.stringify({
    type: 'update',
    correlationId,
    data: {...}
  }));

  return Response.json({ ok: true });
};
```

---

## Opinionated Message Handling

OriJS provides opinionated message handling with schema validation. Only registered message types are accepted - all others are rejected.

### MessageRegistry

Register handlers with schema validation:

```typescript
import { MessageRegistry, JoinRoom, LeaveRoom, Heartbeat, ServerMessage } from '@orijs/websocket';
import { Type } from '@orijs/validation';

// Use built-in control messages
const registry = new MessageRegistry()
	.on(JoinRoom, (ws, data) => {
		ws.subscribe(data.room); // data.room is typed as string
	})
	.on(LeaveRoom, (ws, data) => {
		ws.unsubscribe(data.room);
	})
	.on(Heartbeat, (ws) => {
		ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
	});

// Define custom messages with schemas
const UpdateStatus = ServerMessage.define({
	name: 'status.update',
	data: Type.Object({
		status: Type.Union([Type.Literal('online'), Type.Literal('offline')]),
		lastSeen: Type.Optional(Type.Number())
	})
});

registry.on(UpdateStatus, (ws, data) => {
	// data is typed and validated
	broadcastStatus(ws.data.data.userId, data.status);
});
```

### Using MessageRegistry in onWebSocket

```typescript
Ori.create()
	.websocket()
	.onWebSocket({
		message: async (ws, msg) => {
			if (typeof msg !== 'string') return;

			// Handle minimal ping/pong (single character frames)
			if (msg === '2') {
				ws.send('3');
				return;
			}

			try {
				const parsed = JSON.parse(msg);
				const { type, ...data } = parsed;

				// Validate and handle via registry
				const result = await registry.handle(ws, type, data);

				if (!result.handled) {
					// Unknown or invalid message
					const error =
						result.reason === 'unknown_type'
							? `Unknown message type: ${type}`
							: `Validation failed: ${result.details}`;
					ws.send(JSON.stringify({ type: 'error', message: error }));
				}
			} catch {
				ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
			}
		}
	})
	.listen(3000);
```

### Built-in Control Messages

| Message     | Type Name    | Data Schema        | Purpose                   |
| ----------- | ------------ | ------------------ | ------------------------- |
| `JoinRoom`  | `room.join`  | `{ room: string }` | Subscribe to a topic      |
| `LeaveRoom` | `room.leave` | `{ room: string }` | Unsubscribe from a topic  |
| `Heartbeat` | `heartbeat`  | `{}`               | Keep-alive (JSON version) |

### Browser Client

The `@orijs/websocket-client` package provides typed message sending:

```typescript
import { SocketClient, JoinRoom, LeaveRoom, Connected } from '@orijs/websocket-client';

const client = new SocketClient('wss://api.example.com/ws');

// Type-safe message emission
client.emit(JoinRoom, { room: 'account:123' });

// Or use convenience methods
client.joinRoom('account:123');
client.leaveRoom('account:123');

// Listen for server messages
client.on(Connected, () => {
	console.log('Connected!');
	client.joinRoom(`user:${userId}`);
});

client.connect();
```

---

## Socket Routers

Socket Routers provide organized message handling with guards, dependency injection, and type-safe contexts - mirroring the HTTP controller pattern.

### The Two-Phase Model

Socket Routers use a two-phase model:

1. **Connection Phase**: Authentication guard runs ONCE on WebSocket upgrade
2. **Routing Phase**: Messages are routed to handlers with pre-authenticated state

This design optimizes for real-time messaging - authenticate once, then handle messages with zero auth overhead.

### Defining a Socket Router

```typescript
import type { OriSocketRouter, SocketRouteBuilder, SocketContext } from '@orijs/core';
import { Type } from '@orijs/validation';

// Define message data schema
const HeartbeatDataSchema = Type.Optional(
	Type.Object({
		teamFbUids: Type.Optional(Type.Array(Type.String()))
	})
);

// Define auth state shape (set by connection guard)
interface AuthState {
	user: {
		fbAuthUid: string;
		accountUuid: string;
	};
}

export class PresenceRouter implements OriSocketRouter<AuthState> {
	constructor(private presenceService: PresenceService) {}

	configure(r: SocketRouteBuilder<AuthState>) {
		// Connection guard - runs ONCE on WebSocket upgrade
		r.connectionGuard(WebSocketAuthGuard);

		// Message handlers with optional schema validation
		r.on('heartbeat', this.handleHeartbeat, HeartbeatDataSchema);
		r.on('status.update', this.handleStatusUpdate);
	}

	private handleHeartbeat = async (ctx: SocketContext<AuthState>) => {
		const user = ctx.state.user; // Set by connection guard
		const data = ctx.json<{ teamFbUids?: string[] }>();

		await this.presenceService.updatePresence(user.fbAuthUid);

		if (data?.teamFbUids?.length) {
			const team = await this.presenceService.getBatchPresence(data.teamFbUids);
			return { success: true, team };
		}

		return { success: true };
	};

	private handleStatusUpdate = async (ctx: SocketContext<AuthState>) => {
		// Handler implementation
		return { updated: true };
	};
}
```

### Registering Socket Routers

```typescript
import { Ori } from '@orijs/core';
import { PresenceRouter } from './routers/presence.router';
import { PresenceService } from './services/presence.service';

Ori.create()
	.service(PresenceService)
	.websocket()
	.socketRouter(PresenceRouter, [PresenceService])
	.listen(3000);
```

### Guards

#### Connection Guards

Run ONCE when the WebSocket connection is established. Used for authentication.

```typescript
import type { SocketGuard, SocketContext } from '@orijs/core';

export class WebSocketAuthGuard implements SocketGuard {
	constructor(private authService: AuthService) {}

	async canActivate(ctx: SocketContext): Promise<boolean> {
		const token = ctx.userData?.token;
		if (!token) return false;

		try {
			const user = await this.authService.verifyToken(token);
			ctx.set('user', user); // Persists for entire connection
			return true;
		} catch {
			return false;
		}
	}
}
```

#### Message Guards

Run per-message. Used for rate limiting, validation, etc.

```typescript
r.guard(RateLimitGuard); // Runs before every message handler
r.on('heartbeat', this.handleHeartbeat);
```

### SocketContext

The context passed to message handlers provides:

```typescript
interface SocketContext<TState, TData> {
	// State from guards (type-safe)
	state: TState;
	set<K extends keyof TState>(key: K, value: TState[K]): void;
	get<K extends keyof TState>(key: K): TState[K];

	// Message data
	data: unknown; // Raw message data
	json<T>(): T; // Parse/cast data

	// WebSocket connection
	ws: WebSocketConnection<TData>;
	socketId: string;
	userData: TData; // From upgrade handler

	// Communication
	send(data: unknown): void; // Send to this client
	subscribe(topic: string): void;
	unsubscribe(topic: string): void;
	publish(topic: string, data: unknown): void;

	// Services
	app: AppContext;
	log: Logger;
	events: EventEmitter;
	workflows: WorkflowExecutor;
	socket: SocketEmitter;

	// Request tracking
	correlationId: string;
	messageType: string;
}
```

### Message Format

Socket Routers expect messages in this format:

```typescript
// Client sends:
{
  "type": "heartbeat",
  "data": { "teamFbUids": ["uid1", "uid2"] },
  "correlationId": "optional-for-tracing"
}

// Server responds:
{
  "type": "heartbeat",
  "data": { "success": true, "team": [...] }
}
```

Handler return values are automatically wrapped and sent back.

### Combining with Raw Handlers

Socket routers are checked first. Unhandled messages fall through to `onWebSocket()`:

```typescript
Ori.create()
	.websocket()
	.socketRouter(PresenceRouter, [PresenceService])
	.onWebSocket({
		message: async (ws, msg) => {
			// Only receives messages NOT handled by socket routers
			// Handle legacy messages, ping/pong, etc.
		}
	})
	.listen(3000);
```

### When to Use Socket Routers

| Use Case                       | Approach                                 |
| ------------------------------ | ---------------------------------------- |
| Authenticated message handling | Socket Router with connection guard      |
| Domain-organized handlers      | Socket Router with multiple handlers     |
| Simple pub/sub                 | Raw `onWebSocket()` handlers             |
| Mixed legacy + new             | Socket Router + fallback `onWebSocket()` |

---

## Best Practices

### 1. Topic Naming Conventions

Use hierarchical, descriptive topic names:

```typescript
// Good
'account:uuid-here';
'user:uuid-here';
'incident:uuid-here:updates';
'room:chat-room-id';

// Avoid
'updates'; // Too generic
'12345'; // Not descriptive
```

### 2. Message Structure

Standardize message format:

```typescript
interface WebSocketMessage<T = unknown> {
	type: string; // Event type (e.g., 'incident.created')
	payload: T; // Event data
	timestamp: number; // Unix timestamp
	correlationId?: string; // For tracing
}
```

### 3. Error Handling

Handle errors gracefully:

```typescript
.onWebSocket({
  message: async (ws, msg) => {
    try {
      const data = JSON.parse(msg as string);
      await handleMessage(ws, data);
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  }
})
```

### 4. Connection Cleanup

Always clean up on disconnect:

```typescript
.onWebSocket({
  close: (ws) => {
    // Clean up any resources
    removeFromActiveUsers(ws.data.socketId);

    // Notify others if needed
    ctx.socket.publish('presence', JSON.stringify({
      type: 'user.offline',
      userId: ws.data.data.userId
    }));
  }
})
```

### 5. Heartbeat/Ping

Implement heartbeat for connection health:

```typescript
// Server-side (Bun handles ping/pong automatically)
.onWebSocket({
  pong: (ws) => {
    // Connection is alive
    updateLastSeen(ws.data.socketId);
  }
})

// Client-side
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);
```

---

## Testing

### Unit Testing Socket Emitter

```typescript
import { describe, test, expect, mock } from 'bun:test';

describe('NotificationService', () => {
	test('should emit to account on incident creation', async () => {
		const mockSocket = {
			emitToAccount: mock(() => {}),
			publish: mock(() => Promise.resolve()),
			send: mock(() => true),
			broadcast: mock(() => {})
		};

		const mockCtx = {
			socket: mockSocket
		} as unknown as AppContext<AppSocketEmitter>;

		const service = new NotificationService(mockCtx);
		await service.notifyIncidentCreated(incident);

		expect(mockSocket.emitToAccount).toHaveBeenCalledWith(
			incident.accountUuid,
			'incident.created',
			expect.objectContaining({ incidentUuid: incident.uuid })
		);
	});
});
```

### E2E Testing with Real WebSocket

```typescript
import { describe, test, expect, afterAll } from 'bun:test';

describe('WebSocket E2E', () => {
	let app: Application;

	afterAll(async () => {
		await app.stop();
	});

	test('should receive published messages', async () => {
		app = await Ori.create()
			.websocket()
			.onWebSocket({
				open: (ws) => ws.subscribe('test')
			})
			.controller('/api', TestController, [])
			.listen(0); // Random port

		const port = app.server!.port;
		const ws = new WebSocket(`ws://localhost:${port}/ws`);

		const messages: string[] = [];
		ws.onmessage = (e) => messages.push(e.data);

		// Wait for connection
		await new Promise((r) => (ws.onopen = r));

		// Trigger publish via HTTP
		await fetch(`http://localhost:${port}/api/publish`, {
			method: 'POST',
			body: JSON.stringify({ message: 'hello' })
		});

		// Wait for message
		await new Promise((r) => setTimeout(r, 100));

		expect(messages).toContain(expect.stringContaining('hello'));

		ws.close();
	});
});
```

---

## Troubleshooting

### WebSocket not configured error

```
Error: WebSocket not configured. Call .websocket() when creating the application.
```

**Solution:** Call `.websocket()` before `.listen()`:

```typescript
Ori.create()
	.websocket() // Add this
	.listen(3000);
```

### Connection rejected (401)

The upgrade handler returned `null`. Check your authentication logic:

```typescript
upgrade: async (req) => {
	const token = req.headers.get('Authorization');
	console.log('Upgrade attempt with token:', token); // Debug
	// ...
};
```

### Messages not received

1. Check topic subscription:

```typescript
open: (ws) => {
	ws.subscribe('your-topic');
	console.log('Subscribed to:', ws.data.topics); // Verify
};
```

2. Verify publish topic matches:

```typescript
await ctx.socket.publish('your-topic', message); // Must match
```

### Provider not ready error

```
Error: Cannot publish to topic "...": Provider not ready
```

WebSocket provider hasn't been initialized. This can happen if:

- Publishing before `listen()` completes
- Server hasn't started yet

**Solution:** Wait for server to be ready before publishing.

---

## Related Documentation

- [Core Concepts](./core-concepts.md) - AppContext and lifecycle hooks
- [HTTP & Routing](./http-routing.md) - Controllers and handlers
- [Events](./events.md) - For persistent async messaging (BullMQ)
- [Testing](./testing.md) - Testing patterns
