/**
 * BullMQWorkflowProvider - Distributed workflow execution via BullMQ FlowProducer.
 *
 * DISTRIBUTED DESIGN PRINCIPLES:
 * 1. NO in-memory state for step tracking - use job.getChildrenValues()
 * 2. Rollback handlers via StepRegistry lookup, not local storage
 * 3. Result notification via QueueEvents (any instance can receive)
 * 4. failParentOnFailure cascades failures up the job tree
 *
 * ORDERING GUARANTEES:
 * - Execution order: Guaranteed by BullMQ job dependencies (children before parent)
 * - Completion notification order: NOT guaranteed (QueueEvents is pub/sub)
 * - Consumers should NOT rely on QueueEvents delivery order across workflows
 *
 * @module workflows/bullmq-workflow-provider
 */

import {
	FlowProducer,
	Worker,
	Queue,
	QueueEvents,
	Job,
	type ConnectionOptions,
	type JobsOptions,
	type WorkerOptions
} from 'bullmq';
import {
	WorkflowStepError,
	WorkflowTimeoutError,
	createWorkflowContext,
	type WorkflowProvider,
	type WorkflowDefinitionLike,
	type FlowHandle,
	type FlowStatus,
	type StepGroup,
	type WorkflowContext
} from '@orijs/workflows';
import { Logger, capturePropagationMeta, type PropagationMeta } from '@orijs/logging';
import { Json } from '@orijs/validation';
import {
	FlowBuilder,
	type FlowJobDefinition,
	type StepJobData,
	type StepJobRetryOpts,
	type WorkflowJobData
} from './flow-builder';
import { StepRegistry } from './step-registry';
import {
	WRAPPER_VERSION,
	flattenChildResults,
	type StepResultWrapper,
	type ParallelResultWrapper
} from './workflow-result-utils';

const DEFAULT_QUEUE_PREFIX = 'workflow';

/**
 * Default stall interval for BullMQ workers.
 *
 * BullMQ's default is 30000ms (30 seconds), designed for CPU-bound jobs that
 * might block the event loop. For I/O-bound workflows (database queries, HTTP
 * calls, async operations), workers can check in much more frequently.
 *
 * We use 5000ms (5 seconds) - the minimum BullMQ allows - because:
 * 1. OriJS workflows are I/O-bound, not CPU-bound
 * 2. Faster recovery when a worker crashes (5s vs 30s)
 * 3. Shorter effective timeouts for users
 *
 * @default 5000 (5 seconds)
 */
const DEFAULT_STALL_INTERVAL_MS = 5000;

/**
 * Default delay before cleaning up completed/failed flow state entries.
 * Gives callers time to check status before entry is removed.
 * @default 300000 (5 minutes)
 */
const DEFAULT_FLOW_STATE_CLEANUP_DELAY_MS = 300000;

/**
 * Default workflow timeout in milliseconds.
 * @default 30000 (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Default number of retry attempts for step jobs.
 * @default 3
 */
const DEFAULT_STEP_ATTEMPTS = 3;

/**
 * Default backoff configuration for step job retries.
 * Exponential backoff starting at 1 second.
 */
const DEFAULT_STEP_BACKOFF = {
	type: 'exponential' as const,
	delay: 1000
};

/**
 * Default maximum number of flow state entries to keep in memory.
 * When exceeded, oldest entries are evicted (LRU based on insertion order).
 * This prevents unbounded memory growth under high throughput.
 * @default 10000
 */
const DEFAULT_MAX_FLOW_STATES = 10000;

/**
 * Valid step name pattern: alphanumeric, underscores, hyphens.
 * Must start with alphanumeric, max 128 characters.
 */
const VALID_STEP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/**
 * Redis key prefix for flowId -> workflowName registry.
 * Full key: `${queuePrefix}:fr:${hash(flowId)}`
 * Uses Bun.hash for compact keys. Enables O(1) lookup of which queue a flowId belongs to.
 */
const FLOW_REGISTRY_KEY_PREFIX = 'fr';

/**
 * TTL for flow registry entries in seconds (15 minutes).
 * Entries auto-expire, no explicit cleanup needed.
 */
const FLOW_REGISTRY_TTL_SECONDS = 900;

/**
 * Validate that a step name is safe for use in queue names and Redis keys.
 * @throws Error if step name is invalid
 */
function validateStepName(stepName: string, workflowName: string): void {
	if (!stepName || typeof stepName !== 'string') {
		throw new Error(`Invalid step name in workflow '${workflowName}': step name must be a non-empty string`);
	}
	if (stepName.startsWith('__')) {
		throw new Error(
			`Invalid step name '${stepName}' in workflow '${workflowName}': step names cannot start with '__' (reserved prefix)`
		);
	}
	if (!VALID_STEP_NAME_PATTERN.test(stepName)) {
		throw new Error(
			`Invalid step name '${stepName}' in workflow '${workflowName}': ` +
				`step names must start with alphanumeric and contain only alphanumeric, underscores, or hyphens (max 128 chars)`
		);
	}
}

export interface ExecuteOptions {
	readonly meta?: PropagationMeta;
	/**
	 * Workflow timeout in milliseconds.
	 *
	 * **IMPORTANT: Stall interval is automatically added to this value.**
	 *
	 * The effective timeout = timeout + stallInterval. This ensures that if a worker
	 * dies mid-workflow, there's enough time for BullMQ's stall detection to kick in
	 * and another worker to pick up the job before the timeout fires.
	 *
	 * Example: If you set timeout: 30000 and stallInterval is 5000 (default), the
	 * effective timeout will be 35000ms (35 seconds).
	 *
	 * Set to 0 to disable timeout entirely.
	 *
	 * @default 30000 (30 seconds, effective 35 seconds with default stallInterval)
	 */
	readonly timeout?: number;
	/**
	 * Optional idempotency key for deduplication.
	 *
	 * When provided, BullMQ will use this key to deduplicate workflow submissions.
	 * If a workflow with the same key is already running (pending, active, or waiting),
	 * the duplicate submission will be ignored and the existing flow handle returned.
	 *
	 * Use cases:
	 * - Prevent duplicate processing when clients retry due to network timeouts
	 * - Ensure exactly-once semantics for workflow execution
	 *
	 * @example
	 * ```ts
	 * // Hash the input data to create an idempotency key
	 * const idempotencyKey = `order-${orderId}`;
	 * await provider.execute(OrderWorkflow, data, { idempotencyKey });
	 * ```
	 *
	 * Note: The key must NOT contain colons `:` as BullMQ uses them as separators.
	 */
	readonly idempotencyKey?: string;
}

/**
 * Job options - re-exported from BullMQ.
 * Full passthrough to BullMQ's JobsOptions.
 */
export type { JobsOptions as BullMQJobOptions } from 'bullmq';

/**
 * Worker options - re-exported from BullMQ.
 * Full passthrough to BullMQ's WorkerOptions.
 */
export type { WorkerOptions as BullMQWorkerOptions } from 'bullmq';

/**
 * Combined workflow options - job options + worker options.
 * Full BullMQ native interface, no abstraction.
 *
 * @example
 * ```ts
 * app.workflows(registry, provider, {
 *   // Worker options
 *   concurrency: 10,
 *   // Job options
 *   attempts: 3,
 *   backoff: { type: 'exponential', delay: 1000 },
 *   failParentOnFailure: true,
 * });
 * ```
 */
export type BullMQWorkflowOptions = Partial<JobsOptions> & Partial<WorkerOptions>;

export interface BullMQWorkflowProviderOptions {
	readonly connection: ConnectionOptions;
	readonly queuePrefix?: string;
	readonly defaultTimeout?: number;
	/**
	 * Stall interval in milliseconds for detecting crashed workers.
	 *
	 * **Distributed Lock Semantics:**
	 * BullMQ uses Redis-based distributed locks with TTL (time-to-live) to prevent
	 * zombie workers from processing stale jobs. Each worker must "check in" within
	 * the stall interval to prove it's alive and still processing the job.
	 *
	 * **How it works:**
	 * 1. Worker acquires lock on job with TTL = stallInterval
	 * 2. Worker periodically extends the lock while processing (every stallInterval/2)
	 * 3. If worker dies, lock expires after stallInterval
	 * 4. Another worker picks up the "stalled" job and retries it
	 *
	 * **Default value:**
	 * We use 5000ms (5 seconds) because OriJS workflows are I/O-bound, not CPU-bound.
	 * Workers can check in frequently between async operations. This provides fast
	 * recovery (5s) when workers crash.
	 *
	 * **Minimum value:** 5000ms (5 seconds) - values below this are rejected to
	 * avoid false positives from GC pauses or network hiccups.
	 *
	 * @default 5000 (5 seconds)
	 */
	readonly stallInterval?: number;
	/**
	 * Delay in milliseconds before cleaning up completed/failed flow state entries.
	 * Gives callers time to check status via getStatus() before entry is removed.
	 * Set to 0 to disable cleanup (not recommended for long-running applications).
	 * @default 300000 (5 minutes)
	 */
	readonly flowStateCleanupDelay?: number;
	/**
	 * Maximum number of flow state entries to keep in memory.
	 * When exceeded, oldest entries are evicted (LRU based on insertion order).
	 * This prevents unbounded memory growth under high workflow throughput.
	 * Set to 0 to disable limit (not recommended for production).
	 * @default 10000
	 */
	readonly maxFlowStates?: number;
	/**
	 * Timeout in milliseconds for individual step execution.
	 *
	 * When set, each step handler must complete within this time or it will
	 * be terminated with a timeout error. This prevents stuck step handlers
	 * from blocking workers indefinitely.
	 *
	 * **Use cases:**
	 * - Prevent infinite loops in step handlers
	 * - Enforce SLA on step execution time
	 * - Detect hanging external calls (DB, HTTP) within steps
	 *
	 * **Note:** This is independent of workflow-level timeout (`defaultTimeout`).
	 * - Workflow timeout applies to the entire workflow (all steps combined)
	 * - Step timeout applies to each individual step handler execution
	 *
	 * Set to 0 to disable step timeout (default).
	 *
	 * @default 0 (disabled)
	 */
	readonly stepTimeout?: number;
	/**
	 * Optional provider instance identifier.
	 *
	 * In distributed deployments with multiple provider instances sharing
	 * the same Redis, this identifies which instance is executing steps.
	 * The providerId is passed to WorkflowContext for:
	 * - Distributed tracing and debugging
	 * - Multi-instance testing verification
	 * - Observability and metrics
	 *
	 * @example
	 * ```ts
	 * const provider = new BullMQWorkflowProvider({
	 *   connection: { host: 'localhost', port: 6379 },
	 *   providerId: 'instance-1', // or hostname, pod name, etc.
	 * });
	 * ```
	 */
	readonly providerId?: string;
	readonly logger?: Logger;
	readonly FlowProducerClass?: new (opts: { connection: ConnectionOptions }) => IFlowProducer;
	readonly WorkerClass?: new (
		queueName: string,
		processor: (job: Job) => Promise<unknown>,
		opts: {
			connection: ConnectionOptions;
			concurrency?: number;
			lockDuration?: number;
			stalledInterval?: number;
		}
	) => IWorker;
	readonly QueueEventsClass?: new (
		queueName: string,
		opts: { connection: ConnectionOptions }
	) => IQueueEvents;
	readonly QueueClass?: new (queueName: string, opts: { connection: ConnectionOptions }) => Queue;
	readonly stepRegistry?: StepRegistry;
}

