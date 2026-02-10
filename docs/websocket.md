# WebSocket System Technical Reference

Technical specification for `@orijs/websocket`, `@orijs/websocket-redis`, and `@orijs/websocket-client`. Covers server-side connection management, Redis-backed horizontal scaling, and the browser client.

Source packages:
- `packages/websocket/src/` -- server-side core
- `packages/websocket-redis/src/` -- Redis pub/sub provider
- `packages/websocket-client/src/` -- browser client

---

## Part 1: @orijs/websocket (Server)

### 1. Interface Hierarchy (ISP)

**Source**: `packages/websocket/src/types.ts`

The WebSocket system uses Interface Segregation with three layers:

```
SocketEmitter          -- consumer-facing (services inject this)
SocketLifecycle        -- framework-facing (start/stop)
WebSocketProvider      -- implementation (extends both, adds subscribe/unsubscribe/disconnect)
```

#### SocketEmitter

```typescript
interface SocketEmitter {
    publish(topic: string, message: string | ArrayBuffer): Promise<void>;
    send(socketId: string, message: string | ArrayBuffer): void;
    broadcast(message: string | ArrayBuffer): void;
    emit<TData>(message: SocketMessageLike<TData>, topic: string, data: TData): Promise<void>;
}
```

Services depend on `SocketEmitter`, not `WebSocketProvider`. The `emit()` method validates data against the message's schema before serializing to the standard envelope format: `{ name, data, timestamp }`.

#### SocketLifecycle

```typescript
interface SocketLifecycle {
    start(): Promise<void>;   // called BEFORE setServer()
    stop(): Promise<void>;
}
```

Both methods must be idempotent. `start()` is called during application startup before the Bun server is available. Implementations must not attempt to publish during `start()`.

#### WebSocketProvider

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

### 2. InProcWsProvider -- Single-Instance Pub/Sub

**Source**: `packages/websocket/src/in-proc-provider.ts`

In-process provider using Bun's native `server.publish()`. Not horizontally scalable.

#### Internal State

| Map | Type | Purpose |
|-----|------|---------|
| `localSubscriptions` | `Map<string, Set<string>>` | topic -> Set of socket IDs |
| `socketTopics` | `Map<string, Set<string>>` | socket ID -> Set of topics (reverse index) |
| `connectedSockets` | `Set<string>` | Connected socket IDs |

The reverse index (`socketTopics`) enables O(S) disconnect cleanup (where S is the number of topics for a socket) instead of O(T) scan across all topics.

#### publish()

Validates topic, checks server reference, calls `this.server.publish(topic, message)`. Returns `Promise.resolve()` (synchronous operation wrapped for interface compatibility).

#### send()

Publishes to the socket-specific topic `__socket__:{socketId}`.

#### broadcast()

Publishes to the special `__broadcast__` topic. All connected sockets must be subscribed to this topic to receive broadcasts.

#### emit()

Validates data against the schema using `validate()` from `@orijs/validation` (supports TypeBox, Standard Schema, and custom validators). On validation failure, throws with details. On success, serializes as JSON envelope and delegates to `publish()`.

#### subscribe() / unsubscribe()

Updates both `localSubscriptions` and `socketTopics` maps. Validates socket ID (UUID v4 format) and topic before any state changes.

`unsubscribe()` automatically marks a socket as disconnected when its last subscription is removed (`connectedSockets.delete(socketId)`).

#### disconnect()

Uses the reverse index for efficient cleanup:
1. Iterates topics from `socketTopics.get(socketId)`
2. Removes socket from each topic's subscriber set in `localSubscriptions`
3. Cleans up empty topic entries
4. Deletes `socketTopics` entry and removes from `connectedSockets`

#### Thread Safety

All operations are synchronous in JavaScript's single-threaded event loop. No race conditions are possible within a single instance.

### 3. SocketCoordinator -- Connection and Subscription Management

**Source**: `packages/websocket/src/socket-coordinator.ts`

Bridges Bun WebSocket connections with the provider abstraction. Maintains local connection state and delegates pub/sub operations to the provider.

