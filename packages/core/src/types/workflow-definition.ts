/**
 * Workflow definition types for type-safe workflow registration.
 *
 * This module provides the WorkflowDefinition interface and Workflow.define() factory
 * for creating type-safe workflow definitions with TypeBox schemas.
 *
 * ## Type Carrier Pattern
 *
 * This module uses the "type carrier" pattern to enable compile-time type extraction
 * from TypeBox schemas. The pattern solves a fundamental TypeScript challenge:
 *
 * **Problem**: TypeBox schemas like `Type.Object({ to: Type.String() })` have
 * complex generic types that are difficult to extract. The `Static<T>` utility
 * gives you the runtime type, but you need a way to "carry" this type through
 * the definition object.
 *
 * **Solution**: We add `_data` and `_result` fields that are:
 * - `undefined` at runtime (zero memory/performance cost)
 * - Typed as `TData` / `TResult` at compile time
 * - Extractable via `typeof MyWorkflow['_data']` or utility types
 *
 * **Why `as unknown as`**: TypeScript won't allow assigning `undefined` to a
 * generic type `T` directly. The double assertion (`undefined as unknown as T`)
 * tells TypeScript "trust me, this value has type T for type-checking purposes."
 * This is safe because the value is NEVER accessed at runtime.
 *
 * ## Step Definition (Distributed Workflow Steps)
 *
 * Workflow steps are defined in the definition (not the consumer) so that:
 * - Emitter knows the step STRUCTURE → creates BullMQ flow with step children
 * - Consumer provides step HANDLERS → executes step jobs
 * - If coordinator A dies mid-step, coordinator B picks up from the queue
 *
 * ```typescript
 * const ProcessOrder = Workflow.define({
 *   name: 'process-order',
 *   data: Type.Object({ orderId: Type.String() }),
 *   result: Type.Object({ processedAt: Type.Number() })
 * }).steps(s => s
 *   .sequential(s.step('validate', Type.Object({ valid: Type.Boolean() })))
 *   .sequential(s.step('process', Type.Object({ processId: Type.String() })))
 *   .sequential(s.step('notify', Type.Object({ notified: Type.Boolean() })))
 * );
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { Type } from '@orijs/validation';
 * import { Workflow, type Data, type Result, type WorkflowConsumer } from '@orijs/core';
 *
 * // Define the workflow (without steps)
 * const SendEmail = Workflow.define({
 *   name: 'send-email',
 *   data: Type.Object({ to: Type.String(), subject: Type.String() }),
 *   result: Type.Object({ messageId: Type.String(), sentAt: Type.String() })
 * });
 *
 * // Extract types using utility types (RECOMMENDED)
 * type EmailData = Data<typeof SendEmail>;     // { to: string; subject: string }
 * type EmailResult = Result<typeof SendEmail>; // { messageId: string; sentAt: string }
 *
 * // Or extract directly via typeof (works but utility types are cleaner)
 * type DataDirect = typeof SendEmail['_data'];
 *
 * // Implement a type-safe workflow consumer
 * class EmailWorkflow implements WorkflowConsumer<typeof SendEmail> {
 *   onComplete = async (ctx) => {
 *     // ctx.data is typed as { to: string; subject: string }
 *     console.log(ctx.data.to);
 *     return { messageId: 'msg-123', sentAt: new Date().toISOString() };
 *   };
 * }
 * ```
 *
 * @see {@link Data} - Utility type to extract data type
 * @see {@link Result} - Utility type to extract result type
 * @see {@link WorkflowConsumer} - Utility type for implementing workflow consumers
 */

import type { TSchema, Static } from '@orijs/validation';
import type { Logger } from '@orijs/logging';

// ============================================================================
// Step Definition Types
// ============================================================================

/**
 * Raw step definition created by s.step() before being added to builder.
 * Internal type - not exported.
 */
interface StepDefinitionRaw<TName extends string, TOutput extends TSchema> {
	readonly name: TName;
	readonly outputSchema: TOutput;
}

/**
 * A single step in a workflow definition.
 *
 * Contains the step name, output schema, and a type carrier for the output type.
 * Used for both sequential and parallel steps.
 *
 * @template TName - The step name (string literal type for type safety)
 * @template TOutput - The step output type (extracted from TypeBox schema)
 */
export interface StepDefinition<TName extends string = string, TOutput = unknown> {
	/** Step name - must match a handler in the consumer */
	readonly name: TName;
	/** TypeBox schema for runtime validation of step output */
	readonly outputSchema: TSchema;
	/**
	 * Type carrier for step output type.
	 * ALWAYS undefined at runtime - used for type extraction only.
	 */
	readonly _output: TOutput;
}

