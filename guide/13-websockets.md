# Chapter 13: WebSockets

[Previous: Workflows <-](./12-workflows.md) | [Next: Caching ->](./14-caching.md)

---

Real-time communication is not optional for modern applications. Dashboards need live updates. Chat systems need instant delivery. Monitoring tools need to push alerts the moment something breaks. HTTP polling is a hack -- you are burning server resources and client bandwidth to simulate something that WebSockets give you natively.

OriJS builds WebSocket support on top of Bun's native WebSocket implementation, which is fundamentally different from how Node.js frameworks approach real-time communication. Bun's WebSockets are not bolted on top of an HTTP library -- they are first-class citizens of the runtime with zero-copy message handling, built-in pub/sub, and efficient broadcast. This chapter covers everything from basic connection handling to horizontally-scaled architectures using the Redis WebSocket provider.

## Why Bun's Native WebSockets

Before diving into the API, it is worth understanding why OriJS chose to build on Bun's native WebSocket support rather than using a library like `ws` or Socket.IO.

**Zero-copy message handling.** Bun's WebSocket implementation avoids copying message buffers between C++ and JavaScript. When a client sends a message, the underlying C buffer is exposed directly to your handler. This matters at scale -- copying 1 KB messages across 10,000 connections means 10 MB of unnecessary memory allocation per broadcast.

**Built-in pub/sub.** Bun has topic-based pub/sub built into the server. When you call `server.publish('room:123', message)`, Bun iterates over subscribed sockets at the C level and sends the message without any JavaScript loop. This is dramatically faster than iterating over a `Set` of connections in JavaScript.

**Integrated with HTTP.** Bun handles the WebSocket upgrade handshake natively in the same server that handles HTTP requests. There is no separate WebSocket server to manage, no port conflicts, and no CORS complications for the upgrade request.

**Efficient broadcast.** Broadcasting to all connected sockets uses `server.publish()` with a special broadcast topic. The message is serialized once and sent to all subscribers at the C level, regardless of how many connections exist.

## The WebSocket Provider Architecture

Like everything in OriJS, WebSocket support is built on a **provider interface**. The framework ships with two providers:

| Provider | Package | Use Case |
|----------|---------|----------|
| `InProcWsProvider` | `@orijs/websocket` | Single-instance deployments |
| `RedisWsProvider` | `@orijs/websocket-redis` | Multi-instance horizontal scaling |

Both implement the same `WebSocketProvider` interface, which means your application code does not change when you move from a single server to a fleet of servers behind a load balancer.

```
┌─────────────────────────────────────────────────────────┐
│                  Your Application Code                  │
│                                                         │
│  socket.publish('room:123', message)                    │
│  socket.emit(IncidentCreated, 'account:abc', data)      │
│  socket.broadcast(systemMessage)                         │
└──────────────────────┬──────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │ WebSocketProvider│  (interface)
              └────────┬────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
   ┌──────▼──────┐          ┌──────▼──────┐
   │ InProcWs    │          │ RedisWs     │
   │ Provider    │          │ Provider    │
   │             │          │             │
   │ Bun native  │          │ Redis pub/  │
   │ server.pub  │          │ sub bridge  │
   └─────────────┘          └─────────────┘
```

## The Provider Interface

The `WebSocketProvider` interface is composed of three segregated interfaces following the Interface Segregation Principle (ISP):

### SocketEmitter -- What Services Use

This is the minimal interface your application services interact with. When you access `ctx.socket` from a controller or inject the socket emitter into a service, this is the interface you get:

```typescript
interface SocketEmitter {
  /** Publish a message to all subscribers of a topic */
  publish(topic: string, message: string | ArrayBuffer): Promise<void>;

  /** Send a message directly to a specific socket by ID */
  send(socketId: string, message: string | ArrayBuffer): void;

  /** Broadcast a message to every connected socket */
  broadcast(message: string | ArrayBuffer): void;

  /** Emit a typed, schema-validated message to a topic */
  emit<TData>(message: SocketMessageLike<TData>, topic: string, data: TData): Promise<void>;
}
```

The separation matters. Your service code should depend on `SocketEmitter`, not `WebSocketProvider`. This means your services are testable without mocking the entire provider -- you only need to mock three or four methods.

### SocketLifecycle -- What the Framework Uses

These methods are called by the OriJS application during startup and shutdown:

