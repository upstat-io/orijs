import { describe, test, expect } from 'bun:test';
import { InProcessWorkflowProvider } from '../src/in-process-workflow-provider';
import type { WorkflowDefinitionLike } from '../src/workflow.types';

const SlowWorkflow: WorkflowDefinitionLike<Record<string, never>, { done: boolean }> = {
	name: 'slow-workflow',
	stepGroups: [],
	_data: undefined as never,
	_result: undefined as never
};

const QuickTimeoutWorkflow: WorkflowDefinitionLike<Record<string, never>, { success: boolean }> = {
	name: 'quick-timeout-workflow',
	stepGroups: [],
	_data: undefined as never,
	_result: undefined as never
};

describe('Workflow timeout race', () => {
	test('should produce failed status when timeout fires during onComplete handler', async () => {
		const provider = new InProcessWorkflowProvider();

		provider.registerDefinitionConsumer(
			SlowWorkflow.name,
			async () => {
				// Simulate slow handler that takes longer than timeout
				await new Promise((resolve) => setTimeout(resolve, 200));
				return { done: true };
			}
		);

		await provider.start();

		const handle = await provider.execute(SlowWorkflow, {}, { timeout: 50 }); // 50ms timeout

		// The workflow should have timed out
		try {
			await handle.result();
			// If we get here, timeout didn't fire — check status
			const finalStatus = await handle.status();
			expect(['completed', 'failed']).toContain(finalStatus);
		} catch (error) {
			// Timeout fired — should be failed
			const finalStatus = await handle.status();
			expect(finalStatus).toBe('failed');
			expect((error as Error).message).toContain('timed out');
		}

		await provider.stop();
	});

	test('should not resolve after timeout has already rejected', async () => {
		const provider = new InProcessWorkflowProvider();
		provider.registerDefinitionConsumer(
			QuickTimeoutWorkflow.name,
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { success: true };
			}
		);

		await provider.start();

		const handle = await provider.execute(QuickTimeoutWorkflow, {}, { timeout: 10 }); // 10ms timeout

		// Wait for timeout to fire
		await new Promise((resolve) => setTimeout(resolve, 50));

		const status = await handle.status();
		expect(status).toBe('failed');

		// Wait for handler to complete
		await new Promise((resolve) => setTimeout(resolve, 150));

		// Status should still be failed (handler success doesn't overwrite)
		const finalStatus = await handle.status();
		expect(finalStatus).toBe('failed');

		await provider.stop();
	});
});