/**
 * A group of steps - either sequential or parallel.
 *
 * Compatible with @orijs/workflows StepGroup for use with FlowBuilder.
 *
 * - Sequential: one step executes, then next group starts
 * - Parallel: all steps in definitions array execute concurrently
 */
export interface StepGroup {
	/** Execution mode: sequential (one at a time) or parallel (concurrent) */
	readonly type: 'sequential' | 'parallel';
	/**
	 * Step definitions in this group.
	 * - Sequential: single step per group (definitions has one element)
	 * - Parallel: multiple steps (all execute concurrently)
	 */
	readonly definitions: readonly StepDefinition[];
}

/**
 * Fluent builder for defining workflow steps.
 *
 * @template TSteps - Accumulated step types as Record<stepName, outputType>
 *
 * @example
 * ```typescript
 * // In .steps() callback
 * s => s
 *   .sequential(s.step('validate', Type.Object({ valid: Type.Boolean() })))
 *   .sequential(s.step('process', Type.Object({ id: Type.String() })))
 *   .parallel(
 *     s.step('notify', Type.Object({ sent: Type.Boolean() })),
 *     s.step('log', Type.Object({ logged: Type.Boolean() }))
 *   )
 * ```
 */
export class StepBuilder<TSteps extends Record<string, unknown> = Record<never, never>> {
	private readonly stepGroups: StepGroup[] = [];

	/**
	 * Creates a step definition.
	 *
	 * Does not add the step to the builder - pass the result to
	 * sequential() or parallel() to add it.
	 *
	 * @param name - Unique step name (must match handler in consumer)
	 * @param outputSchema - TypeBox schema for step output
	 * @returns Step definition to pass to sequential/parallel
	 */
	step<TName extends string, TOutput extends TSchema>(
		name: TName,
		outputSchema: TOutput
	): StepDefinitionRaw<TName, TOutput> {
		return { name, outputSchema };
	}

	/**
	 * Adds a sequential step.
	 *
	 * Sequential steps execute in order, one after another.
	 * Each step can access results of previous steps via ctx.results.
	 *
	 * @param stepDef - Step definition from s.step()
	 * @returns Builder with updated step types for chaining
	 */
	sequential<TName extends string, TOutput extends TSchema>(
		stepDef: StepDefinitionRaw<TName, TOutput>
	): StepBuilder<TSteps & Record<TName, Static<TOutput>>> {
		const processedStep: StepDefinition<TName, Static<TOutput>> = {
			name: stepDef.name,
			outputSchema: stepDef.outputSchema,
			_output: undefined as unknown as Static<TOutput>
		};
		// Sequential group has one step in definitions array
		this.stepGroups.push({ type: 'sequential', definitions: [processedStep as StepDefinition] });
		return this as unknown as StepBuilder<TSteps & Record<TName, Static<TOutput>>>;
	}

	/**
	 * Adds parallel steps.
	 *
	 * Parallel steps execute concurrently. All must complete before
	 * subsequent sequential steps can run.
	 *
	 * @param stepDefs - Step definitions from s.step() (spread)
	 * @returns Builder with updated step types for chaining
	 */
	parallel<
		T1 extends string,
		O1 extends TSchema,
		T2 extends string,
		O2 extends TSchema,
		T3 extends string = never,
		O3 extends TSchema = TSchema,
		T4 extends string = never,
		O4 extends TSchema = TSchema
	>(
		step1: StepDefinitionRaw<T1, O1>,
		step2: StepDefinitionRaw<T2, O2>,
		step3?: StepDefinitionRaw<T3, O3>,
		step4?: StepDefinitionRaw<T4, O4>
	): StepBuilder<
		TSteps &
			Record<T1, Static<O1>> &
			Record<T2, Static<O2>> &
			([T3] extends [never] ? object : Record<T3, Static<O3>>) &
			([T4] extends [never] ? object : Record<T4, Static<O4>>)
	> {
		const definitions: StepDefinition[] = [
			{ name: step1.name, outputSchema: step1.outputSchema, _output: undefined },
			{ name: step2.name, outputSchema: step2.outputSchema, _output: undefined }
		];
		if (step3) {
			definitions.push({ name: step3.name, outputSchema: step3.outputSchema, _output: undefined });
		}
		if (step4) {
			definitions.push({ name: step4.name, outputSchema: step4.outputSchema, _output: undefined });
		}
		// Parallel group has multiple steps in definitions array
		this.stepGroups.push({ type: 'parallel', definitions });
		return this as unknown as StepBuilder<
			TSteps &
				Record<T1, Static<O1>> &
				Record<T2, Static<O2>> &
				([T3] extends [never] ? object : Record<T3, Static<O3>>) &
				([T4] extends [never] ? object : Record<T4, Static<O4>>)
		>;
	}

