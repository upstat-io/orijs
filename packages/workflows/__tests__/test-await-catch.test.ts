import { describe, it, expect } from 'bun:test';

// Test if awaiting a rejected promise inside try/catch triggers Bun's error tracking
describe('Await catch behavior', () => {
	it('should handle await on rejected promise inside try/catch', async () => {
		let resultPromise: Promise<string>;
		let reject: (e: Error) => void;

		resultPromise = new Promise<string>((_, rej) => {
			reject = rej;
		});
		resultPromise.catch(() => {});

		// Execute async
		(async () => {
			async function getStepResult(): Promise<string> {
				return Promise.reject(new Error('Step failed'));
			}

			try {
				const promise = getStepResult();
				const result = await Promise.resolve(promise); // Just like the real code
				return result;
			} catch (err: unknown) {
				// Create wrapped error
				const wrapped = new Error(`Wrapped: ${(err as Error).message}`);
				reject!(wrapped);
				return;
			}
		})();

		await expect(resultPromise).rejects.toThrow('Wrapped: Step failed');
	});
});