```typescript
interface SocketLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Your application code never calls these directly. The framework manages the lifecycle.

### WebSocketProvider -- What Implementations Provide

The full interface extends both `SocketEmitter` and `SocketLifecycle`, adding connection management methods:

```typescript
interface WebSocketProvider extends SocketEmitter, SocketLifecycle {
  subscribe(socketId: string, topic: string): void;
  unsubscribe(socketId: string, topic: string): void;
  disconnect(socketId: string): void;
  isConnected(socketId: string): boolean;
  getConnectionCount(): number;
  getTopicSubscriberCount(topic: string): number;
  setServer(server: BunServer): void;
}
```

## Basic WebSocket Setup

Here is a minimal OriJS application with WebSocket support:

```typescript
import { Application } from '@orijs/core';
import { createInProcWsProvider } from '@orijs/websocket';

const app = new Application();

// Create and register the WebSocket provider
const wsProvider = createInProcWsProvider();

app.websocket(wsProvider).onWebSocket({
  open(ws) {
    console.log(`Client connected: ${ws.data.socketId}`);
    ws.subscribe('global'); // Subscribe to the global topic
  },

  message(ws, message) {
    const text = typeof message === 'string' ? message : message.toString();
    console.log(`Received: ${text}`);
  },

  close(ws, code, reason) {
    console.log(`Client disconnected: ${ws.data.socketId}`);
  }
});

await app.listen(8001);
```

Every WebSocket connection gets a unique `socketId` (a UUID v4) assigned automatically. This ID is cryptographically random to prevent socket enumeration attacks -- an attacker cannot guess other clients' socket IDs to send them messages.

## Connection Handlers

The `WebSocketHandlers` interface provides callbacks for every WebSocket lifecycle event:

```typescript
interface WebSocketHandlers<TData = unknown> {
  open?(ws: WebSocketConnection<TData>): void | Promise<void>;
  message?(ws: WebSocketConnection<TData>, message: string | Buffer): void | Promise<void>;
  close?(ws: WebSocketConnection<TData>, code: number, reason: string): void | Promise<void>;
  ping?(ws: WebSocketConnection<TData>, data: Buffer): void | Promise<void>;
  pong?(ws: WebSocketConnection<TData>, data: Buffer): void | Promise<void>;
  drain?(ws: WebSocketConnection<TData>): void | Promise<void>;
}
```

The `drain` handler is worth noting -- it fires when a WebSocket's send buffer empties after being full. This is useful for implementing backpressure when broadcasting large amounts of data.

### Custom Data on Connections

The `SocketData<TData>` type lets you attach custom data to each connection during the upgrade handshake:

```typescript
interface SocketData<TData = unknown> {
  socketId: string;       // Auto-generated UUID v4
  data: TData;            // Your custom data
  topics: Set<string>;    // Subscribed topics
}
```

You set custom data during the upgrade:

```typescript
app.websocket(wsProvider, {
  upgrade: async (req) => {
    // Extract auth token from query string
    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return null; // Returning null rejects the connection
    }

    const user = await verifyToken(token);

    // Return data to attach to the connection
    return { userId: user.id, accountUuid: user.accountUuid };
  }
}).onWebSocket({
  open(ws) {
    // ws.data.data is typed based on what upgrade returned
    console.log(`User ${ws.data.data.userId} connected`);
    ws.subscribe(`account:${ws.data.data.accountUuid}`);
  }
});
```

## Pub/Sub

Pub/sub is the core messaging pattern for WebSockets. Instead of tracking individual connections, you subscribe sockets to topics and publish messages to those topics. Bun handles the fan-out at the C level.

### Subscribing and Unsubscribing

```typescript
// Subscribe a socket to a topic
ws.subscribe('account:abc-123');

// Subscribe to multiple topics
ws.subscribe('project:def-456');
ws.subscribe('incidents:def-456');

// Unsubscribe from a topic
ws.unsubscribe('incidents:def-456');
```

### Publishing to Topics

From within a WebSocket handler, you can publish to a topic:

```typescript
message(ws, rawMessage) {
  const msg = JSON.parse(rawMessage as string);

  if (msg.type === 'chat.message') {
    // Publish to the room topic -- all subscribers receive it
    ws.publish('room:lobby', JSON.stringify({
      name: 'chat.message',
      data: { from: ws.data.data.userId, text: msg.text },
      timestamp: Date.now()
    }));
  }
}
```

### Publishing from HTTP Routes

This is where the provider architecture shines. You often need to push WebSocket messages from HTTP route handlers -- for example, when a REST endpoint creates a resource and you want to notify connected clients.

The `SocketEmitter` is available from the `AppContext`:

```typescript
class IncidentController {
  constructor(
    private incidentService: IncidentClientService,
    private socket: SocketEmitter  // Injected via DI
  ) {}

