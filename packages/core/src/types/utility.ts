/**
 * Utility types for extracting inner types from event and workflow definitions.
 *
 * This module provides two categories of types:
 *
 * 1. **Pure Extractors** (from type-extractors.ts):
 *    - `Data<T>`, `Result<T>` - Extract from EventDefinition or WorkflowDefinition
 *    - These have NO dependencies on consumer interfaces
 *
 * 2. **Consumer Types** (defined here):
 *    - `EventConsumer<T>`, `EventCtx<T>` - Event consumer types
 *    - `WorkflowConsumer<T>`, `WorkflowCtx<T>` - Workflow consumer types
 *    - These depend on consumer interfaces for type mapping
 *
 * @example
 * ```typescript
 * import { Event, type EventConsumer, type Data, type Result } from '@orijs/core';
 *
 * const UserCreated = Event.define({...});
 *
 * // Extract types from definition
 * type DataType = Data<typeof UserCreated>;
 * type ResultType = Result<typeof UserCreated>;
 *
 * // Implement consumer with extracted types
 * class MyConsumer implements EventEventConsumer<typeof UserCreated> {
 *   onEvent = async (ctx): Promise<Result<typeof UserCreated>> => {
 *     const data: Data<typeof UserCreated> = ctx.data;
 *     return { ... };
 *   };
 * }
 * ```
 */

// Import types needed for consumer-related utilities
import type { EventDefinition, EventContext } from './event-definition';
import type { WorkflowDefinition, WorkflowContext } from './workflow-definition';
import type { IEventConsumer, IWorkflowConsumer } from './consumer';

// Re-export pure type extractors (no consumer dependencies)
export type { Data, Result, MessageData } from './type-extractors';

// ============================================================================
// Event Consumer Types
// ============================================================================

/**
 * Get the IEventConsumer interface typed for an EventDefinition.
 *
 * Use this when implementing a consumer class to ensure type safety.
 *
 * @template T - The EventDefinition type (use `typeof YourEvent`)
 * @returns IEventConsumer<Data, Result>, or `never` if T is not an EventDefinition
 *
 * @example
 * ```typescript
 * class UserCreatedConsumer implements EventEventConsumer<typeof UserCreated> {
 *   onEvent = async (ctx) => {
 *     // ctx.data is correctly typed
 *     // return type is correctly enforced
 *     return { sent: true };
 *   };
 * }
 * ```
 */
export type EventConsumer<T> = T extends EventDefinition<infer D, infer R> ? IEventConsumer<D, R> : never;

/**
 * Get the EventContext typed for an EventDefinition.
 *
 * @template T - The EventDefinition type (use `typeof YourEvent`)
 * @returns EventContext<Data>, or `never` if T is not an EventDefinition
 *
 * @example
 * ```typescript
 * function handleEvent(ctx: EventCtx<typeof UserCreated>) {
 *   ctx.data.userId; // string - correctly typed
 * }
 * ```
 */
export type EventCtx<T> = T extends EventDefinition<infer D, unknown> ? EventContext<D> : never;

// ============================================================================
// Workflow Consumer Types
// ============================================================================

/**
 * Get the IWorkflowConsumer interface typed for a WorkflowDefinition.
 *
 * Use this when implementing a workflow consumer class to ensure type safety.
 * Automatically extracts data, result, and step types from the definition.
 *
 * @template T - The WorkflowDefinition type (use `typeof YourWorkflow`)
 * @returns IWorkflowConsumer<Data, Result, Steps>, or `never` if T is not a WorkflowDefinition
 *
 * @example
 * ```typescript
 * // Simple workflow (no steps)
 * class SendEmailWorkflow implements WorkflowConsumer<typeof SendEmail> {
 *   onComplete = async (ctx) => {
 *     return { messageId: 'msg-123' };
 *   };
 * }
 *
 * // Workflow with steps - steps property is type-checked
 * class ProcessOrderWorkflow implements WorkflowConsumer<typeof ProcessOrder> {
 *   steps = {
 *     validate: {
 *       execute: async (ctx) => ({ valid: true }) // Must return { valid: boolean }
 *     },
 *     charge: {
 *       execute: async (ctx) => ({ chargeId: 'ch-123' }), // Must return { chargeId: string }
 *       rollback: async (ctx) => { ... }
 *     }
 *   };
 *
 *   onComplete = async (ctx) => {
 *     return { orderId: ctx.results.charge.chargeId };
 *   };
 * }
 * ```
 */
export type WorkflowConsumer<T> =
	T extends WorkflowDefinition<infer D, infer R, infer S> ? IWorkflowConsumer<D, R, S> : never;

/**
 * Get the WorkflowContext typed for a WorkflowDefinition.
 *
 * @template T - The WorkflowDefinition type (use `typeof YourWorkflow`)
 * @returns WorkflowContext<Data>, or `never` if T is not a WorkflowDefinition
 *
 * @example
 * ```typescript
 * function handleWorkflow(ctx: WorkflowCtx<typeof SendEmail>) {
 *   ctx.data.to; // string - correctly typed
 * }
 * ```
 */
export type WorkflowCtx<T> = T extends WorkflowDefinition<infer D, unknown, infer S> ? WorkflowContext<D, S> : never;
