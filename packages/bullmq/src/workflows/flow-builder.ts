/**
 * FlowBuilder - Converts WorkflowBuilder step groups to BullMQ FlowProducer structure.
 *
 * BullMQ flows use parent-child relationships where:
 * - Parent waits for ALL children to complete before processing
 * - Sequential execution: nested children (deepest runs first)
 * - Parallel execution: flat children array (run concurrently)
 *
 * @module workflows/flow-builder
 */

import type { StepGroup, StepDefinitionBase } from '@orijs/workflows';
import type { PropagationMeta } from '@orijs/logging';

/**
 * Job options for flow jobs.
 */
export interface FlowJobOpts {
	/**
	 * Custom job ID for deduplication.
	 *
	 * BullMQ will ignore jobs with duplicate IDs that already exist in the queue.
	 * This enables idempotent workflow execution - submitting the same workflow
	 * twice with the same jobId will only create one execution.
	 *
	 * Note: jobId must NOT contain colons `:` as BullMQ uses them as separators.
	 */
	readonly jobId?: string;

	/**
	 * If true, when this job fails, its parent job will also be failed.
	 * This enables failure cascading up the job hierarchy.
	 */
	readonly failParentOnFailure?: boolean;
}

/**
 * BullMQ FlowJob definition (matches BullMQ's FlowJob interface).
 *
 * We define our own interface to avoid direct BullMQ dependency in types,
 * making testing easier.
 */
export interface FlowJobDefinition {
	/** Job name */
	readonly name: string;
	/** Queue name for this job */
	readonly queueName: string;
	/** Job data payload */
	readonly data: FlowJobData;
	/** Job options */
	readonly opts?: FlowJobOpts;
	/** Child jobs (for flow hierarchy) */
	readonly children?: FlowJobDefinition[];
}

/** Current job data schema version */
export const JOB_DATA_VERSION = '1';

/**
 * Data payload for workflow parent job.
 */
export interface WorkflowJobData {
	/** Discriminant for union type narrowing */
	readonly type: 'workflow';
	/** Schema version for detecting incompatible jobs in queue during upgrades */
	readonly version: string;
	/** Unique flow execution ID */
	readonly flowId: string;
	/** Original workflow input data */
	readonly workflowData: unknown;
	/** Accumulated step results (for parent job) */
	readonly stepResults: Record<string, unknown>;
	/** Propagation metadata for context */
	readonly meta?: PropagationMeta;
}

/**
 * Data payload for step jobs.
 */
export interface StepJobData {
	/** Discriminant for union type narrowing */
	readonly type: 'step';
	/** Schema version for detecting incompatible jobs in queue during upgrades */
	readonly version: string;
	/** Unique flow execution ID */
	readonly flowId: string;
	/** Step name for handler lookup */
	readonly stepName: string;
	/** Original workflow input data */
	readonly workflowData: unknown;
	/** Propagation metadata for context */
	readonly meta?: PropagationMeta;
}

/**
 * Discriminated union type for flow job data.
 * Use `data.type` to narrow: 'workflow' or 'step'.
 */
export type FlowJobData = WorkflowJobData | StepJobData;

/**
 * Step job options for retry configuration.
 */
export interface StepJobRetryOpts {
	/** Number of retry attempts. @default 3 */
	readonly attempts?: number;
	/**
	 * Backoff configuration for retries.
	 * BullMQ supports 'exponential', 'fixed', or custom strategies.
	 */
	readonly backoff?: {
		readonly type: string;
		readonly delay?: number;
	};
}

/**
 * FlowBuilder configuration options.
 */
export interface FlowBuilderOptions {
	/** Workflow class name */
	readonly workflowName: string;
	/** Unique flow execution ID */
	readonly flowId: string;
	/** Queue name prefix (e.g., 'workflow') */
	readonly queuePrefix: string;
	/** Optional propagation metadata */
	readonly meta?: PropagationMeta;
	/**
	 * Optional idempotency key for deduplication.
	 *
	 * When provided, BullMQ will use this as the jobId for the workflow.
	 * Duplicate submissions with the same key will be ignored if the
	 * original job is still in the queue (pending, active, or waiting).
	 *
	 * Step jobs will use derived keys: `${idempotencyKey}:step:${stepName}`
	 */
	readonly idempotencyKey?: string;
	/**
	 * Step job options applied to all step jobs in the flow.
	 * Includes retry configuration (attempts, backoff).
	 */
	readonly stepJobOpts?: StepJobRetryOpts;
}