  async createIncident(ctx: RequestContext) {
    const incident = await this.incidentService.create(ctx.body);

    // Push real-time update to all users in the account
    await this.socket.publish(
      `account:${incident.accountUuid}`,
      JSON.stringify({
        name: 'incident.created',
        data: { uuid: incident.uuid, title: incident.title },
        timestamp: Date.now()
      })
    );

    return Response.json(incident, { status: 201 });
  }
}
```

### Broadcasting

Broadcasting sends a message to every connected socket, regardless of topic subscriptions:

```typescript
// System-wide announcement
socket.broadcast(JSON.stringify({
  name: 'system.maintenance',
  data: { message: 'Server restarting in 5 minutes', scheduledAt: Date.now() + 300000 },
  timestamp: Date.now()
}));
```

Broadcasting uses a special `__broadcast__` topic internally. Every socket is automatically subscribed to this topic when they connect.

## Type-Safe Message Emission

Raw JSON string serialization is error-prone. OriJS provides a type-safe `emit()` method that validates message data against a schema before sending:

```typescript
import { SocketMessage } from '@orijs/core';
import { Type } from '@orijs/validation';

// Define message types with TypeBox schemas
const IncidentCreated = SocketMessage.define({
  name: 'incident.created',
  data: Type.Object({
    uuid: Type.String(),
    title: Type.String(),
    severity: Type.String(),
    status: Type.String()
  })
});

const MonitorStatusChanged = SocketMessage.define({
  name: 'monitor.status_changed',
  data: Type.Object({
    monitorUuid: Type.String(),
    previousStatus: Type.String(),
    currentStatus: Type.String()
  })
});
```

Now you can emit messages with full type safety and runtime validation:

```typescript
// This is type-checked at compile time AND validated at runtime
await socket.emit(IncidentCreated, `account:${accountUuid}`, {
  uuid: incident.uuid,
  title: incident.title,
  severity: 'critical',
  status: 'investigating'
});

// Type error: missing 'currentStatus' field
await socket.emit(MonitorStatusChanged, `project:${projectUuid}`, {
  monitorUuid: monitor.uuid,
  previousStatus: 'up'
  // TypeScript catches this at compile time
});
```

The `emit()` method serializes the message in a standard envelope format:

```json
{
  "name": "incident.created",
  "data": {
    "uuid": "inc-456",
    "title": "Server Down",
    "severity": "critical",
    "status": "investigating"
  },
  "timestamp": 1706789012345
}
```

This envelope format is consistent between the server-side `SocketEmitter.emit()` and what the client-side `SocketClient` expects. Both sides speak the same protocol.

## Custom Socket Emitters

For larger applications, you often want domain-specific methods instead of raw `publish()` calls. Custom socket emitters wrap the provider with methods that match your domain:

```typescript
import type { SocketEmitter, WebSocketProvider, SocketMessageLike } from '@orijs/websocket';

class AppSocketEmitter implements SocketEmitter {
  constructor(private readonly provider: WebSocketProvider) {}

  // Delegate base methods to provider
  publish(topic: string, message: string | ArrayBuffer) { return this.provider.publish(topic, message); }
  send(socketId: string, message: string | ArrayBuffer) { this.provider.send(socketId, message); }
  broadcast(message: string | ArrayBuffer) { this.provider.broadcast(message); }
  emit<T>(msg: SocketMessageLike<T>, topic: string, data: T) { return this.provider.emit(msg, topic, data); }

  // Domain-specific methods
  async emitToAccount(accountUuid: string, message: SocketMessageLike<any>, data: any) {
    return this.provider.emit(message, `account:${accountUuid}`, data);
  }

  async emitToProject(accountUuid: string, projectUuid: string, message: SocketMessageLike<any>, data: any) {
    return this.provider.emit(message, `project:${accountUuid}:${projectUuid}`, data);
  }

  async notifyUser(userUuid: string, message: SocketMessageLike<any>, data: any) {
    return this.provider.emit(message, `user:${userUuid}`, data);
  }
}
```

Register the custom emitter when configuring the application:

```typescript
app.websocket<AppSocketEmitter>(wsProvider, { emitter: AppSocketEmitter })
  .onWebSocket(handlers);
