/**
 * Pure type extraction utilities for event and workflow definitions.
 *
 * These types have NO dependencies on consumer interfaces, making them
 * suitable for use at any layer of the application.
 *
 * Both EventDefinition and WorkflowDefinition use the same terminology:
 * - `_data` for input type carrier
 * - `_result` for output type carrier
 *
 * This allows `Data<T>` and `Result<T>` to work with both definition types.
 *
 * @example
 * ```typescript
 * import { Event, Workflow, type Data, type Result } from '@orijs/core';
 *
 * const UserCreated = Event.define({...});
 * const SendEmail = Workflow.define({...});
 *
 * // Extract types from either definition type
 * type EventData = Data<typeof UserCreated>;
 * type EventResult = Result<typeof UserCreated>;
 * type WorkflowData = Data<typeof SendEmail>;
 * type WorkflowResult = Result<typeof SendEmail>;
 * ```
 */

/**
 * Definition type that has _data and _result type carriers.
 * Both EventDefinition and WorkflowDefinition satisfy this.
 */
type DefinitionWithDataResult = { readonly _data: unknown; readonly _result: unknown };

/**
 * Extract the data type from an EventDefinition or WorkflowDefinition.
 *
 * @template T - The definition type (use `typeof YourEvent` or `typeof YourWorkflow`)
 * @returns The input data type
 *
 * @example
 * ```typescript
 * const UserCreated = Event.define({
 *   name: 'user.created',
 *   data: Type.Object({ userId: Type.String() }),
 *   result: Type.Void()
 * });
 *
 * const SendEmail = Workflow.define({
 *   name: 'send-email',
 *   data: Type.Object({ to: Type.String() }),
 *   result: Type.Object({ messageId: Type.String() })
 * });
 *
 * type UserData = Data<typeof UserCreated>;   // { userId: string }
 * type EmailData = Data<typeof SendEmail>;    // { to: string }
 * ```
 */
export type Data<T extends DefinitionWithDataResult> = T['_data'];

/**
 * Extract the result type from an EventDefinition or WorkflowDefinition.
 *
 * @template T - The definition type (use `typeof YourEvent` or `typeof YourWorkflow`)
 * @returns The result type
 *
 * @example
 * ```typescript
 * type UserResult = Result<typeof UserCreated>;   // void
 * type EmailResult = Result<typeof SendEmail>;    // { messageId: string }
 * ```
 */
export type Result<T extends DefinitionWithDataResult> = T['_result'];

/**
 * Definition type that has only _data type carrier (no _result).
 * SocketMessageDefinition satisfies this.
 */
type DefinitionWithData = { readonly _data: unknown };

/**
 * Extract the data type from a SocketMessageDefinition.
 *
 * @template T - The definition type (use `typeof YourMessage`)
 * @returns The message data type
 *
 * @example
 * ```typescript
 * const IncidentCreated = SocketMessage.define({
 *   name: 'incident.created',
 *   data: Type.Object({ uuid: Type.String(), title: Type.String() })
 * });
 *
 * type IncidentData = MessageData<typeof IncidentCreated>;  // { uuid: string; title: string }
 * ```
 */
export type MessageData<T extends DefinitionWithData> = T['_data'];
