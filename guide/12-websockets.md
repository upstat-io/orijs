# Chapter 12: WebSockets

OriJS provides first-class WebSocket support built on Bun's native WebSocket implementation. This gives you access to Bun's high-performance pub/sub system, with optional Redis-backed horizontal scaling.

## Why Native Bun WebSockets?

Most Node.js WebSocket solutions (Socket.io, ws, uWebSockets.js) are compatibility layers or polyfills. Bun's native WebSocket support is different:

1. **Zero-copy message handling.** Bun passes `Buffer` objects directly without copying, making it significantly faster than `ws` or Socket.io.
2. **Built-in pub/sub.** Bun's server has native `subscribe()`, `publish()`, and `unsubscribe()` methods that are faster than maintaining subscriber maps in JavaScript.
3. **Efficient broadcast.** Publishing to a topic is O(1) in Bun — it doesn't iterate over subscribers.
4. **Integrated with HTTP.** WebSocket upgrades happen in the same `Bun.serve()` instance, sharing the same port and TLS configuration.

OriJS builds on these primitives instead of abstracting them away.

## Basic Setup

Enable WebSocket support with `.websocket()`:

```typescript
Ori.create()
  .websocket()
  .listen(3000);
```

This creates a WebSocket endpoint at `ws://localhost:3000/ws` (configurable).

### Custom WebSocket Path

```typescript
Ori.create()
  .websocket({ path: '/realtime' })
  .listen(3000);
// WebSocket at ws://localhost:3000/realtime
```

### Connection Handlers

Handle WebSocket lifecycle events:

```typescript
Ori.create()
  .websocket({
    handlers: {
      open(ws) {
        console.log('Client connected:', ws.data.socketId);
        ws.subscribe('broadcasts');  // Subscribe to a topic
      },
      message(ws, message) {
        console.log('Received:', message);
        ws.send('Echo: ' + message);
      },
      close(ws, code, reason) {
        console.log('Client disconnected:', ws.data.socketId);
      },
    },
  })
  .listen(3000);
```

Each WebSocket connection gets a unique `socketId` (UUID) assigned automatically. The `ws.data` object carries connection-specific data that persists for the connection's lifetime.

## Upgrade Handlers (Authentication)

The upgrade handler runs when a client attempts to connect. Use it for authentication:

```typescript
Ori.create()
  .websocket({
    upgrade: async (request: Request) => {
      // Extract token from query parameter or header
      const url = new URL(request.url);
      const token = url.searchParams.get('token');

      if (!token) return null;  // null = reject connection

      const user = await authService.verifyToken(token);
      if (!user) return null;  // Invalid token = reject

      // Return data to attach to the connection
      return { user };
    },
    handlers: {
      open(ws) {
        const user = ws.data.data.user;
        console.log('Authenticated user connected:', user.email);

        // Subscribe to user-specific topic
        ws.subscribe(`user:${user.id}`);
      },
      message(ws, message) {
        const user = ws.data.data.user;
        // User is available in all handlers
      },
    },
  })
  .listen(3000);
```

The upgrade handler:
- Receives the raw HTTP `Request` (before upgrade)
- Returns `null` to reject (sends 401 Unauthorized)
- Returns any object to accept (attached to `ws.data.data`)
- Has a 5-second timeout to prevent hanging connections

## Pub/Sub

Bun's native pub/sub is OriJS's primary real-time messaging mechanism:

```typescript
handlers: {
  open(ws) {
    // Subscribe to topics
    ws.subscribe('global-notifications');
    ws.subscribe(`team:${ws.data.data.teamId}`);
    ws.subscribe(`user:${ws.data.data.user.id}`);
  },
  message(ws, message) {
    // Publish to a topic (all subscribers receive it except the sender)
    ws.publish('global-notifications', JSON.stringify({
      type: 'chat',
      from: ws.data.data.user.name,
      message: message.toString(),
    }));
  },
}
```

### Publishing from HTTP Routes

Often you need to send WebSocket messages from HTTP handlers (e.g., a REST API that updates data and pushes the change to connected clients):

```typescript
class MonitorController implements OriController {
  constructor(
    private monitorService: MonitorService,
    private ctx: AppContext,
  ) {}

  configure(r: RouteBuilder) {
    r.post('/monitors/:id/check').handle(this.triggerCheck);
  }

  private triggerCheck = async (ctx: RequestContext) => {
    const result = await this.monitorService.check(ctx.params.id);

    // Push update to all connected clients watching this monitor
    this.ctx.sockets.publish(
      `monitor:${ctx.params.id}`,
      JSON.stringify({
        type: 'monitor.status',
        data: { monitorId: ctx.params.id, status: result.status },
      }),
    );

    return result;
  };
}
```

