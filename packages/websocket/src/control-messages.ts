/**
 * Server-Side Control Message Definitions
 *
 * Built-in control messages for WebSocket room management and keep-alive.
 * These definitions include schema validation for runtime type checking.
 *
 * @example
 * ```typescript
 * import { MessageRegistry, JoinRoom, LeaveRoom, Heartbeat } from '@orijs/websocket';
 *
 * const registry = new MessageRegistry()
 *   .on(JoinRoom, (ws, data) => ws.subscribe(data.room))
 *   .on(LeaveRoom, (ws, data) => ws.unsubscribe(data.room))
 *   .on(Heartbeat, (ws) => ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() })));
 * ```
 */

import { Type } from '@orijs/validation';
import type { TSchema, Static, Schema } from '@orijs/validation';
import type { ServerMessageDefinition } from './message-registry';

/**
 * Factory for creating server message definitions with schema validation.
 *
 * @example
 * ```typescript
 * const CustomMessage = ServerMessage.define({
 *   name: 'custom.event',
 *   data: Type.Object({
 *     id: Type.String(),
 *     value: Type.Number()
 *   })
 * });
 * ```
 */
export const ServerMessage = {
	/**
	 * Define a server-side socket message with TypeBox schema validation.
	 *
	 * Uses TypeBox's Static<> utility for proper type inference.
	 *
	 * @template T - The TypeBox schema type
	 * @param config - Message configuration with name and TypeBox schema
	 * @returns Frozen message definition with inferred data type
	 */
	define<T extends TSchema>(config: { name: string; data: T }): ServerMessageDefinition<Static<T>> {
		return Object.freeze({
			name: config.name,
			dataSchema: config.data as Schema<Static<T>>,
			_data: undefined as unknown as Static<T>
		});
	}
};

// =============================================================================
// Built-in Control Messages
// =============================================================================

/**
 * Join a room/topic to receive messages published to it.
 *
 * Client sends: `{ type: 'room.join', room: 'account:123' }`
 *
 * Room name constraints:
 * - Minimum 1 character
 * - Maximum 255 characters
 */
export const JoinRoom = ServerMessage.define({
	name: 'room.join',
	data: Type.Object({
		room: Type.String({ minLength: 1, maxLength: 255 })
	})
});

/**
 * Leave a room/topic to stop receiving messages from it.
 *
 * Client sends: `{ type: 'room.leave', room: 'account:123' }`
 */
export const LeaveRoom = ServerMessage.define({
	name: 'room.leave',
	data: Type.Object({
		room: Type.String({ minLength: 1, maxLength: 255 })
	})
});

/**
 * JSON-based heartbeat for keep-alive.
 *
 * Client sends: `{ type: 'heartbeat' }`
 * Server responds: `{ type: 'heartbeat', timestamp: 1234567890 }`
 *
 * Note: For minimal bandwidth, prefer the ping/pong protocol:
 * - Client sends: '2' (single character)
 * - Server responds: '3' (single character)
 */
export const Heartbeat = ServerMessage.define({
	name: 'heartbeat',
	data: Type.Object({})
});

// =============================================================================
// Type Exports
// =============================================================================

/** Data type for JoinRoom message */
export type JoinRoomData = typeof JoinRoom._data;

/** Data type for LeaveRoom message */
export type LeaveRoomData = typeof LeaveRoom._data;

/** Data type for Heartbeat message */
export type HeartbeatData = typeof Heartbeat._data;
