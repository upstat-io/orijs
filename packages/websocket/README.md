# @orijs/websocket

WebSocket support for OriJS applications with pub/sub messaging.

## Installation

```bash
bun add @orijs/websocket
```

## Quick Start

```typescript
import { Application } from '@orijs/core';
import { InProcWsProvider, SocketCoordinator } from '@orijs/websocket';

// Create provider and coordinator
const provider = new InProcWsProvider();
const coordinator = new SocketCoordinator({ provider });

// In your Bun server setup
const server = Bun.serve({
	port: 3000,
	fetch(req, server) {
		// Upgrade WebSocket connections
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

// Set server reference for publishing
provider.setServer(server);
await provider.start();
```

## Providers

| Provider           | Use Case                    | Horizontal Scaling |
| ------------------ | --------------------------- | ------------------ |
| `InProcWsProvider` | Single-instance deployments | No                 |
| `RedisWsProvider`  | Multi-instance deployments  | Yes                |

## API Overview

### SocketCoordinator

Manages WebSocket connections and topic subscriptions for a single server instance.

```typescript
const coordinator = new SocketCoordinator({ provider });

// Connection management
coordinator.addConnection(ws);
coordinator.removeConnection(socketId);
coordinator.getConnection<UserData>(socketId);
coordinator.getConnectionCount();

// Topic subscriptions
coordinator.subscribeToTopic(socketId, 'chat:room-123');
coordinator.unsubscribeFromTopic(socketId, 'chat:room-123');
coordinator.getTopicSubscribers('chat:room-123');
```

### InProcWsProvider

In-process provider using Bun's native pub/sub.

```typescript
const provider = new InProcWsProvider({ logger });

// Lifecycle
await provider.start();
await provider.stop();

// Publishing (uses Bun's server.publish internally)
provider.publish('topic', 'message');
provider.broadcast('message to all');

// Metrics
provider.isConnected(socketId);
provider.getConnectionCount();
provider.getTopicSubscriberCount('topic');
```

### Interfaces

- **SocketEmitter** - Consumer-facing interface for services (`publish`, `send`, `broadcast`)
- **SocketLifecycle** - Framework-facing interface (`start`, `stop`)
- **WebSocketProvider** - Full implementation interface

## Configuration

### InProcWsProviderOptions

| Option   | Type     | Description                                    |
| -------- | -------- | ---------------------------------------------- |
| `logger` | `Logger` | Optional logger instance (defaults to console) |

### SocketCoordinatorOptions

| Option     | Type                | Description                |
| ---------- | ------------------- | -------------------------- |
| `provider` | `WebSocketProvider` | Required provider instance |
| `logger`   | `Logger`            | Optional logger instance   |

## Security

Socket IDs must be cryptographically random (UUID v4 via `crypto.randomUUID()`) to prevent socket enumeration and message injection attacks.

## Related Packages

- **@orijs/websocket-redis** - Redis provider for horizontal scaling
- **@orijs/core** - Application class with WebSocket integration
- **@orijs/orijs** - Meta package re-exporting all WebSocket types