/**
 * FlowBuilder converts WorkflowBuilder step groups to BullMQ flow structure.
 *
 * The key insight is that BullMQ flows use parent-child relationships where
 * the parent only runs AFTER all children complete. So:
 *
 * - Sequential (A → B → C): nest as C ← B ← A (A runs first, then B, then C, then parent)
 * - Parallel (A, B, C): flat [A, B, C] (all run concurrently, then parent)
 *
 * @example
 * ```ts
 * const builder = new FlowBuilder({
 *   workflowName: 'OrderWorkflow',
 *   flowId: 'flow-123',
 *   queuePrefix: 'workflow',
 * });
 *
 * const stepGroups = workflowBuilder.getSteps();
 * const flowJob = builder.buildFlow(stepGroups, orderData);
 *
 * await flowProducer.add(flowJob);
 * ```
 */
export class FlowBuilder {
	private readonly workflowName: string;
	private readonly flowId: string;
	private readonly queuePrefix: string;
	private readonly meta?: PropagationMeta;
	private readonly idempotencyKey?: string;
	private readonly stepJobOpts?: StepJobRetryOpts;

	public constructor(options: FlowBuilderOptions) {
		this.workflowName = options.workflowName;
		this.flowId = options.flowId;
		this.queuePrefix = options.queuePrefix;
		this.meta = options.meta;
		this.idempotencyKey = options.idempotencyKey;
		this.stepJobOpts = options.stepJobOpts;
	}

	/**
	 * Build BullMQ flow structure from step groups.
	 *
	 * @param stepGroups - Array of step groups from WorkflowBuilder.getSteps()
	 * @param workflowData - Original workflow input data
	 * @returns FlowJobDefinition ready for FlowProducer.add()
	 */
	public buildFlow<TData>(stepGroups: readonly StepGroup[], workflowData: TData): FlowJobDefinition {
		// Build children chain from step groups (in reverse order since BullMQ runs deepest first)
		const children = this.buildChildrenChain(stepGroups, workflowData);

		// Always use a predictable jobId to prevent race conditions. When no
		// idempotencyKey is provided, use flowId as the jobId. This allows
		// pendingResults to be registered BEFORE calling flowProducer.add().
		const jobId = this.idempotencyKey ?? this.flowId;
		const opts: FlowJobOpts = { jobId };

		// Parent job (workflow itself)
		const parentJob: FlowJobDefinition = {
			name: this.workflowName,
			queueName: this.getWorkflowQueueName(),
			data: {
				type: 'workflow',
				version: JOB_DATA_VERSION,
				flowId: this.flowId,
				workflowData,
				stepResults: {},
				...(this.meta && { meta: this.meta })
			},
			opts,
			...(children.length > 0 && { children })
		};

		return parentJob;
	}

	/**
	 * Get the queue name for step jobs.
	 *
	 * @returns Step queue name (e.g., 'workflow.OrderWorkflow.steps')
	 */
	public getStepQueueName(): string {
		return `${this.queuePrefix}.${this.workflowName}.steps`;
	}

	/**
	 * Get the queue name for the workflow parent job.
	 *
	 * @returns Workflow queue name (e.g., 'workflow.OrderWorkflow')
	 */
	public getWorkflowQueueName(): string {
		return `${this.queuePrefix}.${this.workflowName}`;
	}

	/**
	 * Get the parent job ID that will be used for this workflow.
	 *
	 * Returns the predictable jobId BEFORE the job is added to BullMQ,
	 * allowing pendingResults to be registered before flowProducer.add()
	 * to prevent race conditions.
	 *
	 * @returns Parent job ID (idempotencyKey if provided, otherwise flowId)
	 */
	public getParentJobId(): string {
		return this.idempotencyKey ?? this.flowId;
	}

	/**
	 * Build the children chain from step groups.
	 *
	 * **Algorithm Overview:**
	 *
	 * In BullMQ FlowProducer, children run BEFORE their parent. This is the
	 * opposite of intuitive "parent first" thinking. To achieve execution
	 * order A → B → C → parent, we must build an inverted tree:
	 *
	 * ```
	 * Execution order: step1 → step2 → step3 → parent
	 *
	 * BullMQ job tree (children run first):
	 *       parent
	 *          └── step3 (child of parent, runs before parent)
	 *                └── step2 (child of step3, runs before step3)
	 *                      └── step1 (deepest child, runs first)
	 * ```
	 *
	 * **Build process:**
	 * 1. Start with empty children array
	 * 2. For each step group (in execution order):
	 *    - Create job(s) for the group
	 *    - Attach previous children to deepest job
	 *    - These jobs become children for next iteration
	 * 3. Final children array attaches to parent job
	 *
	 * **Parallel groups** create multiple sibling jobs at the same level,
	 * wrapped in a synthetic parent job (__parallel__:step1,step2) that
	 * aggregates their results.
	 */
	private buildChildrenChain<TData>(
		stepGroups: readonly StepGroup[],
		workflowData: TData
	): FlowJobDefinition[] {
		if (stepGroups.length === 0) {
			return [];
		}

		// Process groups from first to last (execution order)
		// Each iteration produces jobs that become children of the next group
		let childrenForNextGroup: FlowJobDefinition[] = [];

		for (const group of stepGroups) {
			childrenForNextGroup = this.processGroup(group, workflowData, childrenForNextGroup);
		}

		// Final children attach directly to parent
		return childrenForNextGroup;
	}

