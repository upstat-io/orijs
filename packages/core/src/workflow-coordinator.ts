import type { Constructor, ConstructorDeps } from './types/index';
import {
	InProcessWorkflowProvider,
	type WorkflowProvider,
	type WorkflowExecutor,
	type FlowHandle,
	type FlowStatus,
	type StepGroup as WorkflowsStepGroup
} from '@orijs/workflows';
import { capturePropagationMeta, Logger } from '@orijs/logging';
import type { Container } from './container';
import { isWorkflowDefinition, type WorkflowDefinition } from './types/workflow-definition';
import type { IWorkflowConsumer, WorkflowContext } from './types/consumer';
import { Value } from '@orijs/validation';

/**
 * Pending workflow consumer registration (before bootstrap).
 */
interface PendingWorkflowConsumer<TData = unknown, TResult = unknown> {
	definition: WorkflowDefinition<TData, TResult>;
	consumerClass: Constructor<IWorkflowConsumer<TData, TResult>>;
	deps: Constructor[];
}

/**
 * Factory function for creating default workflow providers.
 * Allows injection of custom factory for testing.
 */
export type WorkflowProviderFactory = () => WorkflowProvider;

/**
 * Instantiated workflow consumer with its definition.
 */
interface InstantiatedWorkflowConsumer {
	definition: WorkflowDefinition<unknown, unknown>;
	consumer: IWorkflowConsumer<unknown, unknown>;
}

/**
 * Coordinates workflow system concerns for the OriJS application.
 *
 * This coordinator manages the complete workflow lifecycle:
 * - Registration of workflow definitions and consumers
 * - Instantiation of consumers via dependency injection
 * - Provider lifecycle (start/stop)
 * - Creating executors for request-bound workflow access
 *
 * The definition-based API:
 * - Workflow definitions are registered with `registerWorkflowDefinition()`
 * - Consumers are registered with `addWorkflowConsumer()`
 * - On bootstrap, `registerConsumers()` instantiates consumers via DI
 *
 * @example
 * ```typescript
 * // Used internally by Application - not typically instantiated directly
 * const coordinator = new WorkflowCoordinator(logger, container);
 *
 * // Register a workflow definition
 * coordinator.registerWorkflowDefinition(SendEmailWorkflow);
 *
 * // Register a consumer for the workflow
 * coordinator.addWorkflowConsumer(SendEmailWorkflow, SendEmailConsumer, [EmailService]);
 *
 * // During bootstrap
 * coordinator.registerConsumers();
 * await coordinator.start();
 *
 * // Create executor for request context
 * const executor = coordinator.createExecutor();
 * await executor.execute(SendEmailWorkflow, { to: 'user@example.com' });
 * ```
 */
export class WorkflowCoordinator {
	/** The workflow provider (set via extension like addBullMQWorkflows) */
	private workflowProvider: WorkflowProvider | null = null;

	/** Registered workflow definitions (for validation) */
	private workflowDefinitions: Map<string, WorkflowDefinition<unknown, unknown>> = new Map();

	/** Pending consumer registrations (processed during bootstrap) */
	private pendingConsumers: PendingWorkflowConsumer[] = [];

	/** Instantiated consumers (after bootstrap) */
	private instantiatedConsumers: Map<string, InstantiatedWorkflowConsumer> = new Map();

	constructor(
		private readonly logger: Logger,
		private readonly container: Container,
		private readonly defaultProviderFactory: WorkflowProviderFactory = () => new InProcessWorkflowProvider()
	) {}

	/**
	 * Sets the workflow provider for the application.
	 * Called by extension functions (e.g., addBullMQWorkflows).
	 */
	public setProvider(provider: WorkflowProvider): void {
		if (this.workflowProvider) {
			this.logger.warn('Workflow provider already set, replacing with new provider');
		}
		this.workflowProvider = provider;
	}