The `ctx.sockets` (from `AppContext`) provides server-level publish capabilities, while `ws.publish()` (from connection handlers) publishes from a specific connection.

### Broadcast

Send a message to all connected clients:

```typescript
// From AppContext (e.g., in a service or controller)
this.ctx.sockets.publish('__broadcast__', JSON.stringify({
  type: 'system.maintenance',
  data: { message: 'Scheduled maintenance in 5 minutes' },
}));
```

All connections are automatically subscribed to the `__broadcast__` topic on connect.

## Custom Emitters

For type-safe WebSocket messaging, define custom emitters:

```typescript
import { SocketEmitter } from '@orijs/websocket';

class MonitorStatusEmitter {
  constructor(private ctx: AppContext) {}

  public emitStatusChange(monitorId: string, status: MonitorStatus) {
    this.ctx.sockets.publish(
      `monitor:${monitorId}`,
      JSON.stringify({
        type: 'monitor.statusChanged',
        data: {
          monitorId,
          isUp: status.isUp,
          responseTimeMs: status.responseTimeMs,
          checkedAt: status.checkedAt.toISOString(),
        },
      }),
    );
  }

  public emitAlert(monitorId: string, alert: Alert) {
    this.ctx.sockets.publish(
      `monitor:${monitorId}`,
      JSON.stringify({
        type: 'monitor.alert',
        data: {
          monitorId,
          alertId: alert.uuid,
          severity: alert.severity,
          message: alert.message,
        },
      }),
    );
  }
}
```

Register the emitter as a provider:

```typescript
Ori.create()
  .websocket()
  .provider(MonitorStatusEmitter, [AppContext])
  .provider(MonitorCheckService, [MonitorStatusEmitter, MonitorRepository])
  // ...
```

## Socket Routers

For applications with complex WebSocket message handling, **Socket Routers** provide a structured way to handle different message types. This is similar to how HTTP controllers handle different routes.

### The Two-Phase Model

Socket Routers use a two-phase model:

1. **Connection Phase**: When a client connects, **connection guards** run once to authenticate and authorize the connection. This is similar to the HTTP upgrade handler but with the guard pattern.

2. **Message Phase**: After the connection is established, incoming messages are routed to handlers based on the message `type` field. Each handler can have its own **message guards** for per-message authorization.

```typescript
import type { OriSocketRouter, SocketRouteBuilder, SocketContext } from '@orijs/websocket';

interface AuthState {
  user: { id: string; accountId: string; role: string };
}

class PresenceRouter implements OriSocketRouter<AuthState> {
  constructor(private presenceService: PresenceService) {}

  configure(r: SocketRouteBuilder<AuthState>) {
    // Phase 1: Connection guard (runs once on connect)
    r.connectionGuard(FirebaseSocketGuard);

    // Phase 2: Message handlers (run per message)
    r.on('presence.heartbeat', this.handleHeartbeat);
    r.on('presence.getOnline', this.handleGetOnline);
    r.on('presence.setStatus', this.handleSetStatus);
  }

  private handleHeartbeat = async (ctx: SocketContext<AuthState>) => {
    await this.presenceService.updateHeartbeat(ctx.state.user.id);
    return { ok: true };
  };

  private handleGetOnline = async (ctx: SocketContext<AuthState>) => {
    const online = await this.presenceService.getOnlineUsers(ctx.state.user.accountId);
    return { users: online };
  };

  private handleSetStatus = async (ctx: SocketContext<AuthState>) => {
    const { status } = ctx.data;  // Message payload
    await this.presenceService.setStatus(ctx.state.user.id, status);
    return { ok: true };
  };
}
```

Register the socket router:

```typescript
Ori.create()
  .websocket()
  .provider(PresenceService, [AppContext])
  .socketRouter(PresenceRouter, [PresenceService])
  .listen(3000);
```

### Message Format

Socket Routers expect messages in this format:

```json
{
  "type": "presence.heartbeat",
  "data": { "timestamp": "2024-01-15T10:30:00Z" },
  "correlationId": "optional-for-request-response"
}
```