#### Internal State

| Map | Type | Purpose |
|-----|------|---------|
| `connections` | `Map<string, WebSocketConnection<unknown>>` | socket ID -> WebSocket connection |
| `topicSubscriptions` | `Map<string, Set<string>>` | topic -> Set of socket IDs |

#### State Ownership

The coordinator maintains local state (connections, subscriptions) for the current server instance. The provider maintains its own subscription state for cross-instance coordination (e.g., Redis pub/sub). These are intentionally separate -- coordinator state is authoritative for local connections.

#### addConnection()

Stores the WebSocket connection with type erasure (`WebSocketConnection<unknown>`). Idempotent -- skips if socket ID already tracked.

#### removeConnection()

1. Copies `ws.data.topics` to array (avoids concurrent modification)
2. Calls `unsubscribeFromTopic()` for each topic
3. Deletes from `connections` map

#### subscribeToTopic()

1. Validates socket exists in `connections`
2. Idempotent check on `topicSubscriptions`
3. Updates `topicSubscriptions` map and `ws.data.topics` set
4. Calls `ws.subscribe(topic)` (Bun's native topic system)
5. Calls `provider.subscribe(socketId, topic)` (cross-instance coordination)

#### getTopicSubscribers()

O(1) lookup from `topicSubscriptions` map, then resolves socket IDs to `WebSocketConnection` objects.

### 4. MessageRegistry -- Validated Message Routing

**Source**: `packages/websocket/src/message-registry.ts`

Server-side message handler registry with schema validation. Only registered message types are accepted.

#### ServerMessageDefinition

```typescript
interface ServerMessageDefinition<TData> {
    readonly name: string;
    readonly dataSchema: Schema<TData>;  // TypeBox, Standard Schema, or custom
    readonly _data: TData;               // type carrier (undefined at runtime)
}
```

#### Registration

```typescript
class MessageRegistry<TSocketData = unknown> {
    on<TData>(message: ServerMessageDefinition<TData>, handler: MessageHandler<TData, TSocketData>): this;
    has(type: string): boolean;
    getRegisteredTypes(): string[];
    handle(ws, type, data): Promise<HandleResult>;
}
```

`on()` registers a handler for a message type. Warns if overwriting an existing handler. Returns `this` for chaining.

#### handle()

```typescript
type HandleResult =
    | { handled: true }
    | { handled: false; reason: 'unknown_type' | 'validation_failed'; details?: string };
```

Execution flow:
1. Look up handler by `type` in internal map. If not found, return `{ handled: false, reason: 'unknown_type' }`.
2. Validate `data` against the registered schema. If validation fails, return `{ handled: false, reason: 'validation_failed', details }`.
3. Call handler with validated data. If handler throws, re-throw (let caller decide).
4. Return `{ handled: true }`.

### 5. SocketData Structure -- Per-Connection Data

**Source**: `packages/websocket/src/types.ts`

```typescript
interface SocketData<TData = unknown> {
    socketId: string;       // UUID v4 (crypto.randomUUID())
    data: TData;            // application-specific data from upgrade
    topics: Set<string>;    // subscribed topics
}

type WebSocketConnection<TData> = ServerWebSocket<SocketData<TData>>;
```

The `socketId` must be cryptographically random (UUID v4) to prevent socket enumeration and message injection attacks.

### 6. Validation and Security

**Source**: `packages/websocket/src/validation.ts`

#### Topic Validation

```typescript
function validateTopic(topic: string): void
```

- Must not be empty
- Maximum length: `MAX_TOPIC_LENGTH = 256` characters
- Allowed characters: `[a-zA-Z0-9_:.\-]` (strict allowlist via regex `/^[\w:.\-]+$/`)
- Throws `Error` on violation

#### Socket ID Validation

```typescript
function validateSocketId(socketId: string): void
```

- Must not be empty
- Must match UUID v4 format: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`
- Throws `Error` on violation

### 7. Built-in Control Messages

**Source**: `packages/websocket/src/control-messages.ts`

```typescript
const JoinRoom = ServerMessage.define({
    name: 'room.join',
    data: Type.Object({ room: Type.String({ minLength: 1, maxLength: 255 }) })
});

const LeaveRoom = ServerMessage.define({
    name: 'room.leave',
    data: Type.Object({ room: Type.String({ minLength: 1, maxLength: 255 }) })
});

const Heartbeat = ServerMessage.define({
    name: 'heartbeat',
    data: Type.Object({})
});
```

`ServerMessage.define()` creates a frozen `ServerMessageDefinition` from a TypeBox schema. Uses `Static<T>` for type inference from the schema.

---

## Part 2: @orijs/websocket-redis (Horizontal Scaling)

**Source**: `packages/websocket-redis/src/redis-websocket-provider.ts`

### 8. RedisWsProvider -- Multi-Instance Pub/Sub

Bridges Redis pub/sub to Bun's native WebSocket publishing. Messages published on any instance are delivered to all instances subscribed to the topic.

#### Constructor

```typescript
class RedisWsProvider implements WebSocketProvider {
    constructor(options: RedisWsProviderOptions)
}

interface RedisWsProviderOptions extends WebSocketProviderOptions {
    readonly connection: { host: string; port: number };
    readonly keyPrefix?: string;           // default: 'ws'
    readonly connectTimeout?: number;      // default: 2000ms
}
```

#### Dual Redis Connections

Two separate `ioredis` instances are created:
- **Publisher**: Issues `PUBLISH` commands
- **Subscriber**: Issues `SUBSCRIBE`/`UNSUBSCRIBE` and receives messages

This separation is required by the Redis protocol -- a connection in subscriber mode cannot issue `PUBLISH` commands.

Both connections use:
- `connectTimeout`: from options (default 2000ms)
- `commandTimeout`: same as connect timeout
- `maxRetriesPerRequest: 1` (fail fast)

#### Internal State

| Structure | Type | Purpose |
|-----------|------|---------|
| `localSubscriptions` | `Map<string, Set<string>>` | topic -> socket IDs |
| `socketTopics` | `Map<string, Set<string>>` | socket ID -> topics (reverse index) |
| `connectedSockets` | `Set<string>` | Connected socket IDs |
| `redisSubscriptions` | `Set<string>` | Redis channels currently subscribed |
| `pendingSubscriptions` | `Set<string>` | Channels with in-flight subscribe operations |
| `pendingUnsubscriptions` | `Set<string>` | Channels with in-flight unsubscribe operations |
| `retryTimeouts` | `Set<ReturnType<typeof setTimeout>>` | Active retry timers (for cleanup during stop) |

### 9. Channel Naming

```typescript
private getRedisChannel(topic: string): string {
    return `${this.keyPrefix}:${topic}`;
}
```

| Channel Pattern | Purpose |
|----------------|---------|
| `{keyPrefix}:{topic}` | Standard topic channel |
| `{keyPrefix}:__socket__:{socketId}` | Direct socket messaging |
| `{keyPrefix}:__broadcast__` | Broadcast to all sockets |

### 10. Message Envelope Protocol

```typescript
interface RedisMessageEnvelope {
    readonly topic: string;
    readonly message: string;
    readonly isBinary: boolean;
}
```

Binary messages are Base64-encoded before publishing and decoded on receipt:

```typescript
// Publishing
message instanceof ArrayBuffer ? Buffer.from(message).toString('base64') : message

// Receiving
isBinary ? Buffer.from(message, 'base64') : message
```

The envelope is JSON-serialized for transport over Redis `PUBLISH`.

### 11. Subscription Lifecycle

#### subscribe()

Lazy subscription: subscribes to the Redis channel only on the first local subscriber for a topic.

```
subscribe(socketId, topic):
  1. Track in localSubscriptions[topic] and socketTopics[socketId]
  2. If first subscriber for this topic:
     a. Check pendingUnsubscriptions -- if found, cancel unsubscription (channel still active)
     b. Check redisSubscriptions and pendingSubscriptions -- skip if already subscribed/pending
     c. Add to pendingSubscriptions
     d. Call subscribeWithRetry(channel)
```

Race condition handling: If a topic is being unsubscribed (pending) and a new subscriber arrives, the unsubscription is cancelled by removing from `pendingUnsubscriptions` and re-adding to `redisSubscriptions`.

#### unsubscribe()

Lazy unsubscription: unsubscribes from the Redis channel when the last local subscriber leaves.

```
unsubscribe(socketId, topic):
  1. Remove from localSubscriptions[topic]
  2. If no more local subscribers:
     a. Remove from redisSubscriptions
     b. Add to pendingUnsubscriptions
     c. Async: subscriber.unsubscribe(channel)
     d. Finally: remove from pendingUnsubscriptions
  3. Update socketTopics reverse index
  4. If socket has no remaining topics, remove from connectedSockets
```

Unsubscription failures are logged but do not throw.

#### disconnect()

Uses the reverse index (`socketTopics`) for O(S) cleanup:
1. For each topic the socket subscribed to:
   - Remove socket from `localSubscriptions[topic]`
   - If topic has no subscribers, unsubscribe from Redis channel
2. Clean up `socketTopics[socketId]` and `connectedSockets`

### 12. Retry Logic

**Source**: `subscribeWithRetry()` method

```typescript
private subscribeWithRetry(channel: string, attempt = 1): void
```

- Maximum retries: `SUBSCRIBE_MAX_RETRIES = 3`
- Base delay: `SUBSCRIBE_BASE_DELAY_MS = 100`
- Backoff formula: `Math.pow(2, attempt - 1) * 100 * (0.5 + Math.random())`
  - Attempt 1: 50-150ms
  - Attempt 2: 100-300ms
  - Attempt 3 (final): 200-600ms
- On final failure: logs error, removes from `pendingSubscriptions`, does not add to `redisSubscriptions`
- Retry timeouts are tracked in `retryTimeouts` set for cleanup during `stop()`
- Aborts immediately if `!this.subscriber || !this.started`

### 13. Automatic Resubscription

On Redis subscriber `'ready'` event (fires after reconnection):

```typescript
private resubscribeAll(): void
```

Re-subscribes to all channels in `redisSubscriptions`. Batched in groups of `RESUBSCRIBE_BATCH_SIZE = 1000` to prevent stack overflow from the spread operator on large channel lists.

Failures are logged but not thrown.

### 14. Redis Message Handling

```typescript
private handleRedisMessage(channel: string, rawMessage: string): void
```

1. Check `this.server` is set (warn and return if not)
2. Parse JSON and sanitize via `sanitizeJson()`
3. Validate against `RedisMessageEnvelope` structure via `isValidMessageEnvelope()`
4. Decode binary messages from Base64 if `isBinary`
5. Forward to `this.server.publish(topic, payload)` for local WebSocket delivery

### 15. Security -- Prototype Pollution Prevention

```typescript
function sanitizeJson<T>(obj: T): T
```

Recursively removes dangerous keys from parsed JSON objects:
- `__proto__`
- `constructor`
- `prototype`

Applied to all JSON parsed from Redis messages. Prevents prototype pollution attacks via malicious messages injected into Redis.

### 16. Graceful Shutdown

`stop()` performs:
1. Set `started = false`
2. Unsubscribe from all Redis channels (batched, errors logged)
3. Clear all subscription tracking sets
4. Clear all pending retry timeouts
5. Remove all event listeners from both Redis connections
6. Gracefully close both connections (`quit()` then `disconnect()` fallback)
7. Clear all local state (subscriptions, connected sockets)

---

## Part 3: @orijs/websocket-client (Browser)

### 17. SocketClient -- Browser WebSocket Client

**Source**: `packages/websocket-client/src/client.ts`

#### Constructor

```typescript
class SocketClient {
    constructor(url: string, options?: SocketClientOptions)
}
```

#### Options with Defaults

```typescript
interface SocketClientOptions {
    reconnect?: boolean;              // default: true
    maxReconnectAttempts?: number;     // default: Infinity
    reconnectDelay?: number;          // default: 500ms (min backoff)
    maxReconnectDelay?: number;       // default: 20000ms (max backoff)
    connectionTimeout?: number;       // default: 5000ms
    heartbeatInterval?: number;       // default: 25000ms
    heartbeatTimeout?: number;        // default: 5000ms
}
```

#### Connection States

```typescript
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
```

State machine:

```
disconnected --> connecting --> connected
     ^               |              |
     |               v              v
     +---------- disconnected <----+
                      |
                      v
                 reconnecting --> connecting
```

### 18. Reconnection Strategy

#### Full Jitter Backoff

```typescript
class Backoff {
    duration(): number {
        const step = Math.min(this.attempts++, 31);  // cap at 2^31
        const ceiling = Math.min(this.max, this.ms * Math.pow(2, step));
        const interval = Math.floor(Math.random() * ceiling);
        return Math.min(this.max, this.ms + interval) | 0;
    }
}
```

Formula: `min(max, min + random(0, min(max, min * 2^attempts)))`

Default range: 500ms to 20,000ms. The `| 0` ensures integer output.

Attempt counter is capped at 31 to prevent `Math.pow(2, step)` overflow beyond safe integer range.

#### maybeReconnect()

Conditions that prevent reconnection:
1. `options.reconnect === false`
2. `skipReconnect === true` (set by intentional `disconnect()`)
3. `pageHidden === true` (page is in background)
4. `deviceWentOffline === true` (waiting for `online` event)
5. `navigator.onLine === false` (checked synchronously)
6. `backoff.attempts >= maxReconnectAttempts`
7. `reconnecting === true` (already in progress)

When reconnecting:
1. Set state to `'reconnecting'`
2. Calculate delay via `backoff.duration()`
3. Schedule `connect()` via `setTimeout`
4. Emit `reconnect_attempt` internal event with attempt count

### 19. Heartbeat Protocol

Minimal ping/pong using single-character frames:
- Ping: `'2'` (PING_FRAME)
- Pong: `'3'` (PONG_FRAME)

Default interval: 25,000ms. Default timeout: 5,000ms.

The 25s interval is chosen to be safe for common proxy/load balancer idle timeouts:
- Cloudflare: 100s (non-configurable for non-Enterprise)
- AWS ALB: 60s default
- NGINX: configurable via `proxy_read_timeout`

#### Heartbeat Flow

```
1. heartbeatTimer fires every heartbeatInterval
2. sendPing(): send '2', set awaitingPong = true, start heartbeatTimeoutTimer
3a. Receive '3' -> handlePong(): clear timeout, awaitingPong = false
3b. Timeout fires -> handlePongTimeout(): close connection (onclose triggers reconnect)
```

A second ping is not sent while `awaitingPong` is true.

### 20. Browser Event Integration

**Source**: `setupNetworkEvents()` method

Set up once during construction. Only activates in browser environments (checks for `globalThis.addEventListener`).

| Event | Behavior |
|-------|----------|
| `offline` | Sets `deviceWentOffline = true`. If connected/connecting, closes WebSocket immediately. |
| `online` | If `deviceWentOffline` was true, clears it and triggers immediate reconnect (cancels any pending backoff timer). |
| `visibilitychange` (hidden) | Sets `pageHidden = true`. Reconnection is skipped while hidden. |
| `visibilitychange` (visible) | Sets `pageHidden = false`. If disconnected/reconnecting, cancels pending timer and triggers immediate reconnect. |

### 21. Send Buffer

Messages sent while disconnected can be queued for delivery on reconnect.

```typescript
send(type: string, payload: Record<string, unknown>, options?: { buffer?: boolean }): void
emit<TData>(message: ClientMessageDefinition<TData>, data: TData, options?: { buffer?: boolean }): void
sendRaw(data: string, options?: { buffer?: boolean }): void
```

| Method | Default buffer |
|--------|---------------|
| `send()` | `true` |
| `emit()` | `true` |
| `sendRaw()` | `false` |

When `buffer: true` and not connected, the message is pushed to `sendBuffer` as a closure. On reconnect (`onopen`), `flushSendBuffer()` copies and clears the buffer, then executes each closure. Failures during flush are caught per-message (one failure does not block others).

On intentional `disconnect()`, the buffer is cleared (`sendBuffer.length = 0`).

### 22. Room Management

```typescript
joinRoom(room: string): void   // tracks room + sends JoinRoom message if connected
leaveRoom(room: string): void  // removes room + sends LeaveRoom message if connected
clearRooms(): void             // clears local tracking only (no server messages)
```

Rooms are tracked in a `Set<string>`. On reconnect, `rejoinRooms()` iterates the set and emits `JoinRoom` for each room. Errors during rejoin are caught per-room.

`joinRoom()` is safe to call before connection -- the join message will be sent on connect.

### 23. Message Handling

#### on()

```typescript
on<TData>(message: ClientMessageDefinition<TData>, handler: MessageHandler<TData>): () => void
```

Returns an unsubscribe function. Handlers are stored in `Map<string, Set<MessageHandler>>`.

```typescript
type MessageHandler<TData> = (data: TData, envelope: MessageEnvelope<TData>) => void;

interface MessageEnvelope<TData = unknown> {
    name: string;
    data: TData;
    timestamp: number;
}
```

#### handleMessage()

1. Check for pong frame (`'3'`). If matched, call `handlePong()` and return.
2. Parse JSON using `Json.parse()` (prototype pollution protection).
3. Emit to registered handlers for `envelope.name`.
4. Malformed messages are silently ignored (catch with empty handler).

Handler errors are caught per-handler -- one failing handler does not break others.

### 24. ClientMessage.define() -- Type-Safe Message Definitions

**Source**: `packages/websocket-client/src/control-messages.ts`

```typescript
const ClientMessage = {
    define<TData>(name: string): ClientMessageDefinition<TData>
};

interface ClientMessageDefinition<TData> {
    readonly name: string;
    readonly _data: TData;  // type carrier (undefined at runtime)
}
```

Client-side definitions are validation-agnostic. No schema is included because the server validates all data before sending. The `_data` field exists only for TypeScript type inference.

### 25. Built-in Client Messages

| Message | Name | Data Type |
|---------|------|-----------|
| `Connected` | `__connected__` | `{ reconnected?: boolean }` |
| `Disconnected` | `__disconnected__` | `Record<string, never>` |
| `ReconnectAttempt` | `reconnect_attempt` | `{ attempt: number }` |
| `ReconnectFailed` | `reconnect_failed` | `{ attempts: number }` |
| `JoinRoom` | `room.join` | `{ room: string }` |
| `LeaveRoom` | `room.leave` | `{ room: string }` |
| `Heartbeat` | `heartbeat` | `Record<string, never>` |
| `Authenticate` | `auth.authenticate` | `Record<string, unknown>` |

`Connected`, `Disconnected`, `ReconnectAttempt`, and `ReconnectFailed` are internal lifecycle events emitted by the client itself (not received from the server). They use the same `emitToHandlers()` path as server messages.

`Authenticate` uses a generic `Record<string, unknown>` data type because OriJS is auth-agnostic -- applications define their own credential structure.

### 26. Connection State Observation

```typescript
onStateChange(handler: ConnectionStateHandler): () => void
onError(handler: ErrorHandler): () => void
```

```typescript
type ConnectionStateHandler = (state: ConnectionState) => void;
type ErrorHandler = (error: Error) => void;
```

Both return unsubscribe functions. State changes are emitted via `setState()` which deduplicates (no emit if state unchanged). Error handlers receive `Error` objects for connection errors, timeouts, and heartbeat failures.

### 27. Connection Timeout

Default: 5000ms. Set to 0 to disable (not recommended).

On timeout during `'connecting'` state:
1. Notifies error handlers with `Error('Connection timeout after Xms')`
2. Calls `ws.close()` (triggers `onclose` -> reconnect flow)
3. Timer is cleared in `onopen` or `onclose` (whichever fires first)