	/**
	 * Returns the workflow provider (useful for testing and direct access).
	 * Returns null if no workflows configured.
	 */
	public getProvider(): WorkflowProvider | null {
		return this.workflowProvider;
	}

	/**
	 * Registers a workflow definition.
	 * This is called during app setup via .workflow(definition).
	 */
	public registerWorkflowDefinition<TData, TResult>(definition: WorkflowDefinition<TData, TResult>): void {
		const workflowName = definition.name;

		if (this.workflowDefinitions.has(workflowName)) {
			throw new Error(`Duplicate workflow registration: "${workflowName}" is already registered`);
		}

		this.workflowDefinitions.set(workflowName, definition as WorkflowDefinition<unknown, unknown>);
		this.logger.info(`Workflow Definition Registered -> [${workflowName}]`);
	}

	/**
	 * Adds a consumer for a workflow definition.
	 * Consumer will be instantiated during bootstrap via DI.
	 */
	public addWorkflowConsumer<TData, TResult>(
		definition: WorkflowDefinition<TData, TResult>,
		consumerClass: Constructor<IWorkflowConsumer<TData, TResult>>,
		deps: Constructor[]
	): void {
		this.pendingConsumers.push({
			definition: definition as WorkflowDefinition<unknown, unknown>,
			consumerClass: consumerClass as Constructor<IWorkflowConsumer<unknown, unknown>>,
			deps
		});
	}

	/**
	 * Instantiates all registered consumers via DI.
	 * Called during bootstrap after container is ready.
	 *
	 * Note: Full provider integration requires extending WorkflowProvider
	 * to support definition-based registration. For now, consumers are
	 * instantiated and stored for direct invocation.
	 */
	public registerConsumers(): void {
		// Ensure provider exists (use default if not set via extension)
		if (!this.workflowProvider) {
			if (this.pendingConsumers.length > 0 || this.workflowDefinitions.size > 0) {
				this.logger.debug('No workflow provider configured, using InProcessWorkflowProvider');
				this.workflowProvider = this.defaultProviderFactory();
			} else {
				// No workflows configured at all - skip
				return;
			}
		}

		// Process pending consumers - instantiate via DI
		for (const { definition, consumerClass, deps } of this.pendingConsumers) {
			const workflowName = definition.name;

			// Register consumer class with container
			this.container.register(consumerClass, deps as ConstructorDeps<typeof consumerClass>);
			const consumer = this.container.resolve<IWorkflowConsumer<unknown, unknown>>(consumerClass);

			// Detect misconfiguration: consumer expects steps but none are defined
			const hasConfigure = typeof (consumer as { configure?: unknown }).configure === 'function';
			const hasStepsProperty = consumer.steps && Object.keys(consumer.steps).length > 0;
			const hasStepsOnDefinition = definition.stepGroups && definition.stepGroups.length > 0;

			if (hasConfigure && !hasStepsOnDefinition) {
				throw new Error(
					`Workflow "${workflowName}": consumer has configure() but definition has no steps.\n` +
						`Steps must be defined on the WorkflowDefinition using .steps(), not in configure().\n` +
						`Example: Workflow.define({ ... }).steps(s => s.sequential('step1', 'step2'))`
				);
			}

			if (hasStepsOnDefinition && !hasStepsProperty) {
				const stepNames = definition.stepGroups.flatMap((g) => g.definitions.map((d) => d.name));
				throw new Error(
					`Workflow "${workflowName}": definition has steps [${stepNames.join(', ')}] but consumer has no handlers.\n` +
						`Add a 'steps' property to the consumer with execute handlers for each step.`
				);
			}

			// Store instantiated consumer for later use
			this.instantiatedConsumers.set(workflowName, {
				definition: definition as WorkflowDefinition<unknown, unknown>,
				consumer
			});

			// Register with provider so it creates workers (if provider supports it)
			if (this.workflowProvider.registerDefinitionConsumer) {
				// The handler is called AFTER all steps complete (or immediately if no steps)
				// Provider passes: data (workflow input), meta (propagation), stepResults (accumulated)
				const handler = async (data: unknown, meta?: unknown, stepResults?: Record<string, unknown>) => {
					// Validate input against schema
					if (!Value.Check(definition.dataSchema, data)) {
						const errors = [...Value.Errors(definition.dataSchema, data)];
						throw new Error(`Invalid workflow data: ${errors.map((e) => e.message).join(', ')}`);
					}

					// Extract or generate correlationId for distributed tracing
					const metaRecord = (meta as Record<string, unknown>) ?? {};
					const correlationId = (metaRecord.correlationId as string | undefined) ?? crypto.randomUUID();

					// Create workflow context for consumer's onComplete
					// stepResults contains accumulated results from all completed steps
					const ctx: WorkflowContext<unknown> = {
						flowId: `${workflowName}-${Date.now()}`,
						data: data as never,
						results: stepResults ?? {},
						log: this.logger.child(workflowName),
						meta: metaRecord,
						correlationId
					};

					// Invoke consumer's onComplete handler
					return consumer.onComplete(ctx);
				};

				// Extract step handlers from consumer.steps
				// Consumer provides: { stepName: { execute: fn, rollback?: fn } }
				const stepHandlers = consumer.steps as
					| Record<
							string,
							{
								execute: (ctx: unknown) => Promise<unknown>;
								rollback?: (ctx: unknown) => Promise<void> | void;
							}
					  >
					| undefined;

				// Pass step structure from definition + handlers from consumer
				// Cast: definition.stepGroups uses core's StepDefinition (structure only),
				// provider expects workflows' StepGroup (may have handler). This is safe
				// because provider checks for handlers via 'handler' in check, not via type.
				this.workflowProvider.registerDefinitionConsumer(
					workflowName,
					handler,
					definition.stepGroups as unknown as readonly WorkflowsStepGroup[],
					stepHandlers
				);
			}

			this.logger.info(`Workflow Consumer Registered -> [${workflowName}] [${consumerClass.name}]`);
		}

		this.pendingConsumers = [];

		// Register emitter-only workflows (definitions without consumers)
		if (this.workflowProvider.registerEmitterWorkflow) {
			for (const [workflowName] of this.workflowDefinitions) {
				if (!this.instantiatedConsumers.has(workflowName)) {
					this.workflowProvider.registerEmitterWorkflow(workflowName);
				}
			}
		}
	}

