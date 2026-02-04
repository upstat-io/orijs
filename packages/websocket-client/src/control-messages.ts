/**
 * Client-Side Control Message Definitions
 *
 * These definitions are validation-agnostic - they only provide type inference.
 * The server validates all messages; clients trust the server.
 *
 * @example
 * ```typescript
 * import { SocketClient, JoinRoom, LeaveRoom } from '@orijs/websocket-client';
 *
 * const client = new SocketClient('wss://api.example.com/ws');
 *
 * // Type-safe message emission
 * client.emit(JoinRoom, { room: 'account:123' });
 * client.emit(LeaveRoom, { room: 'account:123' });
 * ```
 */

import type { ClientMessageDefinition } from './types';

/**
 * Factory for creating client message definitions (validation-agnostic).
 *
 * @example
 * ```typescript
 * const CustomMessage = ClientMessage.define<{ id: string; value: number }>('custom.event');
 *
 * client.emit(CustomMessage, { id: '123', value: 42 });
 * ```
 */
export const ClientMessage = {
	/**
	 * Define a client-side socket message for type-safe emission.
	 *
	 * @template TData - The message data type
	 * @param name - Message name (must match server definition)
	 * @returns Message definition for use with emit()
	 */
	define<TData>(name: string): ClientMessageDefinition<TData> {
		return Object.freeze({
			name,
			_data: undefined as unknown as TData
		});
	}
};

// =============================================================================
// Built-in Control Messages
// =============================================================================

/**
 * Join a room/topic to receive messages published to it.
 *
 * @example
 * ```typescript
 * client.emit(JoinRoom, { room: 'account:123' });
 * ```
 */
export const JoinRoom: ClientMessageDefinition<{ room: string }> = ClientMessage.define('room.join');

/**
 * Leave a room/topic to stop receiving messages from it.
 *
 * @example
 * ```typescript
 * client.emit(LeaveRoom, { room: 'account:123' });
 * ```
 */
export const LeaveRoom: ClientMessageDefinition<{ room: string }> = ClientMessage.define('room.leave');

/**
 * JSON-based heartbeat for keep-alive.
 *
 * Note: For minimal bandwidth, prefer the built-in ping/pong protocol
 * which uses single character frames ('2' for ping, '3' for pong).
 * The SocketClient handles this automatically via heartbeatInterval.
 *
 * @example
 * ```typescript
 * // Manual heartbeat (not typically needed)
 * client.emit(Heartbeat, {});
 * ```
 */
export const Heartbeat: ClientMessageDefinition<Record<string, never>> = ClientMessage.define('heartbeat');

/**
 * Authenticate the WebSocket connection.
 *
 * Should be sent immediately after connection is established.
 * The server validates the credentials and associates the socket with the user.
 *
 * The credentials structure is application-defined - OriJS is auth-agnostic.
 * Applications can pass JWT tokens, API keys, or any auth data their server expects.
 *
 * @example
 * ```typescript
 * // JWT-based auth
 * client.emit(Authenticate, { token: jwtToken });
 *
 * // Multi-token auth (e.g., user + app verification)
 * client.emit(Authenticate, {
 *   token: userToken,
 *   appToken: appCheckToken
 * });
 *
 * // API key auth
 * client.emit(Authenticate, { apiKey: 'sk_live_...' });
 * ```
 */
export const Authenticate: ClientMessageDefinition<AuthenticateData> =
	ClientMessage.define('auth.authenticate');

// =============================================================================
// Type Exports
// =============================================================================

/** Data type for JoinRoom message */
export type JoinRoomData = { room: string };

/** Data type for LeaveRoom message */
export type LeaveRoomData = { room: string };

/** Data type for Heartbeat message */
export type HeartbeatData = Record<string, never>;

/**
 * Data type for Authenticate message.
 * Generic record - applications define their own auth credential structure.
 */
export type AuthenticateData = Record<string, unknown>;