	/**
	 * Internal: Returns the accumulated step groups.
	 * Called by WorkflowDefinition.steps() to build the definition.
	 */
	_getStepGroups(): readonly StepGroup[] {
		return Object.freeze([...this.stepGroups]);
	}
}

/**
 * Configuration for defining a workflow.
 *
 * @template TData - TypeBox schema for the input data
 * @template TResult - TypeBox schema for the result
 */
export interface WorkflowConfig<TData extends TSchema, TResult extends TSchema> {
	/** Unique workflow name. Use kebab-case: 'action-noun' (e.g., 'send-email') */
	readonly name: string;
	/** TypeBox schema for the workflow input data */
	readonly data: TData;
	/** TypeBox schema for the workflow result */
	readonly result: TResult;
}

/**
 * Base workflow definition with type carriers for compile-time type extraction.
 *
 * The `_data` and `_result` fields are type carriers - they are `undefined`
 * at runtime but enable TypeScript's `typeof` operator to extract the generic types.
 *
 * @template TData - The input data type (extracted from TypeBox schema)
 * @template TResult - The result type (extracted from TypeBox schema)
 * @template TSteps - Step output types as Record<stepName, outputType> (empty for no steps)
 *
 * @example
 * ```typescript
 * const MyWorkflow = Workflow.define({...});
 * type DataType = typeof MyWorkflow['_data']; // Extracts data type
 * type ResultType = typeof MyWorkflow['_result']; // Extracts result type
 * ```
 */
export interface WorkflowDefinition<TData = unknown, TResult = unknown, TSteps = Record<never, never>> {
	/** Unique workflow name */
	readonly name: string;
	/** TypeBox schema for runtime validation of input data */
	readonly dataSchema: TSchema;
	/** TypeBox schema for runtime validation of results */
	readonly resultSchema: TSchema;
	/**
	 * Step groups defining the workflow step structure.
	 * Empty array if workflow has no steps.
	 */
	readonly stepGroups: readonly StepGroup[];
	/**
	 * Type carrier for data type extraction.
	 *
	 * **IMPORTANT**: This field is ALWAYS `undefined` at runtime.
	 * It exists solely for TypeScript's type system to extract the data type.
	 *
	 * **DO NOT** access this field in runtime code - use the utility types instead:
	 * ```typescript
	 * type MyData = Data<typeof MyWorkflow>; // Correct
	 * const data = MyWorkflow._data; // WRONG - always undefined!
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
	 * type MyResult = Result<typeof MyWorkflow>; // Correct
	 * const result = MyWorkflow._result; // WRONG - always undefined!
	 * ```
	 */
	readonly _result: TResult;
	/**
	 * Type carrier for step types extraction.
	 *
	 * **IMPORTANT**: This field is ALWAYS `undefined` at runtime.
	 * It exists solely for TypeScript's type system to extract step output types.
	 *
	 * For workflows with steps, this is Record<stepName, outputType>.
	 * For workflows without steps, this is Record<never, never>.
	 */
	readonly _steps: TSteps;
}

/**
 * Intermediate builder returned by Workflow.define().
 *
 * Allows adding steps via .steps() fluent method or freezing as-is
 * for workflows without steps.
 *
 * @template TData - The input data type
 * @template TResult - The result type
 */
export interface WorkflowDefinitionBuilder<TData, TResult> extends WorkflowDefinition<
	TData,
	TResult,
	Record<never, never>
> {
	/**
	 * Adds steps to the workflow definition.
	 *
	 * Steps define the structure of work to be done. The emitter uses this
	 * to create BullMQ flows with step children, and the consumer provides
	 * handlers for each step.
	 *
	 * @param buildSteps - Callback that receives StepBuilder and returns configured builder
	 * @returns Frozen workflow definition with steps
	 *
	 * @example
	 * ```typescript
	 * const ProcessOrder = Workflow.define({
	 *   name: 'process-order',
	 *   data: Type.Object({ orderId: Type.String() }),
	 *   result: Type.Object({ processedAt: Type.Number() })
	 * }).steps(s => s
	 *   .sequential(s.step('validate', Type.Object({ valid: Type.Boolean() })))
	 *   .sequential(s.step('process', Type.Object({ processId: Type.String() })))
	 * );
	 * ```
	 */
	steps<TSteps extends Record<string, unknown>>(
		buildSteps: (s: StepBuilder) => StepBuilder<TSteps>
	): WorkflowDefinition<TData, TResult, TSteps>;
}