```

Now `ctx.app.socket` is typed as `AppSocketEmitter` throughout your application, giving you domain-specific methods with full type safety.

## Socket Routers

For complex WebSocket applications, raw message handlers become unwieldy. Socket Routers provide a structured approach with a clear two-phase model:

1. **Connection phase**: Guards run ONCE on WebSocket upgrade to authenticate the client
2. **Routing phase**: Messages are routed to handlers based on their `type` field

This mirrors how HTTP controllers work -- authenticate once, then route requests.

### The OriSocketRouter Interface

```typescript
interface OriSocketRouter<TState extends object, TSocket extends SocketEmitter> {
  configure(route: SocketRouteBuilder<TState, TSocket>): void;
}
```

Here is a complete socket router example:

```typescript
import type { OriSocketRouter, SocketRouteBuilder, SocketCtx } from '@orijs/core';
import { Type } from '@orijs/validation';

interface AuthState {
  user: { uuid: string; accountUuid: string; name: string };
}

class DashboardSocketRouter implements OriSocketRouter<AuthState, AppSocketEmitter> {
  constructor(
    private presenceService: PresenceClientService,
    private monitorService: MonitorClientService
  ) {}

  configure(r: SocketRouteBuilder<AuthState, AppSocketEmitter>) {
    // Phase 1: Connection guard -- authenticates once on upgrade
    r.connectionGuard(FirebaseSocketAuthGuard);

    // Phase 2: Message routes
    r.on('heartbeat', this.handleHeartbeat);
    r.on('subscribe.monitors', this.handleSubscribeMonitors, Type.Object({
      projectUuid: Type.String()
    }));
    r.on('presence.update', this.handlePresenceUpdate, Type.Object({
      status: Type.Union([Type.Literal('active'), Type.Literal('idle'), Type.Literal('away')])
    }));
  }

  private handleHeartbeat = async (ctx: SocketCtx<AuthState, AppSocketEmitter>) => {
    await this.presenceService.recordHeartbeat(ctx.state.user.uuid);
    return { timestamp: Date.now() };
  };

  private handleSubscribeMonitors = async (ctx: SocketCtx<AuthState, AppSocketEmitter>) => {
    const { projectUuid } = ctx.data as { projectUuid: string };
    // Subscribe this socket to monitor updates for the project
    ctx.subscribe(`monitors:${ctx.state.user.accountUuid}:${projectUuid}`);
    return { subscribed: true };
  };

  private handlePresenceUpdate = async (ctx: SocketCtx<AuthState, AppSocketEmitter>) => {
    const { status } = ctx.data as { status: string };
    await this.presenceService.updateStatus(ctx.state.user.uuid, status);

    // Broadcast presence change to the account
    await ctx.app.socket.emitToAccount(ctx.state.user.accountUuid, PresenceChanged, {
      userUuid: ctx.state.user.uuid,
      status
    });

    return { updated: true };
  };
}
```

### Message Format

Socket Routers expect messages in this format:

```typescript
interface SocketMessage<TData = unknown> {
  type: string;           // Routes to handler (e.g., 'heartbeat')
  data?: TData;           // Optional message data
  correlationId?: string; // Optional ID for request-response matching
}
```

The response format mirrors the request:

```typescript
interface SocketResponse<TData = unknown> {
  type: string;           // Original message type
  data: TData;            // Handler return value
  correlationId?: string; // Echoed from request
  error?: string;         // Present only on errors
}
```

The `correlationId` enables request-response patterns over WebSockets. The client sends a message with a unique ID, and the server echoes it back in the response so the client can match responses to requests.

### Connection Guards

Connection guards run once when a client upgrades from HTTP to WebSocket. They authenticate the connection and set state that persists for the entire session:

```typescript
class FirebaseSocketAuthGuard implements SocketGuard {
  constructor(private authService: AuthClientService) {}

  async canActivate(ctx: SocketContextLike): Promise<boolean> {
    // The auth token was passed during WebSocket upgrade
    const token = ctx.data as { token?: string };

    if (!token?.token) {
      return false; // Connection rejected
    }

    const user = await this.authService.verifyToken(token.token);
    if (!user) {
      return false;
    }

    // Set state that persists for the entire connection
    ctx.set('user', user);

    return true; // Connection allowed
  }
}
```

Topic subscriptions based on authenticated state are typically done in the `open` handler or a message handler, where `ws.subscribe()` is available:

```typescript
// In the open handler, access connection state for topic subscriptions
open(ws) {
  ws.subscribe(`account:${ws.data.data.accountUuid}`);
}
```

### Message Guards

Unlike connection guards, message guards run on every message. Use them for rate limiting, permission checks per operation, or feature flags:

```typescript
class RateLimitGuard implements SocketGuard {
  private readonly limits = new Map<string, number[]>();

