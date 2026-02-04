/**
 * @orijs/bullmq - BullMQ event and workflow providers for OriJS.
 *
 * Provides production-ready distributed event and workflow execution
 * using BullMQ queues and Redis.
 *
 * @module @orijs/bullmq
 */

// Re-export Redis for type consistency (avoids ioredis version mismatches)
export { Redis } from '@orijs/cache-redis';

// Event Provider
export { BullMQEventProvider, type BullMQEventProviderOptions } from './events/bullmq-event-provider';

// Workflow Provider
export {
	BullMQWorkflowProvider,
	createBullMQWorkflowProvider,
	type BullMQWorkflowProviderOptions,
	type BullMQWorkflowOptions
} from './workflows/bullmq-workflow-provider';
