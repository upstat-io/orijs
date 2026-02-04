# @orijs/websocket-redis

Redis WebSocket provider for OriJS horizontal scaling across multiple server instances.

## Installation

```bash
bun add @orijs/websocket-redis ioredis
```

## Quick Start

```typescript
import { Application } from '@orijs/core';
import { SocketCoordinator } from '@orijs/websocket';
import { RedisWsProvider } from '@orijs/websocket-redis';

// Create Redis-backed provider
const provider = new RedisWsProvider({
	connection: { host: 'localhost', port: 6379 },
	keyPrefix: 'myapp:ws'
});

// Use with SocketCoordinator
const coordinator = new SocketCoordinator({ provider });

// In Bun server setup
const server = Bun.serve({
	port: 3000,
	fetch(req, server) {
		if (req.headers.get('upgrade') === 'websocket') {
			const socketId = crypto.randomUUID();
			server.upgrade(req, {
				data: { socketId, data: {}, topics: new Set() }
			});
			return;
		}
		return new Response('Hello');
	},
	websocket: {
		open(ws) {
			coordinator.addConnection(ws);
		},
		message(ws, message) {
			// Handle messages
		},
		close(ws) {
			coordinator.removeConnection(ws.data.socketId);
		}
	}
});

// Initialize provider with server
provider.setServer(server);
await provider.start();
```

## How It Works

RedisWsProvider bridges Redis pub/sub to Bun's native WebSocket server:

1. **Messages published on any instance** are sent to Redis
2. **Redis broadcasts to all subscribed instances**
3. **Each instance delivers to local WebSocket clients**

This enables horizontal scaling - run multiple server instances behind a load balancer, and messages reach all connected clients regardless of which instance they're connected to.

### Dual Connection Pattern

The provider uses two Redis connections:

- **Publisher**: for PUBLISH commands
- **Subscriber**: for SUBSCRIBE/UNSUBSCRIBE and receiving messages

This separation is required because Redis connections in subscriber mode cannot issue PUBLISH commands.

## Configuration

### RedisWsProviderOptions

| Option           | Type                             | Default  | Description                        |
| ---------------- | -------------------------------- | -------- | ---------------------------------- |
| `connection`     | `{ host: string, port: number }` | Required | Redis server connection            |
| `keyPrefix`      | `string`                         | `'ws'`   | Prefix for Redis channel names     |
| `connectTimeout` | `number`                         | `2000`   | Connection timeout in milliseconds |
| `logger`         | `Logger`                         | Console  | Logger instance                    |

### Redis Configuration

The provider is configured for reliability:

- `maxRetriesPerRequest: 1` - Fast failure, no blocking retries
- `enableOfflineQueue: false` - Reject commands when disconnected
- `lazyConnect: true` - Connect only when needed
- Automatic reconnection with exponential backoff

## API Overview

### RedisWsProvider

```typescript
const provider = new RedisWsProvider({
	connection: { host: 'localhost', port: 6379 }
});

// Lifecycle
await provider.start(); // Connect to Redis
await provider.stop(); // Disconnect and cleanup

// Server binding
provider.setServer(server);

// Publishing (cross-instance via Redis)
provider.publish('room:123', 'Hello!');
provider.broadcast('Message to all');
provider.send(socketId, 'Direct message');

// Subscriptions
provider.subscribe(socketId, 'room:123');
provider.unsubscribe(socketId, 'room:123');
provider.unsubscribeAll(socketId);

// Tracking
provider.trackConnection(socketId);
provider.untrackConnection(socketId);

// Metrics (local instance only)
provider.isConnected(socketId);
provider.getConnectionCount();
provider.getTopicSubscriberCount('room:123');

// Diagnostics
provider.getKeyPrefix();
provider.getConnectTimeout();
```

## Security

### Socket ID Validation

Socket IDs must be UUID v4 format (via `crypto.randomUUID()`). This prevents:

- Socket enumeration attacks
- Message injection to arbitrary sockets

### Topic Validation

Topics are validated for:

- Non-empty strings
- Maximum 256 characters
- Allowed characters: `a-z`, `A-Z`, `0-9`, `_`, `:`, `.`, `-`

### Prototype Pollution Protection

All JSON parsed from Redis is sanitized to strip dangerous keys (`__proto__`, `constructor`, `prototype`).

## Error Handling

### Retry Behavior

Subscribe operations use exponential backoff with jitter:

- Max 3 retries
- Base delay: 100ms
- Formula: `delay * 2^attempt + random(0, delay)`

### Graceful Degradation

If Redis is unavailable:

- `start()` will reject with connection error
- Local operations (connection tracking) still work
- Publish operations fail silently with error logging

## Testing

For testing, consider using `InProcWsProvider` from `@orijs/websocket` instead. It provides the same interface without Redis dependency.

```typescript
import { InProcWsProvider } from '@orijs/websocket';

// Use in tests
const provider = new InProcWsProvider();
```

For integration tests requiring Redis, use testcontainers:

```typescript
import { GenericContainer } from 'testcontainers';

const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

const provider = new RedisWsProvider({
	connection: {
		host: redis.getHost(),
		port: redis.getMappedPort(6379)
	}
});
```

## Comparison with InProcWsProvider

| Feature             | InProcWsProvider             | RedisWsProvider            |
| ------------------- | ---------------------------- | -------------------------- |
| Horizontal scaling  | No                           | Yes                        |
| External dependency | None                         | Redis                      |
| Setup complexity    | Minimal                      | Moderate                   |
| Use case            | Single instance, development | Production, multi-instance |
