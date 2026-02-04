/**
 * Consumer interfaces for events and workflows.
 *
 * This module defines the contract that consumer classes must implement
 * to handle events and workflows in the OriJS framework.
 *
 * ## Architecture
 *
 * The consumer pattern separates event/workflow definitions from their handlers:
 * - **Definitions** (event-definition.ts, workflow-definition.ts): Declare WHAT events/workflows exist
 * - **Consumers** (this file): Define HOW to handle them
 * - **Emitters** (emitter.ts): Provide the API to trigger them
 *
 * ## Arrow Function Properties
 *
 * Consumer interfaces use arrow function properties (`onEvent = async (ctx) => {}`)
 * instead of methods (`async onEvent(ctx) {}`). This is intentional:
 *
 * **Problem**: When the framework calls `consumer.onEvent(ctx)`, if `onEvent` is
 * a regular method, `this` will be undefined (or the wrong value) because the
 * method reference is detached from the instance.
 *
 * **Solution**: Arrow function properties capture `this` at definition time:
 * ```typescript
 * class MyConsumer implements IEventConsumer<D, R> {
 *   constructor(private emailService: EmailService) {}
 *
 *   // ✅ Arrow function - this.emailService works correctly
 *   onEvent = async (ctx) => {
 *     await this.emailService.send(ctx.data.email);
 *     return { sent: true };
 *   };
 *
 *   // ❌ Regular method - this would be undefined when called
 *   // async onEvent(ctx) { ... }
 * }
 * ```
 *
 * ## Lifecycle Hooks
 *
 * Event consumers have three lifecycle hooks:
 * - `onEvent`: Main handler (required) - process the event and return result
 * - `onSuccess`: Called after successful completion (optional) - logging, metrics
 * - `onError`: Called on failure (optional) - cleanup, error logging
 *
 * Workflow consumers have:
 * - `onComplete`: Called when all steps finish (required) - return final result
 * - `onError`: Called on failure (optional) - cleanup, compensation
 *
 * NOTE: Step structure is now defined in the WorkflowDefinition via .steps(),
 * not in the consumer. The consumer only provides step handlers via the `steps` property.
 * This enables the emitter to create BullMQ flows with step children.
 *
 * ## Registration
 *
 * Consumers are registered with the application during startup:
 * ```typescript
 * app.event(UserCreated).consumer(UserCreatedConsumer, [EmailService, Logger]);
 * app.workflow(SendEmail).consumer(SendEmailWorkflow, [SmtpClient]);
 * ```
 *
 * @see event-definition.ts for Event.define() and EventContext
 * @see workflow-definition.ts for Workflow.define() and WorkflowContext
 * @see emitter.ts for EventEmitter and WorkflowExecutor
 */

// Re-export context types from their canonical locations
// EventContext lives with EventDefinition, WorkflowContext with WorkflowDefinition
export type { EventContext } from './event-definition';
export type { WorkflowContext, StepContext } from './workflow-definition';

// Import context types for use in this file
import type { EventContext } from './event-definition';
import type { WorkflowContext, StepContext } from './workflow-definition';

/**
 * Interface for event consumers.
 *
 * @template TData - The event input data type
 * @template TResult - The event result type
 *
 * @example
 * ```typescript
 * class UserCreatedConsumer implements IEventConsumer<{ userId: string }, { sent: boolean }> {
 *   onEvent = async (ctx) => {
 *     // Handle event
 *     return { sent: true };
 *   };
 * }
 * ```
 */
export interface IEventConsumer<TData, TResult> {
	/**
	 * Handle the event. This is the main handler method.
	 *
	 * **Must be an arrow function property** (not a method) to ensure `this`
	 * is correctly bound when the framework invokes the handler. See module
	 * documentation for detailed explanation.
	 *
	 * @param ctx - Event context with data, eventId, and metadata
	 * @returns The result (or Promise of result) matching the event definition
	 */
	readonly onEvent: (ctx: EventContext<TData>) => Promise<TResult> | TResult;

	/**
	 * Optional success callback. Called after onEvent completes successfully.
	 */
	readonly onSuccess?: (ctx: EventContext<TData>, result: TResult) => Promise<void> | void;

