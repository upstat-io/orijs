/**
 * Request-bound emitters for ctx.events and ctx.workflows.
 *
 * These implementations wrap the underlying providers and bind them
 * to the request context for correlation ID propagation.
 */

import type { PropagationMeta, Logger } from '@orijs/logging';
import { Value } from '@orijs/validation';
import type { EventDefinition } from '../types/event-definition.ts';
import type { WorkflowDefinition } from '../types/workflow-definition.ts';
import type {
	EventEmitter,
	WorkflowExecutor,
	WorkflowHandle,
	WorkflowExecuteOptions,
	WorkflowStatus,
	SocketEmitter
} from '../types/emitter.ts';
import type { SocketMessageLike } from '@orijs/websocket';
import type { EventCoordinator } from '../event-coordinator.ts';
import type { WorkflowCoordinator } from '../workflow-coordinator.ts';

/**
 * Request context info needed for binding emitters.
 */
export interface RequestBindingContext {
	/** Request ID for correlation */
	readonly correlationId: string;
	/** Logger for error reporting */
	readonly logger: Logger;
}

/**
 * Request-bound event emitter implementation.
 *
 * Wraps the EventCoordinator's provider and adds:
 * - Request ID as correlation metadata
 * - TypeBox validation of payloads before emission
 * - Type-safe definition-based emit
 */
export class RequestBoundEventEmitter implements EventEmitter {
	constructor(
		private readonly eventCoordinator: EventCoordinator,
		private readonly context: RequestBindingContext
	) {}

	/**
	 * Emit an event with type-safe payload.
	 *
	 * The payload is validated against the event's TypeBox schema before
	 * being sent to the underlying provider. The request ID is propagated
	 * as correlation metadata for distributed tracing.
	 */
	public async emit<TPayload, TResponse>(
		event: EventDefinition<TPayload, TResponse>,
		payload: TPayload
	): Promise<TResponse> {
		const provider = this.eventCoordinator.getProvider();
		if (!provider) {
			throw new Error(
				`Cannot emit event "${event.name}": no event provider configured. ` +
					`Call .use(addBullMQEvents) or configure a provider before emitting events.`
			);
		}

		// Check if event is registered (either as definition or has consumer)
		const definition = this.eventCoordinator.getEventDefinition(event.name);
		if (!definition) {
			throw new Error(
				`Cannot emit event "${event.name}": event not registered. ` +
					`Register with .event(${event.name}) before emitting.`
			);
		}

		// Validate payload against TypeBox schema
		if (!Value.Check(event.dataSchema, payload)) {
			const errors = [...Value.Errors(event.dataSchema, payload)];
			const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
			throw new Error(`Event "${event.name}" payload validation failed: ${errorDetails}`);
		}

		// Create propagation meta with request binding
		// For request-initiated events, the request ID is both correlation and causation
		const meta: PropagationMeta = {
			correlationId: this.context.correlationId,
			causationId: this.context.correlationId
		};

		// Emit via underlying provider
		// The EventSubscription is thenable, so await works directly
		const subscription = provider.emit<TResponse>(event.name, payload, meta);

		return subscription;
	}
}

/**
 * Null workflow handle for when workflows are not configured.
 */
class NullWorkflowHandle<TResult> implements WorkflowHandle<TResult> {
	public readonly id: string;

	constructor(workflowName: string) {
		this.id = `null-${workflowName}-${Date.now()}`;
	}

	public async status(): Promise<WorkflowStatus> {
		return 'failed';
	}

	public async result(): Promise<TResult> {
		throw new Error('Workflow failed: no workflow provider configured');
	}

	public async cancel(): Promise<boolean> {
		return false;
	}
}

/**
 * Simple in-memory workflow handle for direct consumer invocation.
 *
 * Note: Full provider integration (BullMQ) requires extending WorkflowProvider
 * to support definition-based execution. For now, workflows use direct
 * consumer invocation with this simple handle.
 */
class DirectInvocationHandle<TResult> implements WorkflowHandle<TResult> {
	public readonly id: string;
	private state: 'running' | 'completed' | 'failed' = 'running';
	private resultValue: TResult | undefined;
	private error: Error | undefined;
	private resolvers: Array<{ resolve: (value: TResult) => void; reject: (error: Error) => void }> = [];

	constructor(workflowName: string) {
		this.id = `${workflowName}-${crypto.randomUUID()}`;
	}

	public async status(): Promise<WorkflowStatus> {
		return this.state;
	}

	public async result(): Promise<TResult> {
		if (this.state === 'completed' && this.resultValue !== undefined) {
			return this.resultValue;
		}
		if (this.state === 'failed' && this.error) {
			throw this.error;
		}

		// Wait for completion
		return new Promise<TResult>((resolve, reject) => {
			this.resolvers.push({ resolve, reject });
		});
	}

	public async cancel(): Promise<boolean> {
		// Direct invocation doesn't support cancellation
		return false;
	}

	/** @internal - Called when workflow completes */
	public _complete(result: TResult): void {
		this.state = 'completed';
		this.resultValue = result;
		for (const { resolve } of this.resolvers) {
			resolve(result);
		}
		this.resolvers = [];
	}

	/** @internal - Called when workflow fails */
	public _fail(error: Error): void {
		this.state = 'failed';
		this.error = error;
		for (const { reject } of this.resolvers) {
			reject(error);
		}
		this.resolvers = [];
	}
}