	/**
	 * Process a single step group into flow children.
	 *
	 * @param group - The step group to process
	 * @param workflowData - Original workflow data
	 * @param innerChildren - Jobs from earlier groups that should become children (run before this group)
	 * @returns Jobs that should be children of the next group (or parent if last group)
	 */
	private processGroup<TData>(
		group: StepGroup,
		workflowData: TData,
		innerChildren: FlowJobDefinition[]
	): FlowJobDefinition[] {
		if (group.type === 'parallel') {
			// Parallel: all steps run concurrently AFTER innerChildren complete
			//
			// We create a SINGLE "parallel-group" job that contains all step names.
			// The provider's worker handles this by executing all steps via Promise.all.
			// This ensures:
			// 1. innerChildren execute once (no duplication)
			// 2. All parallel steps run concurrently
			// 3. Parallel group waits for innerChildren to complete first
			const stepNames = group.definitions.map((s) => s.name);
			const parallelStepName = `__parallel__:${stepNames.join(',')}`;

			// Derive parallel group jobId from idempotency key if provided
			const parallelJobId = this.idempotencyKey
				? `${this.idempotencyKey}-step-${parallelStepName}`
				: undefined;

			const parallelGroupJob: FlowJobDefinition = {
				name: parallelStepName,
				queueName: this.getStepQueueName(),
				data: {
					type: 'step',
					version: JOB_DATA_VERSION,
					flowId: this.flowId,
					stepName: parallelStepName,
					workflowData,
					...(this.meta && { meta: this.meta })
				},
				opts: {
					failParentOnFailure: true,
					...(parallelJobId && { jobId: parallelJobId }),
					...(this.stepJobOpts?.attempts !== undefined && { attempts: this.stepJobOpts.attempts }),
					...(this.stepJobOpts?.backoff && { backoff: this.stepJobOpts.backoff })
				},
				...(innerChildren.length > 0 && { children: innerChildren })
			};
			return [parallelGroupJob];
		} else {
			// Sequential: steps run in order A → B → C
			// Structure: C ← B ← A (C has child B, B has child A)
			// innerChildren become children of A (the first/deepest step)
			//
			// Process from first to last:
			// - A gets innerChildren as children
			// - B gets A as child
			// - C gets B as child
			// Return [C] as the new "top" of the chain
			let chain = innerChildren;

			for (let i = 0; i < group.definitions.length; i++) {
				const stepDef = group.definitions[i]!;
				const stepJob = this.createStepJob(stepDef, workflowData, chain);
				chain = [stepJob];
			}

			return chain;
		}
	}

	/**
	 * Create a step job definition.
	 *
	 * DISTRIBUTED: Uses failParentOnFailure to cascade failures up the job hierarchy.
	 * When a step fails, BullMQ will automatically fail the parent workflow job.
	 *
	 * If idempotencyKey is set, step jobs get derived jobIds to ensure the entire
	 * workflow tree is deduplicated.
	 */
	private createStepJob<TData>(
		stepDef: StepDefinitionBase,
		workflowData: TData,
		children: FlowJobDefinition[]
	): FlowJobDefinition {
		// Derive step jobId from idempotency key if provided
		// Use hyphen separator (not colon) since BullMQ uses colon as separator
		const stepJobId = this.idempotencyKey ? `${this.idempotencyKey}-step-${stepDef.name}` : undefined;

		return {
			name: stepDef.name,
			queueName: this.getStepQueueName(),
			data: {
				type: 'step',
				version: JOB_DATA_VERSION,
				flowId: this.flowId,
				stepName: stepDef.name,
				workflowData,
				...(this.meta && { meta: this.meta })
			},
			opts: {
				failParentOnFailure: true,
				...(stepJobId && { jobId: stepJobId }),
				...(this.stepJobOpts?.attempts !== undefined && { attempts: this.stepJobOpts.attempts }),
				...(this.stepJobOpts?.backoff && { backoff: this.stepJobOpts.backoff })
			},
			...(children.length > 0 && { children })
		};
	}
}

/**
 * Creates a FlowBuilder instance.
 *
 * @param options - Builder configuration
 * @returns New FlowBuilder instance
 */
export function createFlowBuilder(options: FlowBuilderOptions): FlowBuilder {
	return new FlowBuilder(options);
}
