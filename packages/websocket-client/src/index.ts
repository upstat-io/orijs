/**
 * @orijs/websocket-client - Browser WebSocket client for OriJS
 *
 * Provides a type-safe, browser-compatible WebSocket client for consuming
 * messages from OriJS servers. Features include:
 *
 * - Type-safe message handlers using server-side message definitions
 * - Automatic reconnection with exponential backoff
 * - Room/topic subscription support
 * - Connection state management
 *
 * @example
 * ```typescript
 * import { SocketClient, Connected, JoinRoom, ClientMessage } from '@orijs/websocket-client';
 *
 * // Define message types for your application
 * const OrderCreated = ClientMessage.define<{ orderId: string; total: number }>('order.created');
 * const OrderUpdated = ClientMessage.define<{ orderId: string; status: string }>('order.updated');
 *
 * const client = new SocketClient('wss://api.example.com/ws');
 *
 * // Type-safe handlers - data type is inferred from message definition
 * client.on(OrderCreated, (data) => {
 *   console.log('New order:', data.orderId, data.total);
 * });
 *
 * client.on(OrderUpdated, (data) => {
 *   console.log('Order updated:', data.orderId, data.status);
 * });
 *
 * // Connection lifecycle
 * client.on(Connected, () => {
 *   client.joinRoom(`account:${accountUuid}`);
 *   // Or use typed emit:
 *   client.emit(JoinRoom, { room: `account:${accountUuid}` });
 * });
 *
 * client.onStateChange((state) => {
 *   console.log('Connection state:', state);
 * });
 *
 * client.connect();
 * ```
 *
 * @packageDocumentation
 */

// Main client
export { SocketClient, Connected, Disconnected, ReconnectAttempt, ReconnectFailed } from './client';

// Control Messages (built-in client-side message definitions)
export { ClientMessage, JoinRoom, LeaveRoom, Heartbeat, Authenticate } from './control-messages';
export type { JoinRoomData, LeaveRoomData, HeartbeatData, AuthenticateData } from './control-messages';

// Types
export type {
	ClientMessageDefinition,
	MessageEnvelope,
	MessageHandler,
	ConnectionState,
	SocketClientOptions,
	ConnectionStateHandler,
	ErrorHandler
} from './types';

// Protocol constants (for server implementations)
export { PING_FRAME, PONG_FRAME } from './types';