/**
 * Context for handling parallel step failures.
 * Groups related failure handling parameters to reduce function parameter count.
 * @internal
 */
interface ParallelFailureContext {
	readonly workflowName: string;
	readonly flowId: string;
	readonly workflowData: unknown;
	readonly outcomes: Array<{ name: string; result?: unknown; error?: Error }>;
	readonly existingResults: Record<string, unknown>;
	readonly failure: { name: string; error?: Error };
	readonly meta?: PropagationMeta;
}

/**
 * Context for rollback execution.
 * Groups related rollback parameters to reduce function parameter count.
 * @internal
 */
interface RollbackContext {
	readonly job: Job;
	readonly workflowName: string;
	readonly workflowData: unknown;
	readonly meta?: PropagationMeta;
}

export interface IFlowProducer {
	add(flow: FlowJobDefinition): Promise<{ job: { id: string } }>;
	close(): Promise<void>;
	/**
	 * Main ioredis connection.
	 * Exposed for adding error handlers that persist through close().
	 * Optional because test mocks may not have this property.
	 */
	connection?: IRedisConnection;
}

/**
 * Internal ioredis client interface.
 * BullMQ's RedisConnection exposes _client which is the actual ioredis instance.
 * This is the minimal interface needed for error handling - actual ioredis has more methods.
 */
interface IRedisClient {
	on(event: string, handler: (...args: unknown[]) => void): this;
}

/**
 * Extended Redis client interface for registry operations.
 * Used internally for flowId -> workflowName registry lookups with TTL.
 */
interface IRedisRegistryClient extends IRedisClient {
	set(key: string, value: string, ex: 'EX', seconds: number): Promise<string>;
	get(key: string): Promise<string | null>;
}

/**
 * BullMQ's RedisConnection exposes _client for accessing the underlying ioredis client.
 * We need this to add error handlers that persist after BullMQ removes its own during close().
 */
interface IRedisConnection {
	_client: IRedisClient;
}

export interface IWorker {
	close(): Promise<void>;
	on(event: string, handler: (...args: unknown[]) => void): this;
	/**
	 * Main ioredis connection - used for commands.
	 * Exposed for adding error handlers that persist through close().
	 */
	connection: IRedisConnection;
	/**
	 * Blocking ioredis connection - used for BRPOPLPUSH and similar blocking commands.
	 * Exposed for adding error handlers that persist through close().
	 */
	blockingConnection: IRedisConnection;
}

export interface IQueueEvents {
	on(event: string, callback: (...args: unknown[]) => void): this;
	off(event: string, callback: (...args: unknown[]) => void): this;
	close(): Promise<void>;
	/**
	 * Wait until QueueEvents is connected and ready to receive events.
	 * CRITICAL: Must be called before relying on events to prevent race conditions.
	 */
	waitUntilReady(): Promise<unknown>;
	/**
	 * Main ioredis connection.
	 * Exposed for adding error handlers that persist through close().
	 */
	connection: IRedisConnection;
}

