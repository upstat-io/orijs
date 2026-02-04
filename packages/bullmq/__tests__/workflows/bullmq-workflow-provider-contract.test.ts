/**
 * BullMQ WorkflowProvider Contract Tests
 *
 * This file runs the shared contract tests against the BullMQ provider.
 * All WorkflowProvider implementations must pass the same contract tests
 * to ensure feature parity across providers.
 *
 * See @orijs/workflows/__tests__/contract/ for the shared test suite.
 */

import {
	workflowProviderContractTests,
	type ProviderConfig
} from '../../../workflows/__tests__/contract/index.ts';
import { getRedisConnectionOptions, isRedisReady } from '../preload.ts';
import { BullMQWorkflowProvider } from '../../src/workflows/bullmq-workflow-provider.ts';

// Ensure Redis is ready before running tests
if (!isRedisReady()) {
	throw new Error('Redis container not ready for BullMQ contract tests');
}

// Generate unique suffix per test file instance to prevent parallel test file interference
const testFileId = Math.random().toString(36).substring(2, 8);
let testCounter = 0;

// ============================================================
// CONTRACT TESTS - Run shared test suite for BullMQWorkflowProvider
// ============================================================
workflowProviderContractTests({
	providerName: 'BullMQWorkflowProvider',
	createProvider: async () => {
		// NOTE: We don't flush Redis as it would interfere with parallel test files
		// Unique queue prefixes per test provide sufficient isolation
		const connection = getRedisConnectionOptions();
		const uniquePrefix = `contract-${testFileId}-${++testCounter}`;
		return new BullMQWorkflowProvider({ connection, queuePrefix: uniquePrefix });
	},
	createProviderWithConfig: async (config: ProviderConfig) => {
		// NOTE: We don't flush Redis as it would interfere with parallel test files
		// Unique queue prefixes per test provide sufficient isolation
		const connection = getRedisConnectionOptions();
		const uniquePrefix = `contract-cfg-${testFileId}-${++testCounter}`;

		// When timeout is specified, we need to also set stallInterval to minimum (5000ms)
		// because effectiveTimeout = timeoutMs + stallInterval. Without this, very short
		// timeouts like 30ms become 30030ms (30 + 30000 default stallInterval).
		const stallInterval = config.timeoutMs !== undefined ? 5000 : undefined;

		return new BullMQWorkflowProvider({
			connection,
			queuePrefix: uniquePrefix,
			defaultTimeout: config.timeoutMs,
			stallInterval,
			logger: config.logger
		});
	},
	cleanup: async () => {
		// Redis cleanup handled by testcontainers
	},
	timeout: 15000, // BullMQ needs longer timeout for distributed operations
	// BullMQ adds stallInterval to user timeouts for worker crash recovery
	// Tests need to account for this when checking timeout behavior
	timeoutOverhead: 5000 // Minimum stallInterval value
});