/**
 * Request-bound workflow executor implementation.
 *
 * Wraps the WorkflowCoordinator and provides direct consumer invocation
 * with request context binding. Full provider integration (BullMQ queuing)
 * requires extending WorkflowProvider to support definition-based execution.
 */
export class RequestBoundWorkflowExecutor implements WorkflowExecutor {
	constructor(
		private readonly workflowCoordinator: WorkflowCoordinator,
		private readonly context: RequestBindingContext
	) {}

	/**
	 * Execute a workflow with type-safe input data.
	 *
	 * The data is validated against the workflow's TypeBox schema before
	 * execution. Uses direct consumer invocation - the consumer's onComplete
	 * method is called directly.
	 *
	 * Note: For production use with BullMQ, the WorkflowProvider interface
	 * needs to be extended to support definition-based execution.
	 */
	public async execute<TData, TResult>(
		workflow: WorkflowDefinition<TData, TResult>,
		data: TData,
		_options?: WorkflowExecuteOptions
	): Promise<WorkflowHandle<TResult>> {
		// Check if workflow has a registered consumer
		const consumerEntry = this.workflowCoordinator.getConsumer(workflow.name);
		if (!consumerEntry) {
			// Check if workflow is at least defined (emitter-only)
			const definition = this.workflowCoordinator.getWorkflowDefinition(workflow.name);
			if (!definition) {
				throw new Error(
					`Cannot execute workflow "${workflow.name}": workflow not registered. ` +
						`Register with .workflow(${workflow.name}) before executing.`
				);
			}

			// Workflow defined but no consumer - can't execute
			this.context.logger.warn(
				`Cannot execute workflow "${workflow.name}": no consumer registered. ` + `Returning null handle.`
			);
			return new NullWorkflowHandle<TResult>(workflow.name);
		}

		// Validate data against TypeBox schema
		if (!Value.Check(workflow.dataSchema, data)) {
			const errors = [...Value.Errors(workflow.dataSchema, data)];
			const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
			throw new Error(`Workflow "${workflow.name}" data validation failed: ${errorDetails}`);
		}

		// Create handle for tracking execution
		const handle = new DirectInvocationHandle<TResult>(workflow.name);

		// Execute asynchronously via direct consumer invocation
		// Note: This is synchronous/in-process - BullMQ integration would queue instead
		this.executeConsumer(consumerEntry.consumer, data, workflow.name, handle).catch((error) => {
			// Errors are captured in the handle
			// Defensive try/catch to prevent unhandled rejection if logger throws
			try {
				this.context.logger.error(`Workflow "${workflow.name}" execution failed`, { error });
			} catch {
				// Swallow logger errors to prevent unhandled rejection
			}
		});

		return handle;
	}

	/**
	 * Execute the consumer's onComplete method directly.
	 */
	private async executeConsumer<TData, TResult>(
		consumer: { onComplete(ctx: unknown): Promise<unknown> | unknown },
		data: TData,
		_workflowName: string,
		handle: DirectInvocationHandle<TResult>
	): Promise<void> {
		try {
			// Create minimal workflow context
			// Note: Full WorkflowContext from @orijs/workflows would have more features
			const ctx = {
				data,
				results: {},
				log: this.context.logger,
				meta: { correlationId: this.context.correlationId },
				getResult: <T>(_stepName: string): T => {
					throw new Error('getResult not available in direct invocation mode');
				}
			};

			const result = (await consumer.onComplete(ctx)) as TResult;
			handle._complete(result);
		} catch (error) {
			handle._fail(error instanceof Error ? error : new Error(String(error)));
		}
	}
}

/**
 * Request-bound socket emitter implementation.
 *
 * Wraps the SocketEmitter and binds it to the request context for:
 * - Consistent error messages with other request-bound emitters
 * - Correlation ID available for future tracing enhancements
 * - Caching pattern consistency with events/workflows
 *
 * Note: WebSocket messages are typically fire-and-forget, so correlation
 * IDs are not automatically injected into messages. Applications can
 * include the correlationId in their message payloads if needed.
 */
export class RequestBoundSocketEmitter implements SocketEmitter {
	/** Correlation ID from the request context, available for message payloads */
	public readonly correlationId: string;

	constructor(
		private readonly emitter: SocketEmitter,
		context: RequestBindingContext
	) {
		this.correlationId = context.correlationId;
	}

	/**
	 * Publishes a message to all subscribers of a topic.
	 */
	public publish(topic: string, message: string | ArrayBuffer): Promise<void> {
		return this.emitter.publish(topic, message);
	}

	/**
	 * Sends a message directly to a specific socket.
	 */
	public send(socketId: string, message: string | ArrayBuffer): void {
		this.emitter.send(socketId, message);
	}

	/**
	 * Broadcasts a message to all connected sockets.
	 */
	public broadcast(message: string | ArrayBuffer): void {
		this.emitter.broadcast(message);
	}

	/**
	 * Emits a typed socket message to a topic with runtime validation.
	 *
	 * Delegates to the underlying emitter which handles validation and
	 * serialization. The message is serialized as JSON with format:
	 * { name, data, timestamp }.
	 */
	public emit<TData>(message: SocketMessageLike<TData>, topic: string, data: TData): Promise<void> {
		return this.emitter.emit(message, topic, data);
	}
}
