/**
 * Multi-Instance Test Utilities for BullMQ Workflow Provider
 *
 * Provides infrastructure for testing distributed workflow execution
 * across multiple provider instances sharing the same Redis.
 */

import {
	BullMQWorkflowProvider,
	type BullMQWorkflowProviderOptions
} from '../../src/workflows/bullmq-workflow-provider.ts';
import type { StepGroup } from '@orijs/workflows';
import type { PropagationMeta } from '@orijs/logging';

/**
 * Entry in the execution log tracking which instance executed what.
 */
export interface ExecutionLogEntry {
	readonly instanceName: string;
	readonly workflowName: string;
	readonly stepName: string;
	readonly action: 'execute' | 'rollback';
	readonly timestamp: number;
	readonly data?: unknown;
}

/**
 * Shared execution log that all instances write to.
 * Uses a closure-captured array so all instances see the same log.
 */
export interface SharedExecutionLog {
	readonly entries: ExecutionLogEntry[];
	log(entry: Omit<ExecutionLogEntry, 'timestamp'>): void;
	clear(): void;
	getEntriesForInstance(instanceName: string): ExecutionLogEntry[];
	getEntriesForStep(stepName: string): ExecutionLogEntry[];
	waitForEntries(count: number, timeoutMs?: number): Promise<void>;
}

/**
 * Creates a shared execution log for tracking step execution across instances.
 */
export function createSharedExecutionLog(): SharedExecutionLog {
	const entries: ExecutionLogEntry[] = [];

	return {
		entries,
		log(entry: Omit<ExecutionLogEntry, 'timestamp'>): void {
			entries.push({ ...entry, timestamp: Date.now() });
		},
		clear(): void {
			entries.length = 0;
		},
		getEntriesForInstance(instanceName: string): ExecutionLogEntry[] {
			return entries.filter((e) => e.instanceName === instanceName);
		},
		getEntriesForStep(stepName: string): ExecutionLogEntry[] {
			return entries.filter((e) => e.stepName === stepName);
		},
		async waitForEntries(count: number, timeoutMs = 10000): Promise<void> {
			const start = Date.now();
			while (entries.length < count) {
				if (Date.now() - start > timeoutMs) {
					throw new Error(`Timeout waiting for ${count} entries, got ${entries.length}`);
				}
				await new Promise((r) => setTimeout(r, 50));
			}
		}
	};
}

/**
 * Options for creating a provider instance in the harness.
 */
export interface InstanceOptions {
	/** Custom stall interval for faster instance death detection in tests */
	readonly stallInterval?: number;
	/** Whether this instance should have workers disabled (caller-only mode) */
	readonly workersDisabled?: boolean;
}

/**
 * Consumer registration for definition-based workflows.
 */
interface ConsumerRegistration {
	workflowName: string;
	handler: (data: unknown, meta?: PropagationMeta, stepResults?: Record<string, unknown>) => Promise<unknown>;
	stepGroups?: readonly StepGroup[];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	stepHandlers?: Record<string, { execute: (ctx: any) => any; rollback?: (ctx: any) => any }>;
}

/**
 * Multi-instance test harness for distributed workflow testing.
 *
 * Creates multiple BullMQWorkflowProvider instances that share the same Redis,
 * allowing tests to verify distributed execution patterns.
 */
export class MultiInstanceTestHarness {
	private readonly instances: Map<string, BullMQWorkflowProvider> = new Map();
	private readonly baseConnectionOptions: { host: string; port: number };
	private readonly queuePrefix: string;
	private readonly registeredConsumers: ConsumerRegistration[] = [];

	constructor(connectionOptions: { host: string; port: number }, queuePrefix: string) {
		this.baseConnectionOptions = connectionOptions;
		this.queuePrefix = queuePrefix;
	}

	/**
	 * Register a definition-based consumer that will be registered on all instances.
	 * Must be called before createInstance().
	 */
	registerConsumer(
		workflowName: string,
		handler: (
			data: unknown,
			meta?: PropagationMeta,
			stepResults?: Record<string, unknown>
		) => Promise<unknown>,
		stepGroups?: readonly StepGroup[],
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		stepHandlers?: Record<string, { execute: (ctx: any) => any; rollback?: (ctx: any) => any }>
	): void {
		this.registeredConsumers.push({ workflowName, handler, stepGroups, stepHandlers });
	}

	/**
	 * Create a new provider instance with the given name.
	 * All instances share the same Redis connection and queue prefix.
	 * The instance name is passed as providerId for distributed tracing.
	 */
	createInstance(name: string, options?: InstanceOptions): BullMQWorkflowProvider {
		if (this.instances.has(name)) {
			throw new Error(`Instance '${name}' already exists`);
		}

		const providerOptions: BullMQWorkflowProviderOptions = {
			connection: this.baseConnectionOptions,
			queuePrefix: this.queuePrefix,
			stallInterval: options?.stallInterval ?? 5000, // Minimum 5000ms per stallInterval validation
			providerId: name // Use instance name as providerId for test verification
		};

		const provider = new BullMQWorkflowProvider(providerOptions);

		// Register all consumers on this instance
		for (const consumer of this.registeredConsumers) {
			provider.registerDefinitionConsumer(
				consumer.workflowName,
				consumer.handler,
				consumer.stepGroups,
				consumer.stepHandlers
			);
		}

		this.instances.set(name, provider);
		return provider;
	}

	/**
	 * Get a provider instance by name.
	 */
	getInstance(name: string): BullMQWorkflowProvider {
		const instance = this.instances.get(name);
		if (!instance) {
			throw new Error(`Instance '${name}' not found`);
		}
		return instance;
	}

	/**
	 * Get all instance names.
	 */
	getInstanceNames(): string[] {
		return Array.from(this.instances.keys());
	}

	/**
	 * Start all instances.
	 */
	async startAll(): Promise<void> {
		await Promise.all(Array.from(this.instances.values()).map((instance) => instance.start()));
	}

	/**
	 * Start a specific instance.
	 */
	async startInstance(name: string): Promise<void> {
		const instance = this.getInstance(name);
		await instance.start();
	}

	/**
	 * Stop a specific instance (simulates instance crash/shutdown).
	 */
	async stopInstance(name: string): Promise<void> {
		const instance = this.getInstance(name);
		await instance.stop();
	}

	/**
	 * Stop all instances.
	 */
	async stopAll(): Promise<void> {
		await Promise.all(Array.from(this.instances.values()).map((instance) => instance.stop()));
		this.instances.clear();
	}

	/**
	 * Get the number of active instances.
	 */
	get instanceCount(): number {
		return this.instances.size;
	}
}

// Re-export async helpers from @orijs/test-utils for convenience
export { waitFor, withTimeout, delay } from '@orijs/test-utils';
