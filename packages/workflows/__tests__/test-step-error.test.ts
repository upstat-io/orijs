import { describe, it, expect } from 'bun:test';
import { WorkflowStepError } from '../src/workflow.types.ts';

describe('StepError behavior', () => {
	it('should handle WorkflowStepError', async () => {
		let resultPromise: Promise<string>;
		let reject: (e: Error) => void;

		resultPromise = new Promise<string>((_, rej) => {
			reject = rej;
		});
		resultPromise.catch(() => {});

		(async () => {
			async function getStepResult(): Promise<string> {
				return Promise.reject(new Error('Step failed'));
			}

			try {
				const promise = getStepResult();
				await Promise.resolve(promise);
			} catch (err: unknown) {
				const wrapped = new WorkflowStepError('test-step', err as Error);
				reject!(wrapped);
				return;
			}
		})();

		await expect(resultPromise).rejects.toThrow("Step 'test-step' failed:");
	});
});
