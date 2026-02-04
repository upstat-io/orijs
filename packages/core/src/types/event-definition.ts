/**
 * Event definition types for type-safe event registration.
 *
 * This module provides the EventDefinition interface and Event.define() factory
 * for creating type-safe event definitions with TypeBox schemas.
 *
 * ## Consistent API with Workflows
 *
 * Events use the same terminology as workflows for consistency:
 * - `data` (not `payload`) for input schema
 * - `result` (not `response`) for output schema
 * - `_data` and `_result` type carriers
 *
 * ## Type Carrier Pattern
 *
 * This module uses the "type carrier" pattern to enable compile-time type extraction
 * from TypeBox schemas. The pattern solves a fundamental TypeScript challenge:
 *
 * **Problem**: TypeBox schemas like `Type.Object({ userId: Type.String() })` have
 * complex generic types that are difficult to extract. The `Static<T>` utility
 * gives you the runtime type, but you need a way to "carry" this type through
 * the definition object.
 *
 * **Solution**: We add `_data` and `_result` fields that are:
 * - `undefined` at runtime (zero memory/performance cost)
 * - Typed as `TData` / `TResult` at compile time
 * - Extractable via `typeof MyEvent['_data']` or utility types
 *
 * **Why `as unknown as`**: TypeScript won't allow assigning `undefined` to a
 * generic type `T` directly. The double assertion (`undefined as unknown as T`)
 * tells TypeScript "trust me, this value has type T for type-checking purposes."
 * This is safe because the value is NEVER accessed at runtime.
 *
 * ## Usage
 *
 * ```typescript
 * import { Type } from '@orijs/validation';
 * import { Event, type Data, type Result, type EventConsumer } from '@orijs/core';
 *
 * // Define the event
 * const UserCreated = Event.define({
 *   name: 'user.created',
 *   data: Type.Object({ userId: Type.String(), email: Type.String() }),
 *   result: Type.Object({ welcomeEmailSent: Type.Boolean() })
 * });
 *
 * // Extract types using utility types (RECOMMENDED)
 * type UserData = Data<typeof UserCreated>;     // { userId: string; email: string }
 * type UserResult = Result<typeof UserCreated>; // { welcomeEmailSent: boolean }
 *
 * // Or extract directly via typeof (works but utility types are cleaner)
 * type DataDirect = typeof UserCreated['_data'];
 *
 * // Implement a type-safe consumer
 * class MyConsumer implements EventEventConsumer<typeof UserCreated> {
 *   onEvent = async (ctx) => {
 *     // ctx.data is typed as { userId: string; email: string }
 *     console.log(ctx.data.userId);
 *     return { welcomeEmailSent: true }; // Must match result type
 *   };
 * }
 * ```
 *
 * @see {@link Data} - Utility type to extract data type
 * @see {@link Result} - Utility type to extract result type
 * @see {@link EventConsumer} - Utility type for implementing consumers
 */

import type { TSchema, Static } from '@orijs/validation';
import type { Logger } from '@orijs/logging';

/**
 * Configuration for defining an event.
 *
 * @template TData - TypeBox schema for the input data
 * @template TResult - TypeBox schema for the result
 */
export interface EventConfig<TData extends TSchema, TResult extends TSchema> {
	/** Unique event name. Use dot notation: 'entity.action' (e.g., 'user.created') */
	readonly name: string;
	/** TypeBox schema for the event input data */
	readonly data: TData;
	/** TypeBox schema for the event result. Use Type.Void() for fire-and-forget events */
	readonly result: TResult;
}

/**
 * Event definition with type carriers for compile-time type extraction.
 *
 * The `_data` and `_result` fields are type carriers - they are `undefined`
 * at runtime but enable TypeScript's `typeof` operator to extract the generic types.
 *
 * @template TData - The input data type (extracted from TypeBox schema)
 * @template TResult - The result type (extracted from TypeBox schema)
 *
 * @example
 * ```typescript
 * const MyEvent = Event.define({...});
 * type DataType = typeof MyEvent['_data']; // Extracts data type
 * type ResultType = typeof MyEvent['_result']; // Extracts result type
 * ```
 */
