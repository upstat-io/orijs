/**
 * Socket message definition types for type-safe WebSocket message emission.
 *
 * This module provides the SocketMessageDefinition interface and SocketMessage.define()
 * factory for creating type-safe message definitions with TypeBox schemas.
 *
 * ## Consistent API with Events and Workflows
 *
 * Socket messages use the same terminology as events for consistency:
 * - `data` for the message payload schema
 * - `_data` type carrier for compile-time type extraction
 *
 * ## Type Carrier Pattern
 *
 * This module uses the "type carrier" pattern to enable compile-time type extraction
 * from TypeBox schemas. The pattern is documented in detail in event-definition.ts.
 *
 * ## Usage
 *
 * ```typescript
 * import { Type } from '@orijs/validation';
 * import { SocketMessage, type MessageData } from '@orijs/core';
 *
 * // Define the socket message
 * const IncidentCreated = SocketMessage.define({
 *   name: 'incident.created',
 *   data: Type.Object({
 *     uuid: Type.String(),
 *     title: Type.String(),
 *     status: Type.String()
 *   })
 * });
 *
 * // Extract types using utility type
 * type IncidentData = MessageData<typeof IncidentCreated>;  // { uuid: string; title: string; status: string }
 *
 * // Emit type-safe message
 * await ctx.socket.emit(IncidentCreated, 'account:123', {
 *   uuid: 'inc-456',
 *   title: 'Server Down',
 *   status: 'investigating'
 * });
 * ```
 *
 * @see {@link MessageData} - Utility type to extract data type
 */

import type { TSchema, Static, Schema } from '@orijs/validation';

/**
 * Configuration for defining a socket message.
 *
 * @template TData - TypeBox schema for the message data
 */
export interface SocketMessageConfig<TData extends TSchema> {
	/** Unique message name. Use dot notation: 'entity.action' (e.g., 'incident.created') */
	readonly name: string;
	/** TypeBox schema for the message data */
	readonly data: TData;
}

/**
 * Socket message definition with type carrier for compile-time type extraction.
 *
 * The `_data` field is a type carrier - it is `undefined` at runtime but enables
 * TypeScript's `typeof` operator to extract the generic type.
 *
 * @template TData - The message data type (extracted from TypeBox schema)
 *
 * @example
 * ```typescript
 * const MyMessage = SocketMessage.define({...});
 * type DataType = typeof MyMessage['_data']; // Extracts data type
 * ```
 */
export interface SocketMessageDefinition<TData> {
	/** Unique message name */
	readonly name: string;
	/** Schema for runtime validation (TypeBox, Standard Schema, or custom validator) */
	readonly dataSchema: Schema<TData>;
	/**
	 * Type carrier for data type extraction.
	 *
	 * **IMPORTANT**: This field is ALWAYS `undefined` at runtime.
	 * It exists solely for TypeScript's type system to extract the data type.
	 *
	 * **DO NOT** access this field in runtime code - use the utility type instead:
	 * ```typescript
	 * type MyData = MessageData<typeof MyMessage>; // Correct
	 * const data = MyMessage._data; // WRONG - always undefined!
	 * ```
	 */
	readonly _data: TData;
}

/**
 * Factory for creating type-safe socket message definitions.
 *
 * @example
 * ```typescript
 * import { Type } from '@orijs/validation';
 *
 * const IncidentCreated = SocketMessage.define({
 *   name: 'incident.created',
 *   data: Type.Object({
 *     uuid: Type.String(),
 *     title: Type.String(),
 *     status: Type.String(),
 *     severity: Type.String(),
 *     createdAt: Type.String()
 *   })
 * });
 *
 * // Emit: ctx.socket.emit(IncidentCreated, 'account:uuid', { uuid: '...', ... })
 * ```
 */
export const SocketMessage = {
	/**
	 * Define a new socket message with TypeBox schema for data.
	 *
	 * ## Why Static<T>?
	 *
	 * TypeBox schemas are runtime objects (e.g., `Type.Object({ id: Type.String() })`).
	 * TypeScript cannot infer the corresponding type from a runtime value alone.
	 * `Static<TSchema>` is TypeBox's utility type that extracts the TypeScript type
	 * that a schema validates. This enables compile-time type safety from runtime schemas.
	 *
	 * @param config - Message configuration with name and data schema
	 * @returns SocketMessageDefinition with type carrier for compile-time type extraction
	 */
	define<TData extends TSchema>(config: SocketMessageConfig<TData>): SocketMessageDefinition<Static<TData>> {
		return Object.freeze({
			name: config.name,
			dataSchema: config.data,
			_data: undefined as unknown as Static<TData>
		});
	}
};
