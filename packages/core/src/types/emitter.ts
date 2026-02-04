/**
 * Emitter interfaces for ctx.events and ctx.workflows.
 *
 * These interfaces define the API available on the request context
 * for emitting events and executing workflows.
 *
 * ## Context Binding
 *
 * The OriJS framework creates instances of these emitters for each request
 * and binds them to the request context. This binding:
 *
 * 1. Enables automatic correlation ID propagation for distributed tracing
 * 2. Provides tenant isolation based on the authenticated user
 * 3. Allows the framework to track events/workflows per request
 *
 * Consumers should NOT instantiate these directly - use `ctx.events` and
 * `ctx.workflows` which are provided by the framework.
 */

import type { EventDefinition } from './event-definition';
import type { WorkflowDefinition } from './workflow-definition';

/**
 * Re-export of SocketEmitter for convenience.
 *
 * **Canonical source**: `@orijs/websocket`
 *
 * This re-export allows importing from `@orijs/core` for simpler imports when
 * using WebSocket features alongside other core types. Both import paths are
 * equivalent and reference the same type:
 *
 * ```typescript
 * // Either import works - choose based on what else you're importing
 * import type { SocketEmitter } from '@orijs/core';
 * import type { SocketEmitter } from '@orijs/websocket';
 * ```
 *
 * For WebSocket-specific types like `WebSocketConnection`, `WebSocketProvider`,
 * or `SocketCoordinator`, import from `@orijs/websocket` directly.
 */
export type { SocketEmitter } from '@orijs/websocket';

/**
 * Event emitter interface for type-safe event emission.
 *
 * Available on the request context as `ctx.events`.
 *
 * @example
 * ```typescript
 * // In a controller handler
 * private createUser = async (ctx: Context) => {
 *   const user = await this.userService.create(ctx.body);
 *
 *   // Type-safe emit - payload validated at compile time
 *   const result = await ctx.events.emit(UserCreated, {
 *     userId: user.id,
 *     email: user.email
 *   });
 *
 *   // result is typed as { welcomeEmailSent: boolean }
 *   return ctx.json({ user, ...result });
 * };
 * ```
 */
export interface EventEmitter {
	/**
	 * Emit an event with type-safe payload.
	 *
	 * ## Validation
	 *
	 * The payload is validated against the event's TypeBox schema at runtime.
	 * Invalid payloads throw a validation error before the event is queued.
	 *
	 * ## Execution Model
	 *
	 * Events are processed asynchronously via BullMQ. The Promise resolves
	 * when the consumer's `onEvent` handler completes. For fire-and-forget
	 * events (Type.Void() response), the Promise resolves when the event
	 * is successfully queued.
	 *
	 * @template TPayload - The event payload type
	 * @template TResponse - The event response type
	 * @param event - The event definition created via Event.define()
	 * @param payload - The event payload (validated against TypeBox schema)
	 * @returns Promise resolving to the consumer's response
	 *
	 * @throws {ValidationError} If payload fails TypeBox schema validation
	 * @throws {EventNotRegisteredError} If no consumer is registered for this event
	 * @throws {Error} If the consumer's onEvent handler throws
	 */
	emit<TPayload, TResponse>(
		event: EventDefinition<TPayload, TResponse>,
		payload: TPayload
	): Promise<TResponse>;
}

/**
 * Workflow executor interface for type-safe workflow execution.
 *
 * Available on the request context as `ctx.workflows`.
 *
 * @example
 * ```typescript
 * // In a controller handler
 * private sendWelcome = async (ctx: Context) => {
 *   // Type-safe execute - data validated at compile time
 *   const handle = await ctx.workflows.execute(SendWelcomeEmail, {
 *     to: ctx.body.email,
 *     userId: ctx.body.userId
 *   });
 *
 *   // Check status or wait for result
 *   const result = await handle.result();
 *   return ctx.json({ workflowId: handle.id, result });
 * };
 * ```
 */
