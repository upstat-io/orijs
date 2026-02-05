# @orijs/websocket-client

Browser WebSocket client for OriJS with type-safe message handlers and automatic reconnection.

## Installation

```bash
bun add @orijs/websocket-client
```

## Quick Start

```typescript
import { SocketClient, Connected, ClientMessage } from '@orijs/websocket-client';

// Define message types
const OrderCreated = ClientMessage.define<{ orderId: string; total: number }>('order.created');
const OrderUpdated = ClientMessage.define<{ orderId: string; status: string }>('order.updated');

// Create client
const client = new SocketClient('wss://api.example.com/ws');

// Type-safe handlers - data type is inferred
client.on(OrderCreated, (data) => {
  console.log('New order:', data.orderId, data.total);
});

client.on(OrderUpdated, (data) => {
  console.log('Order updated:', data.orderId, data.status);
});

// Connection lifecycle
client.on(Connected, () => {
  console.log('Connected to server');
  client.joinRoom('orders:account-123');
});

// Connect
client.connect();
```

## Features

- **Type-Safe Messages** - Define message types with TypeScript inference
- **Auto Reconnection** - Exponential backoff reconnection
- **Room Support** - Join/leave room subscriptions
- **Connection State** - Track connection status changes
- **Browser Compatible** - Works in any browser environment

## Connection State

```typescript
import { SocketClient, Connected, Disconnected, ReconnectAttempt } from '@orijs/websocket-client';

client.on(Connected, () => console.log('Connected'));
client.on(Disconnected, () => console.log('Disconnected'));
client.on(ReconnectAttempt, (data) => console.log('Reconnecting...', data.attempt));

// Or use state change handler
client.onStateChange((state) => {
  console.log('State:', state); // 'connecting' | 'connected' | 'disconnected' | 'reconnecting'
});
```

## Room Subscriptions

```typescript
import { JoinRoom, LeaveRoom } from '@orijs/websocket-client';

// Using convenience methods
client.joinRoom('orders:account-123');
client.leaveRoom('orders:account-123');

// Or using typed emit
client.emit(JoinRoom, { room: 'orders:account-123' });
client.emit(LeaveRoom, { room: 'orders:account-123' });
```

## Authentication

```typescript
import { Authenticate } from '@orijs/websocket-client';

client.on(Connected, () => {
  client.emit(Authenticate, { token: 'jwt-token-here' });
});
```

## Client Options

```typescript
const client = new SocketClient('wss://api.example.com/ws', {
  reconnect: true,           // Enable auto-reconnect (default: true)
  reconnectDelay: 1000,      // Initial delay ms (default: 1000)
  reconnectDelayMax: 30000,  // Max delay ms (default: 30000)
  reconnectAttempts: 10      // Max attempts (default: Infinity)
});
```

## Documentation

See the [WebSocket Guide](../../docs/guides/websockets.md) for more details.

## License

MIT