  canActivate(ctx: SocketContextLike): boolean {
    const socketId = ctx.socketId;
    const now = Date.now();
    const window = 60000; // 1 minute
    const maxRequests = 100;

    const timestamps = this.limits.get(socketId) ?? [];
    const recent = timestamps.filter(t => t > now - window);
    recent.push(now);
    this.limits.set(socketId, recent);

    return recent.length <= maxRequests;
  }
}

// Apply to specific routes
r.on('chat.send', this.handleChatSend).guard(RateLimitGuard);
```

### Built-in Control Messages

OriJS ships with built-in control message definitions for common operations:

```typescript
import { MessageRegistry, JoinRoom, LeaveRoom, Heartbeat } from '@orijs/websocket';

const registry = new MessageRegistry<{ userId: string }>()
  .on(JoinRoom, async (ws, data) => {
    ws.subscribe(data.room);
  })
  .on(LeaveRoom, async (ws, data) => {
    ws.unsubscribe(data.room);
  })
  .on(Heartbeat, async (ws) => {
    ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
  });
```

You can also define your own server-side message definitions:

```typescript
import { ServerMessage } from '@orijs/websocket';
import { Type } from '@orijs/validation';

const CursorMove = ServerMessage.define({
  name: 'cursor.move',
  data: Type.Object({
    x: Type.Number(),
    y: Type.Number(),
    documentId: Type.String()
  })
});

registry.on(CursorMove, async (ws, data) => {
  // Broadcast cursor position to everyone in the document
  ws.publish(`document:${data.documentId}`, JSON.stringify({
    name: 'cursor.moved',
    data: { userId: ws.data.data.userId, x: data.x, y: data.y },
    timestamp: Date.now()
  }));
});
```

The `MessageRegistry` validates incoming messages against schemas before calling handlers. If validation fails, it returns a structured error result that you can send back to the client:

```typescript
// In your message handler
const { type, ...data } = JSON.parse(rawMessage);
const result = await registry.handle(ws, type, data);

if (!result.handled) {
  ws.send(JSON.stringify({
    type: 'error',
    message: `Invalid message: ${result.reason}`,
    details: result.details
  }));
}
```

## Redis WebSocket Provider for Horizontal Scaling

The `InProcWsProvider` works perfectly for a single server instance. But when you scale horizontally -- running multiple server instances behind a load balancer -- a client connected to Instance A cannot receive messages published on Instance B. The `RedisWsProvider` solves this by bridging Bun's native pub/sub with Redis pub/sub.

### How It Works

```
                          ┌──────────────────┐
                          │   Load Balancer   │
                          └─────────┬────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
             ┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼──────┐
             │ Instance A  │ │ Instance B │ │ Instance C  │
             │             │ │            │ │             │
             │ Client 1 ──┐│ │ Client 3 ─┐│ │ Client 5 ──┐│
             │ Client 2 ──┤│ │ Client 4 ─┤│ │ Client 6 ──┤│
             │             ││ │           ││ │             ││
             │ RedisWs    ││ │ RedisWs   ││ │ RedisWs    ││
             │ Provider   ││ │ Provider  ││ │ Provider   ││
             └──────┬──────┘│ └─────┬─────┘│ └──────┬─────┘│
                    │       │       │      │        │      │
                    └───────┼───────┼──────┼────────┘      │
                            │       │      │               │
                      ┌─────▼───────▼──────▼───────────────▼┐
                      │              Redis                   │
                      │                                      │
                      │  Channel: ws:account:abc-123         │
                      │  Channel: ws:project:def-456         │
                      │  Channel: ws:__broadcast__           │
                      └──────────────────────────────────────┘
```

When Instance A publishes to `account:abc-123`:

1. The `RedisWsProvider` on Instance A serializes the message into a Redis envelope and publishes it to the Redis channel `ws:account:abc-123`
2. Redis delivers the message to all subscribers of that channel
3. The `RedisWsProvider` on Instance B receives the message via its subscriber connection
4. Instance B's provider calls `server.publish('account:abc-123', message)` locally
5. Bun delivers the message to Client 3 and Client 4 (who are subscribed to that topic on Instance B)

The process is transparent to your application code. The same `socket.publish()` call works whether you are using `InProcWsProvider` or `RedisWsProvider`.

### Configuration

```typescript
import { createRedisWsProvider } from '@orijs/websocket-redis';