export interface EventDefinition<TData, TResult> {
	/** Unique event name */
	readonly name: string;
	/** TypeBox schema for runtime validation of input data */
	readonly dataSchema: TSchema;
	/** TypeBox schema for runtime validation of results */
	readonly resultSchema: TSchema;
	/**
	 * Type carrier for data type extraction.
	 *
	 * **IMPORTANT**: This field is ALWAYS `undefined` at runtime.
	 * It exists solely for TypeScript's type system to extract the data type.
	 *
	 * **DO NOT** access this field in runtime code - use the utility types instead:
	 * ```typescript
	 * type MyData = Data<typeof MyEvent>; // Correct
	 * const data = MyEvent._data; // WRONG - always undefined!
	 * ```
	 */
	readonly _data: TData;
	/**
	 * Type carrier for result type extraction.
	 *
	 * **IMPORTANT**: This field is ALWAYS `undefined` at runtime.
	 * It exists solely for TypeScript's type system to extract the result type.
	 *
	 * **DO NOT** access this field in runtime code - use the utility types instead:
	 * ```typescript
	 * type MyResult = Result<typeof MyEvent>; // Correct
	 * const result = MyEvent._result; // WRONG - always undefined!
	 * ```
	 */
	readonly _result: TResult;
}

/**
 * Event context passed to event consumers and handlers.
 *
 * This interface represents the execution context available when processing
 * an event. It provides access to the event payload, metadata, and utilities.
 *
 * NOTE: Property names match the runtime EventContext from @orijs/events:
 * - `data` (not `payload`) for the event payload
 * - `log` (not `logger`) for the structured logger
 *
 * @template TPayload - The event payload type
 *
 * @example
 * ```typescript
 * class UserCreatedConsumer implements EventConsumer<typeof UserCreated> {
 *   onEvent = async (ctx: EventContext<{ userId: string }>) => {
 *     console.log(`Processing event ${ctx.eventId} for user ${ctx.data.userId}`);
 *     return { processed: true };
 *   };
 * }
 * ```
 */
export interface EventContext<TPayload> {
	/** Unique event instance ID (for tracing and idempotency) */
	readonly eventId: string;
	/** The event payload data */
	readonly data: TPayload;
	/** Logger instance for structured logging with propagated context */
	readonly log: Logger;
	/** Event name (matches the EventDefinition.name) */
	readonly eventName: string;
	/** Timestamp when the event was emitted (milliseconds since epoch) */
	readonly timestamp: number;
	/** Unique ID for request-response correlation */
	readonly correlationId: string;
	/** ID of parent event (for event chain tracking) */
	readonly causationId?: string;
	/**
	 * Emit function for chained events.
	 * Allows handlers to emit additional events with proper context propagation.
	 */
	readonly emit: <TReturn = void>(
		eventName: string,
		payload: unknown,
		options?: { delay?: number }
	) => { wait: () => Promise<TReturn> };
}

/**
 * Factory for creating type-safe event definitions.
 *
 * @example
 * ```typescript
 * import { Type } from '@orijs/validation';
 *
 * const UserCreated = Event.define({
 *   name: 'user.created',
 *   data: Type.Object({
 *     userId: Type.String(),
 *     email: Type.String()
 *   }),
 *   result: Type.Object({
 *     welcomeEmailSent: Type.Boolean()
 *   })
 * });
 *
 * // Registration: app.event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
 * // Emit: ctx.events.emit(UserCreated, { userId: '123', email: 'test@example.com' })
 * ```
 */
export const Event = {
	/**
	 * Define a new event with TypeBox schemas for data and result.
	 *
	 * ## Why Static<T>?
	 *
	 * TypeBox schemas are runtime objects (e.g., `Type.Object({ id: Type.String() })`).
	 * TypeScript cannot infer the corresponding type from a runtime value alone.
	 * `Static<TSchema>` is TypeBox's utility type that extracts the TypeScript type
	 * that a schema validates. This enables compile-time type safety from runtime schemas.
	 *
	 * @param config - Event configuration with name, data schema, and result schema
	 * @returns EventDefinition with type carriers for compile-time type extraction
	 */
	define<TData extends TSchema, TResult extends TSchema>(
		config: EventConfig<TData, TResult>
	): EventDefinition<Static<TData>, Static<TResult>> {
		return Object.freeze({
			name: config.name,
			dataSchema: config.data,
			resultSchema: config.result,
			_data: undefined as unknown as Static<TData>,
			_result: undefined as unknown as Static<TResult>
		});
	}
};