- **`type`**: Routes to the correct handler
- **`data`**: The message payload (available as `ctx.data` in the handler)
- **`correlationId`**: Optional. If present, the response includes it for request-response patterns

Responses are sent back automatically:

```json
{
  "type": "presence.heartbeat",
  "data": { "ok": true },
  "correlationId": "abc-123"
}
```

### Connection Guards

Connection guards authenticate WebSocket connections:

```typescript
class FirebaseSocketGuard implements OriSocketGuard<AuthState> {
  constructor(private authService: AuthService) {}

  async canActivate(ws: WebSocketConnection, request: Request): Promise<boolean> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) return false;

    const user = await this.authService.verifyToken(token);
    if (!user) return false;

    // Set connection state (persists for all messages)
    ws.data.state = { user };
    return true;
  }
}
```

If the connection guard returns `false`, the WebSocket connection is closed with code `1008` (Policy Violation).

### Message Guards

For per-message authorization:

```typescript
configure(r: SocketRouteBuilder<AuthState>) {
  r.connectionGuard(FirebaseSocketGuard);

  r.on('presence.heartbeat', this.handleHeartbeat);

  // Only admins can kick users
  r.on('presence.kick', this.handleKick)
    .guard(AdminSocketGuard);
}
```

### Built-in Control Messages

Socket Routers handle some message types automatically:

| Type | Description |
|------|-------------|
| `ping` | Responds with `pong` (keepalive) |
| `subscribe` | Subscribes the connection to a topic |
| `unsubscribe` | Unsubscribes from a topic |

## Redis Provider (Horizontal Scaling)

By default, Bun's pub/sub works within a single process. For horizontal scaling (multiple server instances), use the Redis WebSocket provider:

```typescript
import { createRedisWebSocketProvider } from '@orijs/websocket-redis';

const wsProvider = createRedisWebSocketProvider({
  connection: { host: 'localhost', port: 6379 },
});

Ori.create()
  .websocket({ provider: wsProvider })
  .listen(3000);
```

With the Redis provider:
- `ws.subscribe('topic')` subscribes both locally (Bun's pub/sub) and to Redis
- `ws.publish('topic', data)` publishes to Redis, which broadcasts to all instances
- Each instance subscribes to Redis channels for topics its clients are watching
- Connection tracking and cleanup is handled automatically

This means clients connected to different server instances can communicate via shared topics, enabling true horizontal scaling.

### How It Works

```
Instance A                    Redis                    Instance B
┌─────────┐                 ┌───────┐                ┌─────────┐
│ Client 1 │──subscribe──→  │       │  ←──subscribe──│ Client 3 │
│ Client 2 │    "chat"      │ "chat"│      "chat"    │ Client 4 │
└─────────┘                 └───────┘                └─────────┘
     │                          ↑
     └───publish "chat"─────────┘
           "Hello!"              │
                                 └──→ "Hello!" delivered to Client 3 & 4
```

Without Redis, Client 1 publishing to "chat" would only reach Client 2 (same instance). With Redis, it reaches all subscribers across all instances.

## WebSocket Client

OriJS provides a TypeScript WebSocket client (`@orijs/websocket-client`) with automatic reconnection:

```typescript
import { WebSocketClient } from '@orijs/websocket-client';

const client = new WebSocketClient('ws://localhost:3000/ws', {
  reconnect: true,
  reconnectDelay: 1000,
  maxReconnectAttempts: 10,
});

client.on('open', () => {
  console.log('Connected');
  client.send(JSON.stringify({ type: 'presence.heartbeat' }));
});

client.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Received:', message);
});

client.on('close', (code, reason) => {
  console.log('Disconnected:', code, reason);
});

await client.connect();
```

The client handles:
- Automatic reconnection with configurable backoff
- Connection state management
- Message queuing during reconnection
- Clean disconnect

## Summary

OriJS WebSocket support provides:

1. **Native Bun WebSocket integration** for maximum performance
2. **Pub/sub messaging** with topic-based subscriptions
3. **Upgrade handlers** for connection-time authentication
4. **Socket Routers** with the two-phase model (connection guards + message routing)
5. **Redis provider** for horizontal scaling across multiple instances
6. **Built-in WebSocket client** with automatic reconnection
7. **Publishing from HTTP routes** via `AppContext.sockets`

The combination of Bun's native performance and OriJS's structured routing makes it possible to build real-time features without the overhead of Socket.io or similar libraries.

[Previous: Workflows ←](./11-workflows.md) | [Next: Caching →](./13-caching.md)