const wsProvider = createRedisWsProvider({
  connection: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379')
  },
  keyPrefix: 'myapp:ws',     // Redis channel prefix (default: 'ws')
  connectTimeout: 5000        // Connection timeout in ms (default: 2000)
});

// Use exactly the same way as InProcWsProvider
app.websocket(wsProvider).onWebSocket(handlers);
```

### Two Redis Connections

The `RedisWsProvider` creates **two** Redis connections internally:

- **Publisher**: Used for `PUBLISH` commands
- **Subscriber**: Used for `SUBSCRIBE`/`UNSUBSCRIBE` and receiving messages

This separation is required by Redis. A connection in subscriber mode cannot issue `PUBLISH` commands -- it is a fundamental Redis protocol constraint. The provider manages both connections transparently.

### Automatic Reconnection

The Redis subscriber connection automatically resubscribes to all tracked channels when it reconnects after a temporary disconnection. The provider tracks which channels have local subscribers and restores the state:

```typescript
// This happens automatically inside RedisWsProvider
subscriber.on('ready', () => {
  // Re-subscribe to all channels in batches (prevents stack overflow)
  this.resubscribeAll();
});
```

Subscribe operations use exponential backoff with jitter for retries, preventing thundering herd when Redis temporarily becomes unavailable.

### Smart Subscription Management

The provider only subscribes to a Redis channel when the first local socket subscribes to a topic, and unsubscribes from Redis when the last local socket unsubscribes. This means if 1,000 clients are subscribed to `account:abc-123` on your instance, there is still only one Redis subscription for that topic.

## Writing a Custom WebSocket Scaling Provider

If Redis does not fit your infrastructure -- perhaps you use NATS, Kafka, or a custom message broker -- you can write your own provider. Implement the `WebSocketProvider` interface:

```typescript
import type { WebSocketProvider, BunServer, SocketMessageLike } from '@orijs/websocket';
import { validateTopic, validateSocketId } from '@orijs/websocket';
import { validate } from '@orijs/validation';

class NatsWsProvider implements WebSocketProvider {
  private server: BunServer | null = null;
  private readonly localSubscriptions = new Map<string, Set<string>>();
  private readonly connectedSockets = new Set<string>();
  private natsConnection: any = null;

  constructor(private readonly natsUrl: string) {}

  // Lifecycle
  async start(): Promise<void> {
    this.natsConnection = await connectToNats(this.natsUrl);
  }

  async stop(): Promise<void> {
    await this.natsConnection?.close();
    this.localSubscriptions.clear();
    this.connectedSockets.clear();
  }

  // Emitter
  async publish(topic: string, message: string | ArrayBuffer): Promise<void> {
    validateTopic(topic);
    // Publish to NATS for cross-instance delivery
    await this.natsConnection.publish(`ws.${topic}`, message);
    // Also publish locally
    this.server?.publish(topic, message);
  }

  send(socketId: string, message: string | ArrayBuffer): void {
    validateSocketId(socketId);
    this.server?.publish(`__socket__:${socketId}`, message);
  }

  broadcast(message: string | ArrayBuffer): void {
    this.publish('__broadcast__', message).catch(() => {});
  }

  async emit<TData>(message: SocketMessageLike<TData>, topic: string, data: TData): Promise<void> {
    const result = await validate(message.dataSchema, data);
    if (!result.success) {
      throw new Error(`Validation failed: ${result.errors.map(e => e.message).join(', ')}`);
    }
    const payload = JSON.stringify({ name: message.name, data: result.data, timestamp: Date.now() });
    return this.publish(topic, payload);
  }

  // Connection management
  subscribe(socketId: string, topic: string): void {
    validateSocketId(socketId);
    validateTopic(topic);
    // Track locally, subscribe to NATS on first subscriber
    let subs = this.localSubscriptions.get(topic);
    if (!subs) {
      subs = new Set();
      this.localSubscriptions.set(topic, subs);
      // First subscriber -- subscribe to NATS
      this.natsConnection.subscribe(`ws.${topic}`, (msg: any) => {
        this.server?.publish(topic, msg.data);
      });
    }
    subs.add(socketId);
    this.connectedSockets.add(socketId);
  }