	/**
	 * Optional error callback. Called when onEvent throws an error.
	 */
	readonly onError?: (ctx: EventContext<TData>, error: Error) => Promise<void> | void;
}

/**
 * Step handler interface for workflow consumers.
 *
 * Each step handler has an `execute` function and optionally a `rollback` function.
 * Rollback is called in reverse order when a later step fails.
 *
 * @template TData - The workflow input data type
 * @template TOutput - The step output type
 *
 * @example
 * ```typescript
 * // Step with rollback
 * const chargeStep: StepHandler<OrderData, { chargeId: string }> = {
 *   execute: async (ctx) => {
 *     const chargeId = await paymentService.charge(ctx.data.amount);
 *     return { chargeId };
 *   },
 *   rollback: async (ctx) => {
 *     const { chargeId } = ctx.results.charge;
 *     await paymentService.refund(chargeId);
 *   }
 * };
 * ```
 */
export interface StepHandler<TData = unknown, TOutput = unknown> {
	/**
	 * Execute the step.
	 * @param ctx - Step context with workflow data and accumulated results
	 * @returns The step output (or Promise of output)
	 */
	readonly execute: (ctx: StepContext<TData>) => Promise<TOutput> | TOutput;

	/**
	 * Optional rollback handler. Called when a later step fails.
	 *
	 * **IMPORTANT: Rollback handlers MUST be idempotent.**
	 * In distributed systems with retries, rollback may be called multiple times.
	 *
	 * @param ctx - Step context with workflow data and accumulated results
	 */
	readonly rollback?: (ctx: StepContext<TData>) => Promise<void> | void;
}

/**
 * Interface for workflow consumers.
 *
 * Step structure is defined in the WorkflowDefinition via .steps(), not here.
 * The consumer only provides step handlers via the `steps` property.
 *
 * @template TData - The workflow input data type
 * @template TResult - The workflow result type
 * @template TSteps - Step types as Record<stepName, outputType> (from definition._steps)
 *
 * @example
 * ```typescript
 * // Simple workflow (no steps)
 * class SendEmailWorkflow implements IWorkflowConsumer<EmailData, EmailResult> {
 *   onComplete = async (ctx) => {
 *     return { messageId: 'msg-123' };
 *   };
 * }
 *
 * // Workflow with steps
 * class ProcessOrderWorkflow implements IWorkflowConsumer<OrderData, OrderResult, OrderSteps> {
 *   steps = {
 *     validate: {
 *       execute: async (ctx) => ({ valid: true })
 *     },
 *     charge: {
 *       execute: async (ctx) => ({ chargeId: 'ch-123' }),
 *       rollback: async (ctx) => { await refund(ctx.results.charge.chargeId); }
 *     }
 *   };
 *
 *   onComplete = async (ctx) => {
 *     return { orderId: ctx.results.charge.chargeId };
 *   };
 * }
 * ```
 */
export interface IWorkflowConsumer<TData, TResult, TSteps = Record<never, never>> {
	/**
	 * Step handlers for workflows with steps.
	 *
	 * Keys are step names (must match step names in WorkflowDefinition.steps()).
	 * Values are StepHandler objects with execute and optional rollback.
	 *
	 * **Must be arrow function properties** to ensure `this` is correctly bound.
	 */
	readonly steps?: {
		[K in keyof TSteps]?: StepHandler<TData, TSteps[K]>;
	};

	/**
	 * Handle workflow completion. Called when all steps complete.
	 *
	 * **Must be an arrow function property** (not a method) to ensure `this`
	 * is correctly bound when the framework invokes the handler. See module
	 * documentation for detailed explanation.
	 *
	 * @param ctx - Workflow context with data, workflowId, and metadata
	 * @returns The result (or Promise of result) matching the workflow definition
	 */
	readonly onComplete: (ctx: WorkflowContext<TData>) => Promise<TResult> | TResult;

	/**
	 * Optional error callback. Called when workflow fails.
	 */
	readonly onError?: (ctx: WorkflowContext<TData>, error: Error) => Promise<void> | void;
}
