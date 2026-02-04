/**
 * Tests for InProcessWorkflowProvider
 *
 * This file runs the shared contract tests against the InProcess provider.
 * All WorkflowProvider implementations must pass the same contract tests
 * to ensure feature parity across providers.
 *
 * See __tests__/contract/ for the shared test suite.
 */

import { Logger } from '@orijs/logging';

import { InProcessWorkflowProvider } from '../src/in-process-workflow-provider.ts';
import { workflowProviderContractTests, type ProviderConfig } from './contract/index';

// ============================================================
// CONTRACT TESTS - Run shared test suite for InProcessWorkflowProvider
// ============================================================
workflowProviderContractTests({
	providerName: 'InProcessWorkflowProvider',
	createProvider: async () => new InProcessWorkflowProvider(),
	createProviderWithConfig: async (config: ProviderConfig) => {
		const providerConfig: { logger?: Logger; defaultTimeout?: number } = {};

		if (config.logger) {
			providerConfig.logger = config.logger;
		}

		if (config.timeoutMs !== undefined) {
			providerConfig.defaultTimeout = config.timeoutMs;
		}

		// If we have any config, pass the config object
		if (Object.keys(providerConfig).length > 0) {
			return new InProcessWorkflowProvider(providerConfig);
		}

		return new InProcessWorkflowProvider();
	},
	cleanup: async () => {},
	timeout: 5000
});