  unsubscribe(socketId: string, topic: string): void { /* mirror of subscribe */ }
  disconnect(socketId: string): void { /* clean up all subscriptions */ }
  isConnected(socketId: string): boolean { return this.connectedSockets.has(socketId); }
  getConnectionCount(): number { return this.connectedSockets.size; }
  getTopicSubscriberCount(topic: string): number { return this.localSubscriptions.get(topic)?.size ?? 0; }
  setServer(server: BunServer): void { this.server = server; }
}
```

The key insight: your custom provider is responsible for cross-instance message delivery, while Bun's native `server.publish()` handles the last mile -- delivering messages to WebSocket connections on the local instance.

## The WebSocket Client

OriJS provides a browser WebSocket client (`@orijs/websocket-client`) that speaks the same protocol as the server. It handles reconnection, heartbeats, room management, and type-safe message handling.

### Basic Client Usage

```typescript
import { SocketClient, Connected, Disconnected, ClientMessage } from '@orijs/websocket-client';

// Define message types (or import from a shared definitions package)
const IncidentCreated = ClientMessage.define<{ uuid: string; title: string }>('incident.created');
const MonitorStatus = ClientMessage.define<{ monitorUuid: string; status: string }>('monitor.status_changed');

const client = new SocketClient('wss://api.example.com/ws', {
  reconnect: true,
  maxReconnectAttempts: Infinity,
  heartbeatInterval: 25000,    // Ping every 25s (safe for Cloudflare, AWS ALB)
  heartbeatTimeout: 5000,      // Consider dead if no pong in 5s
  connectionTimeout: 5000      // Fail fast if can't connect in 5s
});

// Type-safe message handlers
client.on(IncidentCreated, (data) => {
  // data is typed as { uuid: string; title: string }
  showNotification(`New incident: ${data.title}`);
});

client.on(MonitorStatus, (data, envelope) => {
  // envelope includes timestamp
  updateMonitorCard(data.monitorUuid, data.status, envelope.timestamp);
});

// Connection lifecycle
client.on(Connected, ({ reconnected }) => {
  if (reconnected) {
    console.log('Reconnected -- refreshing data');
  }
  client.joinRoom(`account:${accountUuid}`);
});

client.on(Disconnected, () => {
  showBanner('Connection lost. Reconnecting...');
});

client.connect();
```

### Automatic Reconnection

The client uses full jitter exponential backoff for reconnection, which is the optimal strategy for distributed systems. The delay is randomized within an exponential range with a guaranteed minimum:

```
Attempt 1: 500ms + random(0, 500ms)  = random(500ms, 1000ms)
Attempt 2: 500ms + random(0, 1000ms) = random(500ms, 1500ms)
Attempt 3: 500ms + random(0, 2000ms) = random(500ms, 2500ms)
...
Attempt N: 500ms + random(0, min(maxDelay, 500ms * 2^N)), capped at maxDelay
```

The base delay (`reconnectDelay`, default 500ms) ensures a minimum wait before every reconnection attempt. Full jitter above that base prevents the "thundering herd" problem where all disconnected clients try to reconnect at the exact same time after a server restart.

### Browser-Aware Reconnection

The client detects browser state changes:

- **Page hidden** (tab switched): Skips reconnection attempts to save resources. Reconnects immediately when the tab becomes visible again.
- **Device offline** (`navigator.onLine === false`): Stops reconnection attempts entirely. Reconnects immediately when the `online` event fires.

This is critical for mobile browsers where aggressive reconnection wastes battery.

### Room Management with Auto-Rejoin

```typescript
// Rooms are tracked and auto-rejoined on reconnect
client.joinRoom(`account:${accountUuid}`);
client.joinRoom(`project:${projectUuid}`);

// Leave a room
client.leaveRoom(`project:${projectUuid}`);

// Rooms persist across reconnections automatically
// No need to manually rejoin after disconnect/reconnect
```

### Heartbeat Protocol

The client implements a minimal ping/pong protocol using single-character frames:

- Client sends `'2'` (ping)
- Server responds `'3'` (pong)

This is 1 byte per heartbeat instead of ~50 bytes for a JSON heartbeat message. With a 25-second interval, the bandwidth overhead is negligible even on mobile connections.

The heartbeat interval should be less than your proxy/load balancer's idle timeout:
- Cloudflare: 100s (non-configurable for non-Enterprise)
- AWS ALB: 60s (configurable up to 4000s)
- NGINX: configurable via `proxy_read_timeout`

The default 25s interval is safe for all common configurations.

### Send Buffering

Messages sent while disconnected are buffered and automatically sent when the connection is re-established:

```typescript
// Even if disconnected, this message will be sent on reconnect
client.emit(JoinRoom, { room: `account:${accountUuid}` });