/**
 * Workflow context passed to workflow consumers and handlers.
 *
 * This interface represents the execution context available when processing
 * a workflow. It provides access to the workflow input data, metadata, and utilities.
 *
 * @experimental This is a minimal interface. Future enhancements may add:
 * - Step execution state (currentStep, completedSteps)
 * - Retry information (attemptNumber, lastError)
 * - Progress tracking (percentComplete, estimatedTimeRemaining)
 * - Parent workflow reference (for nested workflows)
 *
 * @template TData - The workflow input data type
 *
 * @example
 * ```typescript
 * class SendEmailWorkflow implements WorkflowConsumer<typeof SendEmail> {
 *   configure(w: WorkflowBuilder): void { ... }
 *
 *   onComplete = async (ctx: WorkflowContext<{ to: string; subject: string }>) => {
 *     console.log(`Workflow ${ctx.workflowId} completed for ${ctx.data.to}`);
 *     return { messageId: 'msg-123', sentAt: new Date().toISOString() };
 *   };
 * }
 * ```
 */
/**
 * Context passed to step handlers.
 *
 * Step handlers receive workflow data and accumulated results from previous steps.
 * The `results` property is typed based on the step definitions in the workflow.
 *
 * @template TData - The workflow input data type
 * @template TResults - Accumulated step results type (Record<stepName, outputType>)
 *
 * @example
 * ```typescript
 * // Step handler with typed results
 * private processStep = async (ctx: StepContext<OrderData, { validate: { valid: boolean } }>) => {
 *   // Access workflow input
 *   const { orderId } = ctx.data;
 *
 *   // Access previous step results (type-safe)
 *   const { valid } = ctx.results.validate;
 *
 *   ctx.log.info('Processing order', { orderId, valid });
 *   return { processId: 'proc-123' };
 * };
 * ```
 */
export interface StepContext<
	TData = unknown,
	TResults = Record<string, unknown>
> {
	/** Unique flow ID for this workflow execution */
	readonly flowId: string;
	/** The workflow input data */
	readonly data: TData;
	/**
	 * Accumulated results from completed steps.
	 * Each step can access previous step results via this property.
	 */
	readonly results: TResults;
	/** Logger with propagated context (correlationId, traceId, etc.) */
	readonly log: Logger;
	/** Metadata for context propagation */
	readonly meta: Record<string, unknown>;
	/** Current step name being executed */
	readonly stepName: string;
	/** Optional provider instance identifier */
	readonly providerId?: string;
}

/**
 * Workflow context passed to workflow consumers and handlers.
 *
 * This interface represents the execution context available when processing
 * a workflow. It provides access to the workflow input data, metadata, and utilities.
 *
 * NOTE: Property names match the runtime WorkflowContext from @orijs/workflows:
 * - `flowId` (not `workflowId`) for the unique workflow ID
 * - `log` (not `logger`) for the structured logger
 * - `results` for accumulated step results
 * - `meta` for propagation metadata
 *
 * @template TData - The workflow input data type
 *
 * @example
 * ```typescript
 * class SendEmailWorkflow implements WorkflowConsumer<typeof SendEmail> {
 *   configure(w: WorkflowBuilder): void { ... }
 *
 *   onComplete = async (ctx: WorkflowContext<{ to: string; subject: string }>) => {
 *     console.log(`Workflow ${ctx.flowId} completed for ${ctx.data.to}`);
 *     return { messageId: 'msg-123', sentAt: new Date().toISOString() };
 *   };
 * }
 * ```
 */
export interface WorkflowContext<TData, TSteps = Record<string, unknown>> {
	/** Unique flow ID for this workflow execution */
	readonly flowId: string;
	/** The workflow input data */
	readonly data: TData;
	/**
	 * Accumulated results from completed steps.
	 * Each step can access previous step results via this property.
	 */
	readonly results: TSteps;
	/** Logger with propagated context (correlationId, traceId, etc.) */
	readonly log: Logger;
	/** Metadata for context propagation */
	readonly meta: Record<string, unknown>;
	/**
	 * Correlation ID for distributed tracing.
	 * Links this workflow execution to the originating request or event chain.
	 * If not propagated from caller, a new ID is generated.
	 */
	readonly correlationId: string;
	/**
	 * Optional provider instance identifier.
	 * Identifies which provider instance is executing the current step.
	 */
	readonly providerId?: string;
}