function generateFlowId(): string {
	return `flow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Minimal local state - only for timeout tracking and status.
 * Step results come from BullMQ job.getChildrenValues().
 */
interface LocalFlowState {
	status: FlowStatus;
	error?: Error;
}

/**
 * BullMQ-based workflow provider for distributed workflow execution.
 *
 * This provider is designed for multi-instance deployments where:
 * - Instance 1 starts a workflow
 * - Instance 2 executes some steps
 * - Instance 3 completes the workflow
 * - Instance 1 receives the result
 *
 * All state flows through BullMQ (Redis), not local memory.
 *
 * Supports per-workflow options via BullMQWorkflowOptions:
 * - concurrency: Worker concurrency per workflow
 * - retries: Max retry attempts
 * - backoff: Retry backoff strategy
 * - backoffDelay: Base delay between retries
 */
export class BullMQWorkflowProvider implements WorkflowProvider<BullMQWorkflowOptions> {
	private readonly connection: ConnectionOptions;
	private readonly queuePrefix: string;
	private readonly stepRegistry: StepRegistry;
	private readonly defaultTimeout: number;
	private readonly stallInterval?: number;
	private readonly providerId?: string;
	private readonly flowStateCleanupDelay: number;
	private readonly maxFlowStates: number;
	private readonly stepTimeout: number;
	private readonly log: Logger;

	// Minimal local state - only for caller-side tracking
	private readonly localFlowStates: Map<string, LocalFlowState> = new Map();
	private readonly timeoutHandles: Map<string, ReturnType<typeof setTimeout>> = new Map();
	// Handles for scheduled localFlowStates cleanup (cleared on stop)
	private readonly flowStateCleanupHandles: Map<string, ReturnType<typeof setTimeout>> = new Map();

	// Deferred promises keyed by jobId (not flowId) for QueueEvents routing
	// `settled` flag prevents race conditions between timeout and QueueEvents handlers
	private readonly pendingResults = new Map<
		string,
		{
			flowId: string;
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			settled: boolean;
		}
	>();

	private flowProducer: IFlowProducer | null = null;
	private stepWorkers: Map<string, IWorker> = new Map();
	private workflowWorkers: Map<string, IWorker> = new Map();
	private queueEvents: Map<string, IQueueEvents> = new Map();
	private started = false;

	// Definition-based consumer handlers (new API)
	private readonly definitionConsumers: Map<
		string,
		{
			handler: (
				data: unknown,
				meta?: PropagationMeta,
				stepResults?: Record<string, unknown>
			) => Promise<unknown>;
			stepGroups: readonly StepGroup[];
			onError?: (
				data: unknown,
				meta?: PropagationMeta,
				error?: Error,
				stepResults?: Record<string, unknown>
			) => Promise<void>;
			options?: BullMQWorkflowOptions;
		}
	> = new Map();

	// Emitter-only workflow names (definitions without local consumers)
	private readonly emitterWorkflows: Set<string> = new Set();

	private readonly FlowProducerClass: new (opts: { connection: ConnectionOptions }) => IFlowProducer;
	private readonly WorkerClass: new (
		queueName: string,
		processor: (job: Job) => Promise<unknown>,
		opts: { connection: ConnectionOptions; concurrency?: number }
	) => IWorker;
	private readonly QueueEventsClass: new (
		queueName: string,
		opts: { connection: ConnectionOptions }
	) => IQueueEvents;
	private readonly QueueClass: new (queueName: string, opts: { connection: ConnectionOptions }) => Queue;

	/**
	 * Create a new BullMQ workflow provider.
	 *
	 * @param options - Provider configuration options
	 * @throws Error if stallInterval is less than 5000ms
	 */
	public constructor(options: BullMQWorkflowProviderOptions) {
		// Validate stallInterval minimum (5 seconds to avoid false positives)
		if (options.stallInterval !== undefined && options.stallInterval < 5000) {
			throw new Error(
				`stallInterval must be at least 5000ms (5 seconds) to avoid false stall detection. ` +
					`Received: ${options.stallInterval}ms`
			);
		}

		this.connection = options.connection;
		this.queuePrefix = options.queuePrefix ?? DEFAULT_QUEUE_PREFIX;
		this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT_MS;
		this.stallInterval = options.stallInterval;
		this.providerId = options.providerId;
		this.flowStateCleanupDelay = options.flowStateCleanupDelay ?? DEFAULT_FLOW_STATE_CLEANUP_DELAY_MS;
		this.maxFlowStates = options.maxFlowStates ?? DEFAULT_MAX_FLOW_STATES;
		this.stepTimeout = options.stepTimeout ?? 0;
		this.log = options.logger ?? new Logger('BullMQWorkflowProvider');
		this.stepRegistry = options.stepRegistry ?? new StepRegistry();

		this.FlowProducerClass =
			options.FlowProducerClass ?? (FlowProducer as unknown as typeof this.FlowProducerClass);
		this.WorkerClass = options.WorkerClass ?? (Worker as unknown as typeof this.WorkerClass);
		this.QueueEventsClass =
			options.QueueEventsClass ?? (QueueEvents as unknown as typeof this.QueueEventsClass);
		this.QueueClass = options.QueueClass ?? (Queue as unknown as typeof this.QueueClass);
	}

	/**
	 * Execute a workflow with the given data.
	 *
	 * Creates a BullMQ flow (parent job with step children) and returns a handle
	 * for tracking status and retrieving results. The workflow must be registered
	 * via `registerDefinitionConsumer()` or `registerEmitterWorkflow()` before execution.
	 *
	 * @template TData - Workflow input data type
	 * @template TResult - Workflow result type
	 * @param workflow - The workflow definition to execute
	 * @param data - Input data passed to workflow steps
	 * @param options - Execution options (flowId, timeout)
	 * @returns FlowHandle with status() and result() methods
	 * @throws Error if provider not started or workflow not registered
	 *
	 * @example
	 * ```ts
	 * const handle = await provider.execute(OrderWorkflow, { orderId: '123' });
	 * const status = await handle.status(); // 'pending' | 'running' | 'completed' | 'failed'
	 * const result = await handle.result(); // waits for completion
	 * ```
	 */
	public async execute<TData, TResult>(
		workflow: WorkflowDefinitionLike<TData, TResult>,
		data: TData,
		options?: ExecuteOptions
	): Promise<FlowHandle<TResult>> {
		const workflowName = workflow.name;

		if (!this.started) {
			const error = new Error('Provider not started. Call start() first.');
			this.log.error('Provider not started', { workflowName, error: error.message });
			throw error;
		}

		// Verify workflow is registered (either as consumer or emitter)
		const isRegistered =
			this.definitionConsumers.has(workflowName) || this.emitterWorkflows.has(workflowName);
		if (!isRegistered) {
			const error = new Error(
				`Workflow '${workflowName}' not registered. ` +
					`Call registerDefinitionConsumer() or registerEmitterWorkflow() first.`
			);
			this.log.error('Workflow not registered', { workflowName, error: error.message });
			throw error;
		}

		// Step groups come from either:
		// 1. Definition.stepGroups (from .steps() on definition)
		// 2. Consumer registration (structure passed to registerDefinitionConsumer)
		const definitionStepGroups = workflow.stepGroups;

		// If definition has no steps, check if consumer has steps registered
		let effectiveStepGroups = definitionStepGroups;
		if (definitionStepGroups.length === 0) {
			const consumer = this.definitionConsumers.get(workflowName);
			if (consumer && consumer.stepGroups.length > 0) {
				effectiveStepGroups = consumer.stepGroups;
			}
		}

		return this.executeDefinition<TData, TResult>(workflowName, data, options, effectiveStepGroups);
	}

	/**
	 * Execute a definition-based workflow.
	 *
	 * If the workflow has steps configured, creates a flow with step children.
	 * If no steps (or emitter-only mode), creates a simple job.
	 */
	private async executeDefinition<TData, TResult>(
		workflowName: string,
		data: TData,
		options?: ExecuteOptions,
		definitionStepGroups?: readonly StepGroup[]
	): Promise<FlowHandle<TResult>> {
		const flowId = generateFlowId();
		const queueName = `${this.queuePrefix}.${workflowName}`;
		const stepGroups = definitionStepGroups ?? [];
		const hasSteps = stepGroups.length > 0;

		// Initialize flow state and capture propagation metadata
		const { flowState, meta } = this.initializeFlowState(flowId, options);

		// Set up QueueEvents BEFORE adding job
		await this.getOrCreateQueueEvents(queueName);

		// Create deferred promise BEFORE adding job
		const { promise: resultPromise, resolve, reject } = this.createDeferredResult<TResult>();

		// Build step job retry options from defaults and consumer overrides
		const consumerOptions = this.definitionConsumers.get(workflowName)?.options;
		// BullMQ backoff can be number or object; only use if it matches our expected shape
		const consumerBackoff =
			consumerOptions?.backoff && typeof consumerOptions.backoff === 'object'
				? consumerOptions.backoff
				: undefined;
		const stepJobOpts: StepJobRetryOpts = {
			attempts: consumerOptions?.attempts ?? DEFAULT_STEP_ATTEMPTS,
			backoff: consumerBackoff ?? DEFAULT_STEP_BACKOFF
		};

		// Build job structure (without adding to queue yet)
		const { job, jobId } = hasSteps
			? this.buildFlowJob(
					workflowName,
					flowId,
					queueName,
					stepGroups as StepGroup[],
					data,
					meta,
					options,
					stepJobOpts
				)
			: this.buildSimpleJob(workflowName, flowId, queueName, data, meta, options);

		// CRITICAL: Register pending result BEFORE adding job to prevent race condition
		this.registerPendingResult(jobId, flowId, resolve, reject);

		// Add job to queue
		await this.flowProducer!.add(job);

		// Register flowId -> workflowName in Redis for O(1) lookups
		await this.registerFlowInRegistry(flowId, workflowName);

		// Update status using the stored reference (avoids non-null assertion)
		flowState.status = 'running';

		// Set up timeout and cleanup
		this.setupTimeoutAndCleanup(flowId, options, resultPromise);

		return {
			id: flowId,
			status: async () => this.localFlowStates.get(flowId)?.status ?? 'pending',
			result: async () => resultPromise
		};
	}

	/**
	 * Build a flow job with step children.
	 * Does NOT add to queue - returns structure for caller to add.
	 */
	private buildFlowJob<TData>(
		workflowName: string,
		flowId: string,
		_queueName: string,
		stepGroups: StepGroup[],
		data: TData,
		meta: PropagationMeta | undefined,
		options?: ExecuteOptions,
		stepJobOpts?: StepJobRetryOpts
	): { job: FlowJobDefinition; jobId: string } {
		const flowBuilder = new FlowBuilder({
			workflowName,
			flowId,
			queuePrefix: this.queuePrefix,
			meta,
			idempotencyKey: options?.idempotencyKey,
			stepJobOpts
		});
		const job = flowBuilder.buildFlow(stepGroups, data);
		const jobId = flowBuilder.getParentJobId();
		return { job, jobId };
	}

	/**
	 * Build a simple job without steps.
	 * Does NOT add to queue - returns structure for caller to add.
	 */
	private buildSimpleJob<TData>(
		workflowName: string,
		flowId: string,
		queueName: string,
		data: TData,
		meta: PropagationMeta | undefined,
		options?: ExecuteOptions
	): { job: FlowJobDefinition; jobId: string } {
		const jobData: WorkflowJobData = {
			type: 'workflow',
			version: '1.0',
			flowId,
			workflowData: data,
			stepResults: {},
			meta
		};
		const jobId = options?.idempotencyKey ?? `${workflowName}.${flowId}`;
		const job: FlowJobDefinition = {
			name: workflowName,
			queueName,
			data: jobData,
			opts: { jobId }
		};
		return { job, jobId };
	}

	/**
	 * Get workflow status by flowId.
	 *
	 * DISTRIBUTED: Queries Redis directly, so any instance can check status.
	 * First checks local cache, then falls back to Redis lookup across all
	 * registered workflow queues.
	 *
	 * @param flowId - The workflow flow ID (returned from execute())
	 * @returns The workflow status ('pending', 'running', 'completed', 'failed')
	 */
	public async getStatus(flowId: string): Promise<FlowStatus> {
		// Fast path: check local cache first
		const localStatus = this.localFlowStates.get(flowId)?.status;
		if (localStatus && localStatus !== 'pending') {
			return localStatus;
		}

		// Slow path: query Redis for the job
		// flowId is used as jobId when no idempotencyKey is provided
		const found = await this.findJobByFlowId(flowId);
		if (!found) {
			return 'pending'; // Job not found - may not exist yet or was cleaned up
		}

		try {
			const state = await found.job.getState();
			return this.mapBullMQStateToFlowStatus(state);
		} finally {
			await found.queue.close();
		}
	}

	/**
	 * Get workflow result by flowId.
	 *
	 * DISTRIBUTED: Retrieves result from Redis, so any instance can get it.
	 * If workflow is not yet complete, waits for completion.
	 *
	 * @param flowId - The workflow flow ID
	 * @returns The workflow result
	 * @throws Error if workflow failed or doesn't exist
	 */
	public async getResult<TResult = unknown>(flowId: string): Promise<TResult> {
		const found = await this.findJobByFlowId(flowId);
		if (!found) {
			throw new Error(`Workflow '${flowId}' not found. It may not exist or has been cleaned up.`);
		}

		const { job, queue } = found;

		try {
			const state = await job.getState();

			if (state === 'completed') {
				// Job completed - return the result
				return this.parseJobResult<TResult>(job.returnvalue);
			}

			if (state === 'failed') {
				throw new Error(`Workflow '${flowId}' failed: ${job.failedReason ?? 'Unknown error'}`);
			}

			// Job still running - close lookup queue, then wait via QueueEvents
			await queue.close();
			return this.waitForJobCompletion<TResult>(job, flowId);
		} finally {
			// Close queue if not already closed (for completed/failed paths)
			await queue.close().catch(() => {});
		}
	}

	/**
	 * Get a reconstructed handle for a workflow by flowId.
	 *
	 * DISTRIBUTED: Returns a handle that queries Redis directly, so it works
	 * from any instance regardless of which instance started the workflow.
	 *
	 * @param flowId - The workflow flow ID
	 * @returns A FlowHandle with working status() and result() methods
	 */
	public async getHandle<TResult = unknown>(flowId: string): Promise<FlowHandle<TResult>> {
		// Verify the job exists and get queueName
		const found = await this.findJobByFlowId(flowId);
		if (!found) {
			throw new Error(`Workflow '${flowId}' not found. It may not exist or has been cleaned up.`);
		}

		const queueName = found.job.queueName;
		await found.queue.close();

		return {
			id: flowId,
			status: async (): Promise<FlowStatus> => {
				const queue = this.createLookupQueue(queueName);
				try {
					const currentJob = await Job.fromId(queue, flowId);
					if (!currentJob) return 'pending';
					const state = await currentJob.getState();
					return this.mapBullMQStateToFlowStatus(state);
				} finally {
					await queue.close();
				}
			},
			result: async (): Promise<TResult> => {
				return this.getResult<TResult>(flowId);
			}
		};
	}

	/**
	 * Find a job by flowId across all registered workflow queues.
	 * The flowId is used as the jobId when no idempotencyKey is provided.
	 * Returns both job and queue - caller must close the queue when done.
	 *
	 * Uses O(1) registry lookup when available, falls back to sequential search.
	 */
	private async findJobByFlowId(flowId: string): Promise<{ job: Job; queue: Queue } | null> {
		// Fast path: O(1) registry lookup
		const registeredWorkflowName = await this.lookupFlowInRegistry(flowId);
		if (registeredWorkflowName) {
			const queueName = `${this.queuePrefix}.${registeredWorkflowName}`;
			const queue = this.createLookupQueue(queueName);

			try {
				const job = await Job.fromId(queue, flowId);
				if (job) {
					return { job, queue };
				}
			} catch {
				// Job not found despite registry entry - fall through to sequential search
			}

			await queue.close();
		}

		// Slow path: sequential search across all registered workflows
		const workflowNames = new Set<string>([...this.definitionConsumers.keys(), ...this.emitterWorkflows]);

		for (const workflowName of workflowNames) {
			// Skip if already checked via registry
			if (workflowName === registeredWorkflowName) continue;

			const queueName = `${this.queuePrefix}.${workflowName}`;
			const queue = this.createLookupQueue(queueName);

			try {
				const job = await Job.fromId(queue, flowId);
				if (job) {
					return { job, queue };
				}
			} catch {
				// Job not in this queue, try next
			}

			await queue.close();
		}

		return null;
	}

	/**
	 * Create a temporary Queue instance for job lookups.
	 * Caller is responsible for closing it after use.
	 */
	private createLookupQueue(queueName: string): Queue {
		return new this.QueueClass(queueName, { connection: this.connection });
	}

	/**
	 * Get the Redis registry key for a flowId.
	 * Uses Bun.hash for compact keys.
	 */
	private getFlowRegistryKey(flowId: string): string {
		const hash = Bun.hash(flowId).toString(36);
		return `${this.queuePrefix}:${FLOW_REGISTRY_KEY_PREFIX}:${hash}`;
	}

	/**
	 * Get the Redis client for registry operations.
	 * Returns null if flowProducer not started or connection unavailable.
	 */
	private getRedisRegistryClient(): IRedisRegistryClient | null {
		return (this.flowProducer?.connection?._client as IRedisRegistryClient) ?? null;
	}

	/**
	 * Register flowId -> workflowName mapping in Redis for O(1) lookups.
	 * Entry auto-expires after 15 minutes.
	 */
	private async registerFlowInRegistry(flowId: string, workflowName: string): Promise<void> {
		const client = this.getRedisRegistryClient();
		if (!client) return;

		try {
			await client.set(this.getFlowRegistryKey(flowId), workflowName, 'EX', FLOW_REGISTRY_TTL_SECONDS);
		} catch (err) {
			// Non-fatal - fallback to sequential search will still work
			this.log.warn('Failed to register flow in registry', {
				flowId,
				workflowName,
				error: (err as Error).message
			});
		}
	}

	/**
	 * Lookup workflowName for a flowId from the registry.
	 * Returns null if not found or registry unavailable.
	 */
	private async lookupFlowInRegistry(flowId: string): Promise<string | null> {
		const client = this.getRedisRegistryClient();
		if (!client) return null;

		try {
			return await client.get(this.getFlowRegistryKey(flowId));
		} catch {
			// Non-fatal - fallback to sequential search
			return null;
		}
	}

	/**
	 * Map BullMQ job state to FlowStatus.
	 */
	private mapBullMQStateToFlowStatus(state: string): FlowStatus {
		switch (state) {
			case 'completed':
				return 'completed';
			case 'failed':
				return 'failed';
			case 'active':
			case 'waiting':
			case 'waiting-children':
			case 'delayed':
				return 'running';
			default:
				return 'pending';
		}
	}

	/**
	 * Parse job returnvalue into typed result.
	 */
	private parseJobResult<TResult>(returnvalue: unknown): TResult {
		if (returnvalue == null) {
			return undefined as TResult;
		}
		if (typeof returnvalue === 'string') {
			try {
				return Json.parse(returnvalue) as TResult;
			} catch {
				return returnvalue as TResult;
			}
		}
		return Json.sanitize(returnvalue) as TResult;
	}

	/**
	 * Wait for a job to complete and return its result.
	 */
	private async waitForJobCompletion<TResult>(job: Job, flowId: string): Promise<TResult> {
		const queueName = job.queueName;

		// Set up QueueEvents listener
		const queueEvents = await this.getOrCreateQueueEvents(queueName);

		return new Promise<TResult>((resolve, reject) => {
			const cleanup = () => {
				queueEvents.off('completed', onCompleted as (...args: unknown[]) => void);
				queueEvents.off('failed', onFailed as (...args: unknown[]) => void);
			};

			const onCompleted = (args: { jobId: string; returnvalue?: string }) => {
				if (args.jobId === flowId) {
					cleanup();
					resolve(this.parseJobResult<TResult>(args.returnvalue));
				}
			};

			const onFailed = (args: { jobId: string; failedReason: string }) => {
				if (args.jobId === flowId) {
					cleanup();
					reject(new Error(`Workflow '${flowId}' failed: ${args.failedReason}`));
				}
			};

			queueEvents.on('completed', onCompleted as (...args: unknown[]) => void);
			queueEvents.on('failed', onFailed as (...args: unknown[]) => void);

			// Check if job already completed while we were setting up
			job
				.getState()
				.then((state) => {
					if (state === 'completed') {
						cleanup();
						resolve(this.parseJobResult<TResult>(job.returnvalue));
					} else if (state === 'failed') {
						cleanup();
						reject(new Error(`Workflow '${flowId}' failed: ${job.failedReason ?? 'Unknown error'}`));
					}
				})
				.catch(() => {}); // Chained to prevent unhandled rejection
		});
	}

	/**
	 * Register a definition-based workflow consumer.
	 *
	 * This is the new API for registering workflow consumers using WorkflowDefinition
	 * and WorkflowConsumer classes. The handler callback is invoked when workflow completes.
	 *
	 * When stepGroups is provided and non-empty, the provider will:
	 * 1. Register step handlers from stepHandlers in StepRegistry
	 * 2. Create BullMQ child jobs for each step during execution
	 * 3. Execute steps in order (sequential/parallel)
	 * 4. Call the handler (onComplete) only after all steps complete
	 *
	 * When stepGroups is empty or not provided, the handler is called directly.
	 *
	 * @param workflowName - Name of the workflow (from definition.name)
	 * @param handler - Callback to invoke when workflow completes (after steps if any)
	 * @param stepGroups - Optional step groups defining step structure (from definition.stepGroups)
	 * @param stepHandlers - Optional step handlers from consumer.steps (execute + rollback)
	 * @param onError - Optional error handler called when a step fails
	 * @param options - Optional BullMQ worker options
	 */
	public registerDefinitionConsumer(
		workflowName: string,
		handler: (
			data: unknown,
			meta?: PropagationMeta,
			stepResults?: Record<string, unknown>
		) => Promise<unknown>,
		stepGroups?: readonly StepGroup[],
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		stepHandlers?: Record<string, { execute: (ctx: any) => any; rollback?: (ctx: any) => any }>,
		onError?: (
			data: unknown,
			meta?: PropagationMeta,
			error?: Error,
			stepResults?: Record<string, unknown>
		) => Promise<void>,
		options?: BullMQWorkflowOptions
	): void {
		const groups = stepGroups ?? [];
		this.definitionConsumers.set(workflowName, { handler, stepGroups: groups, onError, options });

		// Remove from emitter-only if it was there (now has a consumer)
		this.emitterWorkflows.delete(workflowName);

		// If workflow has steps, register step handlers in StepRegistry
		// Step STRUCTURE comes from definition.stepGroups, step HANDLERS come from stepHandlers parameter
		if (groups.length > 0) {
			if (stepHandlers && Object.keys(stepHandlers).length > 0) {
				for (const group of groups) {
					for (const stepDef of group.definitions) {
						const stepName = stepDef.name;
						validateStepName(stepName, workflowName);
						const handlerEntry = stepHandlers[stepName];

						if (!handlerEntry) {
							this.log.warn(
								`Step '${stepName}' defined in workflow '${workflowName}' but no handler provided in consumer.steps`
							);
							continue;
						}

						// Register handler with StepRegistry
						this.stepRegistry.register(
							workflowName,
							stepName,
							handlerEntry.execute as (ctx: WorkflowContext<unknown>) => Promise<unknown>,
							handlerEntry.rollback as ((ctx: WorkflowContext<unknown>) => Promise<void> | void) | undefined
						);
					}
				}
				this.log.info(
					`Definition Consumer Registered -> [${workflowName}] [${this.countSteps(groups)} steps]`
				);
			} else {
				// Steps defined but no handlers - log warning
				this.log.warn(`Workflow '${workflowName}' has steps defined but no stepHandlers provided`);
				this.log.info(
					`Definition Consumer Registered -> [${workflowName}] [${this.countSteps(groups)} steps (no handlers)]`
				);
			}
		} else {
			this.log.info(`Definition Consumer Registered -> [${workflowName}]`);
		}

		if (this.started) {
			this.createDefinitionWorker(workflowName);
		}
	}

	/**
	 * Count total steps across all groups.
	 */
	private countSteps(groups: readonly StepGroup[]): number {
		return groups.reduce((acc, g) => acc + g.definitions.length, 0);
	}

	/**
	 * Register a workflow definition for emitting only (no local consumer).
	 * Used to track which workflows this instance can emit to.
	 */
	public registerEmitterWorkflow(workflowName: string): void {
		// Only add if not already registered as a consumer
		if (!this.definitionConsumers.has(workflowName)) {
			this.emitterWorkflows.add(workflowName);
		}
	}

	/**
	 * Start the workflow provider.
	 *
	 * Initializes the BullMQ FlowProducer and creates workers for all registered
	 * workflow consumers. Must be called before executing workflows.
	 *
	 * Idempotent - calling multiple times has no effect after first start.
	 */
	public async start(): Promise<void> {
		if (this.started) return;

		this.flowProducer = new this.FlowProducerClass({ connection: this.connection });
		this.started = true;

		// Create workers for definition-based consumers
		for (const [workflowName] of this.definitionConsumers) {
			this.createDefinitionWorker(workflowName);
		}

		const consumerList = [...this.definitionConsumers.keys()];
		const emitterList = [...this.emitterWorkflows];

		if (consumerList.length > 0) {
			this.log.info(
				`Workflow Provider Started -> [${consumerList.join(', ')}] [${this.workflowWorkers.size} Workers]`
			);
		} else if (emitterList.length > 0) {
			const emitterDisplay = emitterList.map((name) => `${name} (Non Consumer)`).join(', ');
			this.log.info(`Workflow Provider Started -> [${emitterDisplay}]`);
		} else {
			this.log.info('Workflow Provider Started -> [No Workflows]');
		}
	}

	/**
	 * Stop the workflow provider gracefully.
	 *
	 * Closes all BullMQ resources in order: workers (waiting for current jobs),
	 * QueueEvents listeners, queues, FlowProducer, and cleanup timers.
	 *
	 * Idempotent - calling multiple times has no effect after first stop.
	 */
	public async stop(): Promise<void> {
		// Idempotency guard - prevent double stop issues
		if (!this.started) {
			return;
		}
		this.started = false;

		this.log.info('Workflow Provider stopping');

		const errorHandler = this.createShutdownErrorHandler();

		// Close workers first (they process jobs) - sequentially to avoid race conditions
		await this.closeWorkerMap(this.stepWorkers, errorHandler);
		await this.closeWorkerMap(this.workflowWorkers, errorHandler);

		// Close queue events (they listen for completions)
		await this.closeQueueEventsMap(this.queueEvents, errorHandler);

		// Close flow producer last
		if (this.flowProducer) {
			if (this.flowProducer.connection?._client) {
				this.flowProducer.connection._client.on('error', errorHandler as (...args: unknown[]) => void);
			}
			await this.flowProducer.close();
			this.flowProducer = null;
		}

		// Clear timers
		this.clearTimerMap(this.timeoutHandles);
		this.clearTimerMap(this.flowStateCleanupHandles);

		this.pendingResults.clear();
		this.localFlowStates.clear();

		this.log.info('Workflow Provider stopped');
	}

	/**
	 * Create error handler for shutdown that handles expected connection close errors.
	 *
	 * When closing Workers, their blocking Redis connections (used for BRPOPLPUSH)
	 * emit "Connection is closed" errors. Without explicit error handlers, these
	 * become unhandled rejections. This handler suppresses expected close errors
	 * while logging unexpected errors.
	 */
	private createShutdownErrorHandler(): (err: Error) => void {
		return (err: Error) => {
			if (err.message.includes('Connection is closed')) {
				this.log.debug('Expected connection close error during shutdown', { error: err.message });
				return;
			}
			this.log.error('Redis connection error during shutdown', { error: err.message });
		};
	}

	/**
	 * Close all workers in a map with error handlers attached.
	 */
	private async closeWorkerMap(
		workers: Map<string, IWorker>,
		errorHandler: (err: Error) => void
	): Promise<void> {
		for (const worker of workers.values()) {
			worker.connection._client.on('error', errorHandler as (...args: unknown[]) => void);
			worker.blockingConnection._client.on('error', errorHandler as (...args: unknown[]) => void);
			await worker.close();
		}
		workers.clear();
	}

	/**
	 * Close all queue events in a map with error handlers attached.
	 */
	private async closeQueueEventsMap(
		queueEventsMap: Map<string, IQueueEvents>,
		errorHandler: (err: Error) => void
	): Promise<void> {
		for (const events of queueEventsMap.values()) {
			events.connection._client.on('error', errorHandler as (...args: unknown[]) => void);
			await events.close();
		}
		queueEventsMap.clear();
	}

	/**
	 * Clear all timers in a map.
	 */
	private clearTimerMap(timers: Map<string, ReturnType<typeof setTimeout>>): void {
		for (const handle of timers.values()) {
			clearTimeout(handle);
		}
		timers.clear();
	}

	/**
	 * Clear the workflow timeout for a specific flowId.
	 * Safe to call multiple times (idempotent).
	 */
	private clearFlowTimeout(flowId: string): void {
		const handle = this.timeoutHandles.get(flowId);
		if (handle) {
			clearTimeout(handle);
			this.timeoutHandles.delete(flowId);
		}
	}

	/**
	 * Create workers for definition-based workflow consumers.
	 *
	 * If the workflow has steps configured, creates both:
	 * 1. A step worker (processes individual steps via processStep())
	 * 2. A workflow parent worker (processes parent job via processDefinitionWorkflow())
	 *
	 * If no steps, creates only a workflow worker that calls handler directly.
	 */
	private createDefinitionWorker(workflowName: string): void {
		const consumer = this.definitionConsumers.get(workflowName);
		if (!consumer) return;

		const concurrency = consumer.options?.concurrency ?? 1;
		const workerOpts = this.buildWorkerOptions(concurrency);
		const hasSteps = consumer.stepGroups.length > 0;

		// Create step worker if workflow has steps
		if (hasSteps) {
			const stepQueueName = `${this.queuePrefix}.${workflowName}.steps`;
			this.createStepWorkerIfNeeded(stepQueueName, workerOpts);
		}

		// Create workflow parent worker
		const queueName = `${this.queuePrefix}.${workflowName}`;
		this.createWorkflowWorkerIfNeeded(
			queueName,
			async (job: Job) => this.processDefinitionWorkflow(job, workflowName),
			workerOpts
		);
	}

	/**
	 * Build worker options with stall interval configuration.
	 */
	private buildWorkerOptions(concurrency: number): {
		connection: ConnectionOptions;
		concurrency: number;
		lockDuration: number;
		stalledInterval: number;
	} {
		const effectiveStallInterval = this.stallInterval ?? DEFAULT_STALL_INTERVAL_MS;
		return {
			connection: this.connection,
			concurrency,
			lockDuration: effectiveStallInterval,
			stalledInterval: effectiveStallInterval
		};
	}

	/**
	 * Create a step worker if one doesn't exist for the queue.
	 */
	private createStepWorkerIfNeeded(
		queueName: string,
		workerOpts: {
			connection: ConnectionOptions;
			concurrency: number;
			lockDuration: number;
			stalledInterval: number;
		}
	): void {
		if (this.stepWorkers.has(queueName)) return;

		const worker = new this.WorkerClass(queueName, async (job: Job) => this.processStep(job), workerOpts);
		worker.on('error', (err: unknown) => {
			this.log.error('Step worker error', { queue: queueName, error: (err as Error).message });
		});
		worker.on('failed', () => {
			/* Handled via QueueEvents */
		});
		this.stepWorkers.set(queueName, worker);

		this.log.info(`Step Worker Created -> [${queueName}]`, {
			providerId: this.providerId,
			concurrency: workerOpts.concurrency
		});
	}

	/**
	 * Create a workflow worker if one doesn't exist for the queue.
	 */
	private createWorkflowWorkerIfNeeded(
		queueName: string,
		processor: (job: Job) => Promise<unknown>,
		workerOpts: {
			connection: ConnectionOptions;
			concurrency: number;
			lockDuration: number;
			stalledInterval: number;
		}
	): void {
		if (this.workflowWorkers.has(queueName)) return;

		const worker = new this.WorkerClass(queueName, processor, workerOpts);
		worker.on('error', (err: unknown) => {
			this.log.error('Workflow worker error', { queue: queueName, error: (err as Error).message });
		});
		worker.on('failed', () => {
			/* Handled via QueueEvents */
		});
		this.workflowWorkers.set(queueName, worker);

		this.log.info(`Workflow Worker Created -> [${queueName}]`, {
			providerId: this.providerId,
			concurrency: workerOpts.concurrency
		});
	}

	/**
	 * Set up timeout handling and promise cleanup for workflow execution.
	 *
	 * Handles:
	 * 1. Calculating effective timeout (user timeout + stall interval)
	 * 2. Setting up setTimeout with Redis state verification
	 * 3. Chaining promise cleanup to clear timeout on settlement
	 */
	private setupTimeoutAndCleanup(
		flowId: string,
		options: ExecuteOptions | undefined,
		resultPromise: Promise<unknown>
	): void {
		// Calculate effective timeout
		// IMPORTANT: We add stallInterval to the user's timeout to ensure recovery is possible.
		// If a worker dies, BullMQ needs stallInterval to detect the stall and release the job.
		const baseTimeout = options?.timeout !== undefined ? options.timeout : this.defaultTimeout;
		const effectiveTimeout = this.calculateEffectiveTimeout(baseTimeout);

		if (effectiveTimeout > 0) {
			const timeoutHandle = setTimeout(() => {
				// Delete handle synchronously when timeout fires to ensure cleanup
				this.timeoutHandles.delete(flowId);

				// RACE CONDITION FIX: Check Redis before timing out.
				// The job may have completed but QueueEvents hasn't delivered 'completed' yet.
				this.handleTimeoutWithRedisCheck(flowId, effectiveTimeout);
			}, effectiveTimeout);
			this.timeoutHandles.set(flowId, timeoutHandle);
		}

		// Chain .catch().finally() to prevent unhandled rejection
		resultPromise.catch(() => {}).finally(() => this.clearFlowTimeout(flowId));
	}

	/**
	 * Create a deferred promise with exposed resolve/reject functions.
	 * Used for workflow result tracking where we need to resolve/reject from event handlers.
	 */
	private createDeferredResult<T>(): {
		promise: Promise<T>;
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	} {
		let resolve!: (value: unknown) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res as (value: unknown) => void;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	/**
	 * Register a pending result for tracking workflow completion.
	 * Must be called BEFORE adding job to prevent race conditions with QueueEvents.
	 */
	private registerPendingResult(
		jobId: string,
		flowId: string,
		resolve: (value: unknown) => void,
		reject: (error: Error) => void
	): void {
		this.pendingResults.set(jobId, { flowId, resolve, reject, settled: false });
	}

	/**
	 * Atomically try to settle a pending result.
	 * Returns the pending entry if it can be settled, null if already settled.
	 * This prevents race conditions between timeout and QueueEvents handlers.
	 */
	private trySettlePending(jobId: string): {
		flowId: string;
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	} | null {
		const pending = this.pendingResults.get(jobId);
		if (!pending || pending.settled) {
			return null;
		}
		pending.settled = true;
		this.pendingResults.delete(jobId);
		return pending;
	}

	/**
	 * Initialize local flow state and capture propagation metadata.
	 * Common setup for both execute() and executeDefinition().
	 * Evicts oldest entries if maxFlowStates limit is exceeded.
	 *
	 * @returns Object with flowState reference and optional meta
	 */
	private initializeFlowState(
		flowId: string,
		options?: ExecuteOptions
	): { flowState: LocalFlowState; meta: PropagationMeta | undefined } {
		// Evict oldest entries if at capacity (LRU based on insertion order)
		this.evictOldestFlowStatesIfNeeded();

		const flowState: LocalFlowState = { status: 'pending' };
		this.localFlowStates.set(flowId, flowState);

		const capturedMeta = capturePropagationMeta();
		const meta = options?.meta ?? capturedMeta ?? undefined;

		if (!meta) {
			this.log.debug('Workflow executing without propagation metadata (no correlation ID)', { flowId });
		}

		return { flowState, meta };
	}

	/**
	 * Evict oldest flow state entries if map exceeds maxFlowStates limit.
	 * Uses insertion order as LRU proxy - oldest entries are first in Map iteration.
	 */
	private evictOldestFlowStatesIfNeeded(): void {
		if (this.maxFlowStates <= 0) {
			return; // Limit disabled
		}

		// Evict entries until we're under the limit
		while (this.localFlowStates.size >= this.maxFlowStates) {
			const oldestKey = this.localFlowStates.keys().next().value;
			if (oldestKey) {
				// Also clean up associated resources
				const cleanupHandle = this.flowStateCleanupHandles.get(oldestKey);
				if (cleanupHandle) {
					clearTimeout(cleanupHandle);
					this.flowStateCleanupHandles.delete(oldestKey);
				}
				this.localFlowStates.delete(oldestKey);
				this.log.debug('Evicted oldest flow state due to capacity limit', { flowId: oldestKey });
			} else {
				break; // Safety: exit if no keys found
			}
		}
	}

	/**
	 * Process a definition-based workflow job.
	 *
	 * For workflows with steps:
	 * - Gets accumulated step results from BullMQ job children
	 * - Passes results to the handler (which calls consumer.onComplete)
	 *
	 * For workflows without steps:
	 * - Calls handler directly with empty results
	 */
	private async processDefinitionWorkflow(job: Job, workflowName: string): Promise<unknown> {
		const data = job.data as WorkflowJobData;
		const { flowId, workflowData, meta } = data;

		const consumer = this.definitionConsumers.get(workflowName);
		if (!consumer) {
			throw new Error(`No consumer registered for workflow: ${workflowName}`);
		}

		// Check local state - if already failed (step failure), skip onComplete
		const localState = this.localFlowStates.get(flowId);
		if (localState?.status === 'failed') {
			this.log.debug('Definition workflow already failed locally, skipping onComplete', { flowId });
			return undefined;
		}

		this.log.debug('Processing definition workflow', { workflowName, flowId });

		try {
			// Get step results from BullMQ (if workflow has steps)
			// NOTE: In the new design, step structure comes from WorkflowDefinition.steps()
			// and is passed to the provider during registration. This section will be
			// updated in Goal 2 to read steps from the definition, not consumer.
			let stepResults: Record<string, unknown> = {};
			if (consumer.stepGroups.length > 0) {
				const childResults = await job.getChildrenValues();
				stepResults = flattenChildResults(childResults);

				// Check for distributed emitter/consumer mismatch
				if (Object.keys(stepResults).length === 0) {
					const stepNames = consumer.stepGroups.flatMap((g) => g.definitions.map((d) => d.name));
					throw new Error(
						`Workflow "${workflowName}" has ${stepNames.length} steps registered (${stepNames.join(', ')}) ` +
							`but the job has no step children. This happens when the emitter doesn't know about steps. ` +
							`FIX: Use WorkflowDefinition.steps() to define step structure in the definition itself, ` +
							`so both emitter and consumer have access to step information.`
					);
				}
			}

			const result = await consumer.handler(workflowData, meta, stepResults);
			this.log.debug('Definition workflow completed', { workflowName, flowId });
			return result;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.log.error('Definition workflow failed', {
				workflowName,
				flowId,
				error: err.message
			});

			// Update local state
			if (localState) {
				localState.status = 'failed';
				localState.error = err;
			}

			throw error;
		}
	}

	/**
	 * Execute a step handler with optional timeout.
	 *
	 * If stepTimeout is configured (> 0), wraps the handler execution with
	 * Promise.race to enforce a time limit. If the handler doesn't complete
	 * within the timeout, throws a WorkflowStepError with timeout message.
	 *
	 * @param stepName - Name of the step (for error messages)
	 * @param handler - The step handler function to execute
	 * @returns The handler result
	 * @throws WorkflowStepError if handler times out
	 */
	private async executeStepWithTimeout<T>(stepName: string, handler: () => Promise<T>): Promise<T> {
		// If no step timeout configured, execute directly
		if (this.stepTimeout <= 0) {
			return handler();
		}

		// Race between handler and timeout
		const timeoutPromise = new Promise<never>((_, reject) => {
			const timer = setTimeout(() => {
				reject(
					new WorkflowStepError(
						stepName,
						new Error(`Step '${stepName}' timed out after ${this.stepTimeout}ms`)
					)
				);
			}, this.stepTimeout);
			// Ensure timer doesn't keep process alive
			if (typeof timer === 'object' && 'unref' in timer) {
				timer.unref();
			}
		});

		return Promise.race([handler(), timeoutPromise]);
	}

	/**
	 * Process a step job.
	 *
	 * DISTRIBUTED: Uses job.getChildrenValues() for results, not local state.
	 */
	private async processStep(job: Job): Promise<StepResultWrapper | ParallelResultWrapper> {
		const data = job.data as StepJobData;
		const { flowId, stepName, workflowData } = data;
		const workflowName = this.extractWorkflowName(job.queueName, 'steps');

		// Log which provider instance is processing this step
		this.log.debug(`Processing Step -> [${stepName}]`, {
			providerId: this.providerId,
			flowId,
			workflowName
		});

		if (stepName.startsWith('__parallel__:')) {
			return this.processParallelGroup(job, workflowName, data);
		}

		const stepInfo = this.stepRegistry.getStep(workflowName, stepName);

		// Get results from BullMQ (distributed-safe)
		const childResults = await job.getChildrenValues();
		const results = flattenChildResults(childResults);

		const ctx = this.createContext(flowId, workflowName, workflowData, results, data.meta, stepName);

		// Execute with error capture and optional timeout
		try {
			const result = await this.executeStepWithTimeout(stepName, async () => stepInfo.handler(ctx));
			// Include prior results so next step in chain can access all accumulated results
			return {
				__version: WRAPPER_VERSION,
				__stepName: stepName,
				__stepResult: result,
				__priorResults: results
			};
		} catch (err) {
			const originalError = err instanceof Error ? err : new Error(String(err));
			const stepError = new WorkflowStepError(stepName, originalError);

			// Run rollbacks using BullMQ data + StepRegistry lookup
			await this.runRollbacks({ job, workflowName, workflowData, meta: data.meta });

			// Call onError callback
			await this.executeOnError(workflowName, flowId, workflowData, stepError, results, data.meta);

			// Update local state if we have it (caller instance)
			// DISTRIBUTED NOTE: In a multi-instance deployment, the instance processing
			// this step (Instance B) may not be the instance that called execute() (Instance A).
			// Instance B won't have localFlowStates or pendingResults for this flowId.
			// This is OK because:
			// 1. The throw below marks this job as failed in BullMQ
			// 2. failParentOnFailure cascades the failure to the parent workflow job
			// 3. Instance A receives the 'failed' QueueEvents and rejects its pending promise
			const localState = this.localFlowStates.get(flowId);
			if (localState) {
				localState.status = 'failed';
				localState.error = stepError;
			}

			// Reject pending result if we have it (only works on caller instance).
			// On other instances, this is a no-op - QueueEvents handles notification.
			this.rejectPendingByFlowId(flowId, stepError);

			// Throw so BullMQ marks job as failed
			throw stepError;
		}
	}

	/**
	 * Process a parallel group job.
	 */
	private async processParallelGroup(
		job: Job,
		workflowName: string,
		data: StepJobData
	): Promise<ParallelResultWrapper> {
		const { flowId, stepName, workflowData } = data;
		const stepNames = stepName.replace('__parallel__:', '').split(',');

		// Get results from prior steps
		const childResults = await job.getChildrenValues();
		const existingResults = flattenChildResults(childResults);

		// Execute all steps concurrently
		const outcomes = await this.executeParallelSteps(
			stepNames,
			workflowName,
			flowId,
			workflowData,
			existingResults,
			data.meta
		);

		// Check for failures
		const failure = outcomes.find((o) => o.error);
		if (failure) {
			await this.handleParallelFailure(job, {
				workflowName,
				flowId,
				workflowData,
				outcomes,
				existingResults,
				failure,
				meta: data.meta
			});
		}

		// All succeeded - build result
		return this.buildParallelSuccessResult(outcomes, existingResults);
	}

	/**
	 * Execute parallel steps concurrently, capturing errors instead of throwing.
	 */
	private async executeParallelSteps(
		stepNames: string[],
		workflowName: string,
		flowId: string,
		workflowData: unknown,
		existingResults: Record<string, unknown>,
		meta?: PropagationMeta
	): Promise<Array<{ name: string; result?: unknown; error?: Error }>> {
		return Promise.all(
			stepNames.map(async (name) => {
				const stepInfo = this.stepRegistry.getStep(workflowName, name);
				const ctx = this.createContext(flowId, workflowName, workflowData, existingResults, meta, name);

				try {
					const result = await this.executeStepWithTimeout(name, async () => stepInfo.handler(ctx));
					return { name, result };
				} catch (err) {
					return { name, error: err instanceof Error ? err : new Error(String(err)) };
				}
			})
		);
	}

	/**
	 * Handle parallel step failure: rollbacks, error callbacks, state update.
	 */
	private async handleParallelFailure(job: Job, ctx: ParallelFailureContext): Promise<never> {
		const stepError = new WorkflowStepError(ctx.failure.name, ctx.failure.error!);

		// Include successful parallel steps in rollback context
		const parallelResults = { ...ctx.existingResults };
		for (const o of ctx.outcomes) {
			if (!o.error) {
				parallelResults[o.name] = o.result;
			}
		}

		// Run rollbacks, onError, update state
		await this.runRollbacksWithResults(
			{ job, workflowName: ctx.workflowName, workflowData: ctx.workflowData, meta: ctx.meta },
			parallelResults
		);
		await this.executeOnError(
			ctx.workflowName,
			ctx.flowId,
			ctx.workflowData,
			stepError,
			parallelResults,
			ctx.meta
		);

		const localState = this.localFlowStates.get(ctx.flowId);
		if (localState) {
			localState.status = 'failed';
			localState.error = stepError;
		}

		this.rejectPendingByFlowId(ctx.flowId, stepError);
		throw stepError;
	}

	/**
	 * Build success result wrapper from parallel step outcomes.
	 */
	private buildParallelSuccessResult(
		outcomes: Array<{ name: string; result?: unknown }>,
		existingResults: Record<string, unknown>
	): ParallelResultWrapper {
		const parallelResults: Record<string, unknown> = {};
		for (const o of outcomes) {
			parallelResults[o.name] = o.result;
		}
		return {
			__version: WRAPPER_VERSION,
			__parallelResults: parallelResults,
			__priorResults: existingResults
		};
	}

	/**
	 * Run rollbacks for completed steps.
	 *
	 * DISTRIBUTED: Uses job.getChildrenValues() to find completed steps,
	 * then StepRegistry to lookup rollback handlers.
	 */
	private async runRollbacks(ctx: RollbackContext): Promise<void> {
		// Get completed steps from BullMQ job data
		const childResults = await ctx.job.getChildrenValues();
		const results = flattenChildResults(childResults);
		const completedStepNames = Object.keys(results);

		if (completedStepNames.length === 0) {
			return;
		}

		const flowId = (ctx.job.data as StepJobData).flowId;
		const failures: Array<{ step: string; error: string }> = [];
		let successCount = 0;

		// Run rollbacks in reverse order
		for (const stepName of completedStepNames.reverse()) {
			const rollback = this.stepRegistry.getRollback(ctx.workflowName, stepName);
			if (!rollback) continue;

			const stepCtx = this.createContext(
				flowId,
				ctx.workflowName,
				ctx.workflowData,
				results,
				ctx.meta,
				`${stepName}:rollback`
			);

			try {
				await rollback(stepCtx);
				this.log.debug('Rollback completed', { flowId, step: stepName });
				successCount++;
			} catch (rollbackError) {
				const errorMessage = (rollbackError as Error).message;
				failures.push({ step: stepName, error: errorMessage });
				this.log.error('Rollback failed', {
					flowId,
					step: stepName,
					error: errorMessage
				});
			}
		}

		// Log aggregated summary if any rollbacks were attempted
		if (successCount > 0 || failures.length > 0) {
			this.log.info('Rollback summary', {
				flowId,
				workflowName: ctx.workflowName,
				succeeded: successCount,
				failed: failures.length,
				failures: failures.length > 0 ? failures : undefined
			});
		}
	}

	/**
	 * Run rollbacks with additional parallel results included.
	 * Uses RollbackContext for grouped parameters plus explicit allResults.
	 */
	private async runRollbacksWithResults(
		ctx: RollbackContext,
		allResults: Record<string, unknown>
	): Promise<void> {
		const flowId = (ctx.job.data as StepJobData).flowId;

		// Get step names that completed successfully (have results)
		const completedStepNames = Object.keys(allResults);

		if (completedStepNames.length === 0) {
			return;
		}

		const failures: Array<{ step: string; error: string }> = [];
		let successCount = 0;

		// Run rollbacks in reverse order
		for (const stepName of completedStepNames.reverse()) {
			const rollback = this.stepRegistry.getRollback(ctx.workflowName, stepName);
			if (!rollback) continue;

			const stepCtx = this.createContext(
				flowId,
				ctx.workflowName,
				ctx.workflowData,
				allResults,
				ctx.meta,
				`${stepName}:rollback`
			);

			try {
				await rollback(stepCtx);
				this.log.debug('Rollback completed', { flowId, step: stepName });
				successCount++;
			} catch (rollbackError) {
				const errorMessage = (rollbackError as Error).message;
				failures.push({ step: stepName, error: errorMessage });
				this.log.error('Rollback failed', {
					flowId,
					step: stepName,
					error: errorMessage
				});
			}
		}

		// Log aggregated summary if any rollbacks were attempted
		if (successCount > 0 || failures.length > 0) {
			this.log.info('Rollback summary', {
				flowId,
				workflowName: ctx.workflowName,
				succeeded: successCount,
				failed: failures.length,
				failures: failures.length > 0 ? failures : undefined
			});
		}
	}

	/**
	 * Execute onError callback if defined.
	 */
	private async executeOnError(
		workflowName: string,
		flowId: string,
		workflowData: unknown,
		error: Error,
		results: Record<string, unknown>,
		meta?: PropagationMeta
	): Promise<void> {
		const consumer = this.definitionConsumers.get(workflowName);
		if (!consumer?.onError) {
			return;
		}

		try {
			await consumer.onError(workflowData, meta, error, results);
		} catch (onErrorError) {
			this.log.error('onError callback failed', {
				workflowName,
				flowId,
				originalError: error.message,
				onErrorError: onErrorError instanceof Error ? onErrorError.message : String(onErrorError)
			});
		}
	}

	private extractWorkflowName(queueName: string, queueType: 'steps' | 'workflow'): string {
		const pattern = queueType === 'steps' ? /^[^.]+\.([^.]+)\.steps$/ : /^[^.]+\.([^.]+)$/;
		const match = queueName.match(pattern);
		if (!match) {
			const error = new Error(`Invalid ${queueType} queue name: ${queueName}`);
			this.log.error('Failed to extract workflow name from queue', {
				queueName,
				queueType,
				error: error.message
			});
			throw error;
		}
		return match[1]!;
	}

	private createContext(
		flowId: string,
		workflowName: string,
		workflowData: unknown,
		results: Record<string, unknown>,
		meta?: PropagationMeta,
		stepName?: string
	): WorkflowContext<unknown> {
		const baseLog = meta ? Logger.fromMeta(workflowName, meta) : this.log.child(workflowName);

		const log = baseLog.with({
			flowId,
			...(stepName && { step: stepName }),
			...(this.providerId && { providerId: this.providerId })
		});

		return createWorkflowContext(flowId, workflowData, results, log, meta ?? {}, {
			workflowName,
			stepName,
			providerId: this.providerId
		});
	}

	/**
	 * Get or create QueueEvents for result notification.
	 *
	 * DISTRIBUTED: QueueEvents uses Redis Streams, so any instance
	 * listening will receive completion/failure notifications.
	 */
	private async getOrCreateQueueEvents(queueName: string): Promise<IQueueEvents> {
		const existing = this.queueEvents.get(queueName);
		if (existing) return existing;

		const events = new this.QueueEventsClass(queueName, { connection: this.connection });

		// Handle QueueEvents errors per BullMQ docs
		events.on('error', (err: unknown) => {
			this.log.error('QueueEvents error', { queue: queueName, error: (err as Error).message });
		});

		// CRITICAL: Wait for connection before relying on events
		// Without this, fast-completing workflows might not emit 'completed' in time
		await events.waitUntilReady();

		// Listen for workflow completion
		events.on('completed', (...eventArgs: unknown[]) => {
			const args = eventArgs[0] as { jobId: string; returnvalue?: string | unknown };
			const { jobId, returnvalue } = args;

			// Atomically settle to prevent race with timeout handler
			const pending = this.trySettlePending(jobId);
			if (!pending) return; // Not our job or already settled

			// Update local state
			const localState = this.localFlowStates.get(pending.flowId);
			if (localState) {
				localState.status = 'completed';
			}

			// Schedule cleanup to prevent unbounded memory growth from accumulated flow states.
			this.scheduleFlowStateCleanup(pending.flowId);

			// Parse and sanitize result to prevent prototype pollution
			let result: unknown;
			if (returnvalue == null) {
				result = undefined;
			} else if (typeof returnvalue === 'string') {
				try {
					// Json.parse automatically sanitizes to strip dangerous keys
					result = Json.parse(returnvalue);
				} catch {
					result = returnvalue;
				}
			} else {
				// Non-string values should be sanitized if they're objects
				result = Json.sanitize(returnvalue);
			}

			pending.resolve(result);
		});

		// Listen for workflow failure
		events.on('failed', (...eventArgs: unknown[]) => {
			const args = eventArgs[0] as { jobId: string; failedReason: string };
			const { jobId, failedReason } = args;

			// Atomically settle to prevent race with timeout handler
			const pending = this.trySettlePending(jobId);
			if (!pending) return; // Not our job or already settled

			// Update local state
			const localState = this.localFlowStates.get(pending.flowId);
			if (localState) {
				localState.status = 'failed';
				localState.error = new Error(failedReason);
			}

			// Schedule cleanup to prevent unbounded memory growth from accumulated flow states.
			this.scheduleFlowStateCleanup(pending.flowId);

			pending.reject(new Error(failedReason));
		});

		this.queueEvents.set(queueName, events);
		return events;
	}

	/**
	 * Schedule cleanup of a flow state entry after a delay.
	 *
	 * Prevents unbounded memory growth from accumulated completed/failed flow state entries.
	 * The delay gives callers time to check status via getStatus() before the entry is removed.
	 * After the delay, the entry is deleted and getStatus() will return 'pending' (default).
	 */
	private scheduleFlowStateCleanup(flowId: string): void {
		// Skip if cleanup is disabled (delay = 0)
		if (this.flowStateCleanupDelay <= 0) {
			return;
		}

		// Cancel any existing cleanup timer for this flow (in case of rapid status changes)
		const existingHandle = this.flowStateCleanupHandles.get(flowId);
		if (existingHandle) {
			clearTimeout(existingHandle);
		}

		// Schedule cleanup
		const handle = setTimeout(() => {
			this.localFlowStates.delete(flowId);
			this.flowStateCleanupHandles.delete(flowId);
		}, this.flowStateCleanupDelay);

		this.flowStateCleanupHandles.set(flowId, handle);
	}

	/**
	 * Handle timeout with Redis state check to prevent false timeouts.
	 *
	 * RACE CONDITION FIX: When timeout fires, the job may have actually completed
	 * in Redis but QueueEvents hasn't delivered the 'completed' event yet. This
	 * happens because:
	 * 1. Worker completes job and writes result to Redis
	 * 2. Timeout fires (before QueueEvents delivers 'completed')
	 * 3. Without this check, we'd reject with timeout error
	 * 4. QueueEvents 'completed' arrives milliseconds later (too late)
	 *
	 * By checking Redis, we avoid false timeouts when the job is actually done.
	 *
	 * @param flowId - The workflow flow ID
	 * @param effectiveTimeout - The timeout value to use in error message
	 */
	private handleTimeoutWithRedisCheck(flowId: string, effectiveTimeout: number): void {
		// Fire-and-forget async check - errors are logged, not thrown
		this.checkRedisAndTimeout(flowId, effectiveTimeout).catch((err) => {
			this.log.error('Error during timeout Redis check', { flowId, error: (err as Error).message });
			// On error checking Redis, fall back to timeout behavior
			this.executeTimeout(flowId, effectiveTimeout);
		});
	}

	/**
	 * Check Redis job state and either resolve or timeout.
	 */
	private async checkRedisAndTimeout(flowId: string, effectiveTimeout: number): Promise<void> {
		const state = this.localFlowStates.get(flowId);

		// If local state already updated (completed/failed), skip
		if (!state || (state.status !== 'pending' && state.status !== 'running')) {
			return;
		}

		// Query Redis for actual job state
		const found = await this.findJobByFlowId(flowId);
		if (!found) {
			// Job not found - proceed with timeout
			this.executeTimeout(flowId, effectiveTimeout);
			return;
		}

		const { job, queue } = found;

		try {
			const redisState = await job.getState();

			if (redisState === 'completed') {
				// Job completed in Redis! Resolve with result instead of timing out.
				this.log.debug('Timeout avoided - job completed in Redis', { flowId });

				// Atomically settle to prevent race with QueueEvents handler
				const pending = this.trySettlePendingByFlowId(flowId);
				if (pending) {
					state.status = 'completed';
					this.scheduleFlowStateCleanup(flowId);
					pending.resolve(this.parseJobResult(job.returnvalue));
				}
				return;
			}

			if (redisState === 'failed') {
				// Job failed in Redis - QueueEvents should handle it, don't double-reject
				this.log.debug('Timeout avoided - job failed in Redis (QueueEvents will handle)', { flowId });
				// QueueEvents 'failed' handler will update state and reject
				return;
			}

			// Job still active/waiting - proceed with timeout
			this.executeTimeout(flowId, effectiveTimeout);
		} finally {
			await queue.close();
		}
	}

	/**
	 * Execute the timeout: update state and reject pending promise.
	 */
	private executeTimeout(flowId: string, effectiveTimeout: number): void {
		const state = this.localFlowStates.get(flowId);
		if (state && (state.status === 'pending' || state.status === 'running')) {
			// Atomically settle to prevent race with QueueEvents handler
			const pending = this.trySettlePendingByFlowId(flowId);
			if (pending) {
				const timeoutError = new WorkflowTimeoutError(flowId, effectiveTimeout);
				state.status = 'failed';
				state.error = timeoutError;
				pending.reject(timeoutError);
			}
		}
	}

	/**
	 * Calculate effective timeout by adding stallInterval to base timeout.
	 *
	 * This ensures that if a worker dies mid-workflow, there's enough time for
	 * BullMQ's stall detection to kick in and another worker to pick up the job
	 * before the timeout fires.
	 *
	 * @param baseTimeout - The user-provided or default timeout
	 * @returns Effective timeout (baseTimeout + stallInterval), or 0 if timeout is disabled
	 */
	private calculateEffectiveTimeout(baseTimeout: number): number {
		if (baseTimeout <= 0) {
			return 0; // Timeout disabled
		}
		const stallInterval = this.stallInterval ?? DEFAULT_STALL_INTERVAL_MS;
		return baseTimeout + stallInterval;
	}

	/**
	 * Atomically try to settle a pending result by flowId.
	 * Returns the pending entry if it can be settled, null if already settled or not found.
	 * This prevents race conditions between timeout and QueueEvents handlers.
	 */
	private trySettlePendingByFlowId(flowId: string): {
		resolve: (v: unknown) => void;
		reject: (e: Error) => void;
	} | null {
		for (const [jobId, pending] of this.pendingResults.entries()) {
			if (pending.flowId === flowId) {
				if (pending.settled) {
					return null; // Already settled
				}
				pending.settled = true;
				this.pendingResults.delete(jobId);
				return pending;
			}
		}
		return null;
	}

	/**
	 * Reject pending result by flowId.
	 * Used to immediately notify caller when a step fails.
	 */
	private rejectPendingByFlowId(flowId: string, error: Error): void {
		const pending = this.trySettlePendingByFlowId(flowId);
		if (pending) {
			pending.reject(error);
		}

		// Clear timeout immediately rather than waiting for async .finally() handler
		this.clearFlowTimeout(flowId);
	}
}

export function createBullMQWorkflowProvider(options: BullMQWorkflowProviderOptions): BullMQWorkflowProvider {
	return new BullMQWorkflowProvider(options);
}