// Raw sends are NOT buffered by default (opt-in)
client.sendRaw('some data', { buffer: true });
```

## Putting It All Together

Here is a real-world example combining all the WebSocket features for a monitoring dashboard:

```typescript
// messages.ts -- Shared between server and client
import { SocketMessage } from '@orijs/core';
import { Type } from '@orijs/validation';

export const IncidentCreated = SocketMessage.define({
  name: 'incident.created',
  data: Type.Object({
    uuid: Type.String(),
    title: Type.String(),
    severity: Type.String(),
    monitorUuid: Type.String()
  })
});

export const MonitorStatusChanged = SocketMessage.define({
  name: 'monitor.status_changed',
  data: Type.Object({
    monitorUuid: Type.String(),
    previousStatus: Type.String(),
    currentStatus: Type.String(),
    checkedAt: Type.String()
  })
});
```

```typescript
// socket-router.ts -- Server-side
class MonitoringSocketRouter implements OriSocketRouter<AuthState, AppSocketEmitter> {
  constructor(private presenceService: PresenceClientService) {}

  configure(r: SocketRouteBuilder<AuthState, AppSocketEmitter>) {
    r.connectionGuard(FirebaseSocketAuthGuard);

    r.on('heartbeat', this.handleHeartbeat);
    r.on('subscribe.project', this.handleSubscribeProject, Type.Object({
      projectUuid: Type.String()
    }));
  }

  private handleHeartbeat = async (ctx: SocketCtx<AuthState, AppSocketEmitter>) => {
    await this.presenceService.recordHeartbeat(ctx.state.user.uuid);
    return { timestamp: Date.now() };
  };

  private handleSubscribeProject = async (ctx: SocketCtx<AuthState, AppSocketEmitter>) => {
    const { projectUuid } = ctx.data as { projectUuid: string };
    const { accountUuid } = ctx.state.user;

    ctx.subscribe(`monitors:${accountUuid}:${projectUuid}`);
    ctx.subscribe(`incidents:${accountUuid}:${projectUuid}`);

    return { subscribed: true, projectUuid };
  };
}
```

```typescript
// incident.controller.ts -- Publishing from HTTP routes
class IncidentController {
  constructor(
    private incidentService: IncidentClientService,
    private socket: AppSocketEmitter
  ) {}

  async createIncident(ctx: RequestContext) {
    const incident = await this.incidentService.create(ctx.body);

    // Real-time notification via WebSocket
    await this.socket.emit(
      IncidentCreated,
      `incidents:${incident.accountUuid}:${incident.projectUuid}`,
      {
        uuid: incident.uuid,
        title: incident.title,
        severity: incident.severity,
        monitorUuid: incident.monitorUuid
      }
    );

    return Response.json(incident, { status: 201 });
  }
}
```

```typescript
// dashboard.svelte -- Client-side (Svelte 5)
<script lang="ts">
import { SocketClient, Connected, ClientMessage } from '@orijs/websocket-client';

const IncidentCreated = ClientMessage.define<{
  uuid: string; title: string; severity: string; monitorUuid: string;
}>('incident.created');

const MonitorStatusChanged = ClientMessage.define<{
  monitorUuid: string; previousStatus: string; currentStatus: string;
}>('monitor.status_changed');

const client = new SocketClient('wss://api.example.com/ws');

client.on(Connected, () => {
  client.joinRoom(`account:${accountUuid}`);
  client.send('subscribe.project', { projectUuid });
});

client.on(IncidentCreated, (data) => {
  incidents = [{ ...data, createdAt: new Date() }, ...incidents];
  showToast(`New incident: ${data.title}`, data.severity);
});

client.on(MonitorStatusChanged, (data) => {
  updateMonitor(data.monitorUuid, data.currentStatus);
});

client.connect();
</script>
```

## Summary

OriJS WebSocket support gives you the performance of Bun's native implementation with the structure of a production framework:

- **Provider-based architecture** -- swap `InProcWsProvider` for `RedisWsProvider` without changing application code
- **Type-safe messaging** -- schema-validated messages with compile-time type checking
- **Socket Routers** -- structured two-phase model with connection guards and message routing
- **Horizontal scaling** -- Redis provider bridges instances transparently
- **Production client** -- automatic reconnection, heartbeats, room management, browser awareness
- **Custom providers** -- implement `WebSocketProvider` to use any pub/sub backend

The provider interface is the key design decision. Your business logic calls `socket.emit()` and does not care whether messages are delivered via in-process pub/sub or Redis. When you outgrow a single server, you swap one line of configuration and deploy.

---

[Previous: Workflows <-](./12-workflows.md) | [Next: Caching ->](./14-caching.md)