export interface WorkflowExecutor {
	/**
	 * Execute a workflow with type-safe input data.
	 *
	 * ## Validation
	 *
	 * The data is validated against the workflow's TypeBox schema at runtime.
	 * Invalid data throws a validation error before the workflow is queued.
	 *
	 * ## Execution Model
	 *
	 * Workflows are queued via BullMQ and executed asynchronously. The Promise
	 * resolves immediately with a WorkflowHandle for tracking progress. Use
	 * `handle.result()` to wait for completion.
	 *
	 * @template TData - The workflow input data type
	 * @template TResult - The workflow result type
	 * @param workflow - The workflow definition created via Workflow.define()
	 * @param data - The workflow input data (validated against TypeBox schema)
	 * @param options - Optional execution options (id, priority, delay)
	 * @returns Promise resolving to a workflow handle for tracking/cancellation
	 *
	 * @throws {ValidationError} If data fails TypeBox schema validation
	 * @throws {WorkflowNotRegisteredError} If no consumer is registered for this workflow
	 */
	execute<TData, TResult>(
		workflow: WorkflowDefinition<TData, TResult>,
		data: TData,
		options?: WorkflowExecuteOptions
	): Promise<WorkflowHandle<TResult>>;
}

/**
 * Options for workflow execution.
 *
 * All options are optional. Omit for default behavior.
 *
 * @example
 * ```typescript
 * // Execute with high priority
 * await ctx.workflows.execute(SendEmail, data, { priority: -10 });
 *
 * // Execute with 5 minute delay
 * await ctx.workflows.execute(SendEmail, data, { delay: 5 * 60 * 1000 });
 *
 * // Execute with custom ID for idempotency
 * await ctx.workflows.execute(SendEmail, data, { id: `email-${userId}` });
 * ```
 */
export interface WorkflowExecuteOptions {
	/**
	 * Custom workflow ID. If not provided, a UUID will be generated.
	 * Use for idempotency - re-executing with same ID is a no-op.
	 */
	readonly id?: string;
	/**
	 * Priority level. Lower numbers = higher priority.
	 * @default 0
	 * @example -10 for high priority, 10 for low priority
	 */
	readonly priority?: number;
	/**
	 * Delay before starting the workflow, in milliseconds.
	 * @default 0 (start immediately)
	 * @example 60000 for 1 minute delay
	 */
	readonly delay?: number;
}

/**
 * Handle to a running or completed workflow.
 *
 * Provides methods to check status, wait for result, or cancel execution.
 * The handle is returned immediately from `execute()` - use its methods
 * to interact with the running workflow.
 *
 * @template TResult - The workflow result type
 *
 * @example
 * ```typescript
 * const handle = await ctx.workflows.execute(SendEmail, data);
 *
 * // Option 1: Poll for status
 * const status = await handle.status();
 * if (status === 'completed') {
 *   const result = await handle.result();
 * }
 *
 * // Option 2: Wait for completion (blocks until done)
 * try {
 *   const result = await handle.result();
 * } catch (error) {
 *   // Workflow failed - error contains failure details
 * }
 *
 * // Option 3: Cancel if taking too long
 * const cancelled = await handle.cancel();
 * ```
 */
export interface WorkflowHandle<TResult> {
	/** Unique workflow instance ID (matches WorkflowExecuteOptions.id if provided) */
	readonly id: string;

	/**
	 * Get the current status of the workflow.
	 *
	 * This is a non-blocking call that returns immediately with the current
	 * status. For completion notification, use `result()` instead.
	 *
	 * @returns Promise resolving to current status
	 */
	status(): Promise<WorkflowStatus>;

	/**
	 * Wait for the workflow to complete and get the result.
	 *
	 * This is a blocking call that waits until the workflow finishes.
	 * If the workflow is already complete, returns immediately.
	 *
	 * @returns Promise resolving to the workflow result
	 * @throws {WorkflowFailedError} If workflow failed - contains original error
	 * @throws {WorkflowCancelledError} If workflow was cancelled
	 */
	result(): Promise<TResult>;

	/**
	 * Cancel the workflow if it's still running.
	 *
	 * Cancellation is best-effort - if the workflow completes before the
	 * cancellation is processed, it will not be cancelled.
	 *
	 * @returns Promise resolving to true if cancelled, false if already completed/failed
	 */
	cancel(): Promise<boolean>;
}

/**
 * Workflow execution status.
 *
 * - `pending`: Workflow is queued but not yet started
 * - `running`: Workflow is currently executing
 * - `completed`: Workflow finished successfully
 * - `failed`: Workflow threw an error
 * - `cancelled`: Workflow was cancelled via handle.cancel()
 */
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
