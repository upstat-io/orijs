/**
 * Contract test exports.
 *
 * Import these to run the shared WorkflowProvider contract tests against any provider.
 *
 * @module contract
 *
 * @example
 * ```typescript
 * import { workflowProviderContractTests } from '@orijs/workflows/__tests__/contract';
 *
 * workflowProviderContractTests({
 *   providerName: 'MyProvider',
 *   createProvider: async () => new MyProvider(),
 *   cleanup: async () => {},
 * });
 * ```
 */

export {
	workflowProviderContractTests,
	type ContractTestConfig,
	type ProviderConfig
} from './workflow-provider.contract';
export * from './workflows/index';