	/**
	 * Returns the instantiated consumer for a workflow.
	 * Used by workflow executors to invoke consumers with validated data.
	 */
	public getConsumer(workflowName: string): InstantiatedWorkflowConsumer | undefined {
		return this.instantiatedConsumers.get(workflowName);
	}

	/**
	 * Returns the workflow definition for a given name.
	 * Used by executors to validate data before execution.
	 */
	public getWorkflowDefinition(workflowName: string): WorkflowDefinition<unknown, unknown> | undefined {
		return this.workflowDefinitions.get(workflowName);
	}

	/**
	 * Returns all registered workflow names.
	 */
	public getRegisteredWorkflowNames(): string[] {
		return Array.from(this.workflowDefinitions.keys());
	}

	/**
	 * Starts the workflow provider.
	 */
	public async start(): Promise<void> {
		if (this.workflowProvider) {
			await this.workflowProvider.start();
			this.logger.debug('Workflow Provider Started');
		}
	}

	/**
	 * Stops the workflow provider.
	 */
	public async stop(): Promise<void> {
		if (this.workflowProvider) {
			await this.workflowProvider.stop();
		}
	}

	/**
	 * Returns whether workflows are configured.
	 */
	public isConfigured(): boolean {
		return this.workflowProvider !== null || this.workflowDefinitions.size > 0;
	}