/**
 * Factory for creating type-safe workflow definitions.
 *
 * @example
 * ```typescript
 * import { Type } from '@orijs/validation';
 *
 * // Simple workflow (no steps)
 * const SendEmail = Workflow.define({
 *   name: 'send-email',
 *   data: Type.Object({
 *     to: Type.String(),
 *     subject: Type.String(),
 *     body: Type.String()
 *   }),
 *   result: Type.Object({
 *     messageId: Type.String(),
 *     sentAt: Type.String()
 *   })
 * });
 *
 * // Workflow with steps (distributed execution)
 * const ProcessOrder = Workflow.define({
 *   name: 'process-order',
 *   data: Type.Object({ orderId: Type.String() }),
 *   result: Type.Object({ processedAt: Type.Number() })
 * }).steps(s => s
 *   .sequential(s.step('validate', Type.Object({ valid: Type.Boolean() })))
 *   .sequential(s.step('process', Type.Object({ processId: Type.String() })))
 * );
 *
 * // Registration: app.workflow(SendEmail, SendEmailWorkflow, [EmailService])
 * // Execute: ctx.workflows.execute(SendEmail, { to: 'test@example.com', ... })
 * ```
 */
export const Workflow = {
	/**
	 * Define a new workflow with TypeBox schemas for data and result.
	 *
	 * Returns a builder that can optionally add steps via .steps() or be used
	 * directly for simple workflows without steps.
	 *
	 * ## Why Static<T>?
	 *
	 * TypeBox schemas are runtime objects (e.g., `Type.Object({ id: Type.String() })`).
	 * TypeScript cannot infer the corresponding type from a runtime value alone.
	 * `Static<TSchema>` is TypeBox's utility type that extracts the TypeScript type
	 * that a schema validates. This enables compile-time type safety from runtime schemas.
	 *
	 * @param config - Workflow configuration with name, data schema, and result schema
	 * @returns WorkflowDefinitionBuilder with .steps() method for adding steps
	 */
	define<TData extends TSchema, TResult extends TSchema>(
		config: WorkflowConfig<TData, TResult>
	): WorkflowDefinitionBuilder<Static<TData>, Static<TResult>> {
		// Create the base definition properties
		const baseProps = {
			name: config.name,
			dataSchema: config.data,
			resultSchema: config.result,
			stepGroups: Object.freeze([]) as readonly StepGroup[],
			_data: undefined as unknown as Static<TData>,
			_result: undefined as unknown as Static<TResult>,
			_steps: undefined as unknown as Record<never, never>
		};

		// Add the steps() method for fluent building
		const builder: WorkflowDefinitionBuilder<Static<TData>, Static<TResult>> = {
			...baseProps,
			steps<TSteps extends Record<string, unknown>>(
				buildSteps: (s: StepBuilder) => StepBuilder<TSteps>
			): WorkflowDefinition<Static<TData>, Static<TResult>, TSteps> {
				const stepBuilder = new StepBuilder();
				const configuredBuilder = buildSteps(stepBuilder);
				const stepGroups = configuredBuilder._getStepGroups();

				return Object.freeze({
					name: config.name,
					dataSchema: config.data,
					resultSchema: config.result,
					stepGroups,
					_data: undefined as unknown as Static<TData>,
					_result: undefined as unknown as Static<TResult>,
					_steps: undefined as unknown as TSteps
				});
			}
		};

		return builder;
	}
};

/**
 * Type guard to check if a value is a WorkflowDefinition.
 *
 * Used to distinguish between WorkflowDefinition (new API) and WorkflowClass (old API)
 * when executing workflows.
 *
 * @param value - The value to check
 * @returns True if value is a WorkflowDefinition
 */
export function isWorkflowDefinition(
	value: unknown
): value is WorkflowDefinition<unknown, unknown, Record<string, unknown>> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'name' in value &&
		'dataSchema' in value &&
		'resultSchema' in value &&
		'stepGroups' in value &&
		typeof (value as WorkflowDefinition<unknown, unknown>).name === 'string' &&
		Array.isArray((value as WorkflowDefinition<unknown, unknown>).stepGroups)
	);
}

/**
 * Checks if a workflow definition has steps.
 *
 * @param definition - The workflow definition to check
 * @returns True if the workflow has one or more steps defined
 */
export function hasSteps(definition: WorkflowDefinition<unknown, unknown, Record<string, unknown>>): boolean {
	return definition.stepGroups.length > 0;
}
