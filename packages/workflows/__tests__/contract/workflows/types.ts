/**
 * Shared types for contract test workflows.
 *
 * @module contract/workflows/types
 */

/**
 * Common test data type used across workflow tests.
 */
export interface TestOrderData {
	orderId: string;
	amount: number;
}

/**
 * Execution log for tracking step/rollback execution order.
 */
export type ExecutionLog = string[];