	/**
	 * Creates a workflow executor for definition-based workflows.
	 *
	 * This executor wraps the underlying provider and handles WorkflowDefinition execution:
	 * - Looks up registered consumer and executes directly (if consumer exists)
	 * - Delegates to provider for emitter-only mode (if no consumer)
	 *
	 * @returns WorkflowExecutor that supports definition-based workflows
	 */
	public createExecutor(): WorkflowExecutor {
		const coordinator = this;
		const provider = this.workflowProvider;
		const logger = this.logger;

		return {
			async execute<TData, TResult>(
				workflow: WorkflowDefinition<TData, TResult>,
				data: TData
			): Promise<FlowHandle<TResult>> {
				if (!isWorkflowDefinition(workflow)) {
					throw new Error('Expected WorkflowDefinition. Class-based workflows are no longer supported.');
				}

				const workflowName = workflow.name;
				const registered = coordinator.getConsumer(workflowName);

				// If no consumer registered, delegate to provider (emitter-only mode)
				if (!registered) {
					if (!provider) {
						throw new Error(
							`Workflow '${workflowName}' has no consumer registered and no provider configured. ` +
								`Either register a consumer with app.workflow(definition).consumer(ConsumerClass), ` +
								`or configure a workflow provider for emitter-only mode.`
						);
					}
					// Validate input data against definition schema before emitting
					if (!Value.Check(workflow.dataSchema, data)) {
						const errors = [...Value.Errors(workflow.dataSchema, data)];
						const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
						throw new Error(`Workflow "${workflowName}" data validation failed: ${errorDetails}`);
					}
					// Delegate to provider - emitter-only, workflow will be consumed elsewhere
					return provider.execute(workflow, data);
				}

				const { definition, consumer } = registered;

				// Validate input data
				if (!Value.Check(definition.dataSchema, data)) {
					const errors = [...Value.Errors(definition.dataSchema, data)];
					const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
					throw new Error(`Workflow "${workflowName}" data validation failed: ${errorDetails}`);
				}

				// Generate workflow ID
				const flowId = `wf-${crypto.randomUUID()}`;

				// Get propagation metadata from AsyncLocalStorage context
				// This captures correlationId from the current request context (if within one)
				const meta = capturePropagationMeta() ?? {};

				// Extract or generate correlationId for distributed tracing
				const correlationId = (meta.correlationId as string | undefined) ?? crypto.randomUUID();

				// Create a logger with the propagation meta so ctx.log.propagationMeta() works
				const workflowLogger =
					Object.keys(meta).length > 0
						? Logger.fromMeta(workflowName, meta).with({ flowId })
						: logger.child(workflowName).with({ flowId });

				// Accumulated results from step execution
				const stepResults: Record<string, unknown> = {};

				// Track completed steps for rollback (in execution order)
				const completedSteps: Array<{
					name: string;
					handler: { rollback?: (ctx: unknown) => Promise<void> | void };
				}> = [];

				// Helper to execute rollbacks in reverse order
				const executeRollbacks = async (failedStepName: string, originalError: Error) => {
					workflowLogger.warn(
						`Step "${failedStepName}" failed, executing rollbacks for ${completedSteps.length} completed steps`
					);

					// Rollback in reverse order
					const stepsToRollback = [...completedSteps].reverse();
					for (const step of stepsToRollback) {
						if (step.handler.rollback) {
							try {
								const rollbackCtx = {
									flowId,
									data,
									results: { ...stepResults },
									log: workflowLogger.with({ step: step.name, rollback: true }),
									meta,
									stepName: step.name
								};
								await step.handler.rollback(rollbackCtx);
								workflowLogger.debug(`Rollback completed for step "${step.name}"`);
							} catch (rollbackError) {
								// Log rollback failure but continue with other rollbacks
								workflowLogger.error(`Rollback failed for step "${step.name}"`, {
									error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
								});
							}
						}
					}

					// Re-throw the original error after rollbacks complete
					throw originalError;
				};

				// Execute step handlers if definition has steps
				if (definition.stepGroups && definition.stepGroups.length > 0) {
					const stepHandlers = consumer.steps as
						| Record<
								string,
								{
									execute: (ctx: unknown) => Promise<unknown>;
									rollback?: (ctx: unknown) => Promise<void> | void;
								}
						  >
						| undefined;

					if (!stepHandlers) {
						throw new Error(
							`Workflow "${workflowName}": definition has steps but consumer has no step handlers`
						);
					}

					// Execute step groups in order
					for (const group of definition.stepGroups) {
						if (group.type === 'sequential') {
							// Sequential: execute one step at a time
							for (const stepDef of group.definitions) {
								const handler = stepHandlers[stepDef.name];
								if (!handler) {
									throw new Error(`Workflow "${workflowName}": no handler for step "${stepDef.name}"`);
								}

								const stepCtx = {
									flowId,
									data,
									results: { ...stepResults },
									log: workflowLogger.with({ step: stepDef.name }),
									meta,
									stepName: stepDef.name
								};

								try {
									const stepResult = await handler.execute(stepCtx);

									// Validate step output against schema
									if (!Value.Check(stepDef.outputSchema, stepResult)) {
										const errors = [...Value.Errors(stepDef.outputSchema, stepResult)];
										const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
										throw new Error(
											`Workflow "${workflowName}" step "${stepDef.name}" output validation failed: ${errorDetails}`
										);
									}

									stepResults[stepDef.name] = stepResult;
									completedSteps.push({ name: stepDef.name, handler });
								} catch (error) {
									await executeRollbacks(
										stepDef.name,
										error instanceof Error ? error : new Error(String(error))
									);
								}
							}
						} else {
							// Parallel: execute all steps concurrently
							const parallelPromises = group.definitions.map(async (stepDef) => {
								const handler = stepHandlers[stepDef.name];
								if (!handler) {
									throw new Error(`Workflow "${workflowName}": no handler for step "${stepDef.name}"`);
								}

								const stepCtx = {
									flowId,
									data,
									results: { ...stepResults },
									log: workflowLogger.with({ step: stepDef.name }),
									meta,
									stepName: stepDef.name
								};

								const stepResult = await handler.execute(stepCtx);

								// Validate step output against schema
								if (!Value.Check(stepDef.outputSchema, stepResult)) {
									const errors = [...Value.Errors(stepDef.outputSchema, stepResult)];
									const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
									throw new Error(
										`Workflow "${workflowName}" step "${stepDef.name}" output validation failed: ${errorDetails}`
									);
								}

								return { name: stepDef.name, result: stepResult, handler };
							});

							try {
								const parallelResults = await Promise.all(parallelPromises);
								for (const { name, result: stepResult, handler } of parallelResults) {
									stepResults[name] = stepResult;
									completedSteps.push({ name, handler });
								}
							} catch (error) {
								// For parallel steps, some may have completed - rollback those
								await executeRollbacks(
									'parallel-group',
									error instanceof Error ? error : new Error(String(error))
								);
							}
						}
					}
				}

				// Create context with accumulated step results
				const ctx: WorkflowContext<TData> = {
					flowId,
					data,
					results: stepResults,
					log: workflowLogger,
					meta,
					correlationId
				};

				// Execute consumer's onComplete handler
				const result = (await consumer.onComplete(ctx as WorkflowContext<unknown>)) as TResult;

				// Validate result
				if (!Value.Check(definition.resultSchema, result)) {
					const errors = [...Value.Errors(definition.resultSchema, result)];
					const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
					throw new Error(`Workflow "${workflowName}" result validation failed: ${errorDetails}`);
				}

				// Return a handle (workflow already completed at this point)
				return {
					id: flowId,
					async status(): Promise<FlowStatus> {
						return 'completed';
					},
					async result(): Promise<TResult> {
						return result;
					}
				};
			},

			async getStatus(flowId: string): Promise<FlowStatus> {
				if (!provider) {
					throw new Error('Workflow provider not configured');
				}
				return provider.getStatus(flowId);
			}
		};
	}
}
