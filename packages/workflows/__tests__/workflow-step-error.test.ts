/**
 * Unit Tests for WorkflowStepError
 *
 * Tests the error class that provides step context when workflow steps fail.
 */

import { describe, it, expect } from 'bun:test';
import { WorkflowStepError } from '../src/workflow.types.ts';

describe('WorkflowStepError', () => {
	describe('constructor', () => {
		it('should create error with step name and original error', () => {
			const originalError = new Error('Database connection failed');
			const stepError = new WorkflowStepError('save-to-db', originalError);

			expect(stepError).toBeInstanceOf(Error);
			expect(stepError).toBeInstanceOf(WorkflowStepError);
			expect(stepError.name).toBe('WorkflowStepError');
		});

		it('should format message with step name and original message', () => {
			const originalError = new Error('Validation failed');
			const stepError = new WorkflowStepError('validate-input', originalError);

			expect(stepError.message).toBe("Step 'validate-input' failed: Validation failed");
		});

		it('should preserve step name', () => {
			const originalError = new Error('Something went wrong');
			const stepError = new WorkflowStepError('process-payment', originalError);

			expect(stepError.stepName).toBe('process-payment');
		});

		it('should preserve original error as cause', () => {
			const originalError = new Error('Network timeout');
			originalError.name = 'NetworkError';
			const stepError = new WorkflowStepError('fetch-data', originalError);

			expect(stepError.cause).toBe(originalError);
			expect(stepError.cause.message).toBe('Network timeout');
			expect(stepError.cause.name).toBe('NetworkError');
		});
	});

	describe('stack trace', () => {
		it('should include "Caused by" section with original stack', () => {
			const originalError = new Error('Original failure');
			const stepError = new WorkflowStepError('failing-step', originalError);

			expect(stepError.stack).toBeDefined();
			expect(stepError.stack).toContain('Caused by:');
			expect(stepError.stack).toContain('Original failure');
		});

		it('should handle original error without stack trace', () => {
			const originalError = new Error('No stack');
			originalError.stack = undefined;
			const stepError = new WorkflowStepError('no-stack-step', originalError);

			// Should not throw, should still have its own stack
			expect(stepError.stack).toBeDefined();
			expect(stepError.stack).not.toContain('Caused by:');
		});
	});

	describe('instanceof checks', () => {
		it('should be catchable as Error', () => {
			const originalError = new Error('Test');
			const stepError = new WorkflowStepError('test-step', originalError);

			let caughtAsError = false;
			try {
				throw stepError;
			} catch (e) {
				if (e instanceof Error) {
					caughtAsError = true;
				}
			}

			expect(caughtAsError).toBe(true);
		});

		it('should be catchable as WorkflowStepError', () => {
			const originalError = new Error('Test');
			const stepError = new WorkflowStepError('test-step', originalError);

			let caughtAsStepError = false;
			try {
				throw stepError;
			} catch (e) {
				if (e instanceof WorkflowStepError) {
					caughtAsStepError = true;
				}
			}

			expect(caughtAsStepError).toBe(true);
		});
	});

	describe('edge cases', () => {
		it('should handle empty step name', () => {
			const originalError = new Error('Failed');
			const stepError = new WorkflowStepError('', originalError);

			expect(stepError.stepName).toBe('');
			expect(stepError.message).toBe("Step '' failed: Failed");
		});

		it('should handle step name with special characters', () => {
			const originalError = new Error('Failed');
			const stepError = new WorkflowStepError("notify-user's-email", originalError);

			expect(stepError.stepName).toBe("notify-user's-email");
			expect(stepError.message).toContain("notify-user's-email");
		});

		it('should handle empty original error message', () => {
			const originalError = new Error('');
			const stepError = new WorkflowStepError('empty-message-step', originalError);

			expect(stepError.message).toBe("Step 'empty-message-step' failed: ");
			expect(stepError.cause.message).toBe('');
		});
	});
});
