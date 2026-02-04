/**
 * Message Registry for Opinionated WebSocket Message Handling
 *
 * Provides server-side message handler registration with schema validation.
 * Only registered message types are accepted - all others are rejected.
 *
 * @example
 * ```typescript
 * import { MessageRegistry, JoinRoom, LeaveRoom } from '@orijs/websocket';
 *
 * const registry = new MessageRegistry()
 *   .on(JoinRoom, async (ws, data) => {
 *     ws.subscribe(data.room);
 *   })
 *   .on(LeaveRoom, async (ws, data) => {
 *     ws.unsubscribe(data.room);
 *   });
 *
 * // In message handler:
 * const result = await registry.handle(ws, type, data);
 * if (!result.handled) {
 *   ws.send(JSON.stringify({ type: 'error', message: result.reason }));
 * }
 * ```
 */

import type { ServerWebSocket } from 'bun';
import { Logger } from '@orijs/logging';
import { validate } from '@orijs/validation';
import type { Schema } from '@orijs/validation';
import type { SocketData } from './types';

/**
 * Server-side message definition with schema for validation.
 *
 * @template TData - The message data type
 */
export interface ServerMessageDefinition<TData> {
	/** Unique message name (e.g., 'room.join', 'heartbeat') */
	readonly name: string;
	/** Schema for runtime validation (TypeBox, Standard Schema, or custom validator) */
	readonly dataSchema: Schema<TData>;
	/** Type carrier (undefined at runtime, used for type inference) */
	readonly _data: TData;
}

/**
 * Handler function for a validated message.
 *
 * @template TData - The message data type
 * @template TSocketData - Custom socket data type
 */
export type MessageHandler<TData, TSocketData = unknown> = (
	ws: ServerWebSocket<SocketData<TSocketData>>,
	data: TData
) => void | Promise<void>;

/**
 * Result of handling a message.
 */
export type HandleResult =
	| { handled: true }
	| { handled: false; reason: 'unknown_type' | 'validation_failed'; details?: string };

/**
 * Registry entry for a message handler.
 */
interface RegistryEntry<TSocketData = unknown> {
	readonly schema: Schema<unknown>;
	readonly handler: MessageHandler<unknown, TSocketData>;
}

/**
 * Registry for validated message handlers.
 *
 * Only registered messages are accepted - all others are rejected.
 * This enforces opinionated message formats across the application.
 *
 * @template TSocketData - Custom socket data type attached to connections
 *
 * @example
 * ```typescript
 * const registry = new MessageRegistry<{ userId: string }>()
 *   .on(JoinRoom, async (ws, data) => {
 *     // ws.data.data.userId is typed
 *     ws.subscribe(data.room);
 *   });
 * ```
 */
export class MessageRegistry<TSocketData = unknown> {
	private readonly handlers = new Map<string, RegistryEntry<TSocketData>>();
	private readonly logger: Logger;

	constructor(options?: { logger?: Logger }) {
		this.logger = options?.logger ?? Logger.console('MessageRegistry');
	}

	/**
	 * Register a message handler with schema validation.
	 *
	 * @template TData - The message data type (inferred from definition)
	 * @param message - The message definition with name and schema
	 * @param handler - Handler function called with validated data
	 * @returns this for chaining
	 *
	 * @example
	 * ```typescript
	 * registry.on(JoinRoom, async (ws, data) => {
	 *   // data.room is typed and validated
	 *   ws.subscribe(data.room);
	 * });
	 * ```
	 */
	on<TData>(message: ServerMessageDefinition<TData>, handler: MessageHandler<TData, TSocketData>): this {
		if (this.handlers.has(message.name)) {
			this.logger.warn('Overwriting existing handler', { messageName: message.name });
		}

		this.handlers.set(message.name, {
			schema: message.dataSchema as Schema<unknown>,
			handler: handler as MessageHandler<unknown, TSocketData>
		});

		return this;
	}

	/**
	 * Check if a message type has a registered handler.
	 *
	 * @param type - The message type name
	 * @returns true if handler exists
	 */
	has(type: string): boolean {
		return this.handlers.has(type);
	}

	/**
	 * Get all registered message type names.
	 *
	 * @returns Array of registered message type names
	 */
	getRegisteredTypes(): string[] {
		return Array.from(this.handlers.keys());
	}

	/**
	 * Handle an incoming message.
	 *
	 * Validates the message against its schema and calls the registered handler.
	 * Returns a result indicating success or failure reason.
	 *
	 * @param ws - The WebSocket connection
	 * @param type - The message type from the parsed message
	 * @param data - The message data (will be validated)
	 * @returns Result indicating if message was handled
	 *
	 * @example
	 * ```typescript
	 * const { type, ...data } = JSON.parse(msg);
	 * const result = await registry.handle(ws, type, data);
	 *
	 * if (!result.handled) {
	 *   ws.send(JSON.stringify({
	 *     type: 'error',
	 *     message: `Invalid message: ${result.reason}`
	 *   }));
	 * }
	 * ```
	 */
	async handle(
		ws: ServerWebSocket<SocketData<TSocketData>>,
		type: string,
		data: unknown
	): Promise<HandleResult> {
		const entry = this.handlers.get(type);

		if (!entry) {
			return { handled: false, reason: 'unknown_type' };
		}

		// Validate data against schema
		const result = await validate(entry.schema, data);

		if (!result.success) {
			const details = result.errors.map((e) => `${e.path}: ${e.message}`).join(', ');
			this.logger.warn('Message validation failed', { type, errors: details });
			return { handled: false, reason: 'validation_failed', details };
		}

		// Call handler with validated data
		try {
			await entry.handler(ws, result.data);
			return { handled: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			this.logger.error('Message handler threw error', { type, error: message });
			// Re-throw to let caller decide how to handle
			throw error;
		}
	}
}

/**
 * Factory function to create a MessageRegistry.
 *
 * @template TSocketData - Custom socket data type
 * @param options - Registry options
 * @returns New MessageRegistry instance
 */
export function createMessageRegistry<TSocketData = unknown>(options?: {
	logger?: Logger;
}): MessageRegistry<TSocketData> {
	return new MessageRegistry<TSocketData>(options);
}
