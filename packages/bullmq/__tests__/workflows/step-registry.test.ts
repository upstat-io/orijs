/**
 * StepRegistry Unit Tests
 *
 * Tests the step handler registration and lookup for workflow step execution.
 */

import { describe, it, expect } from 'bun:test';
import { StepRegistry, StepNotFoundError, createStepRegistry } from '../../src/workflows/step-registry.ts';
import type { StepHandler, RollbackHandler } from '@orijs/workflows';

describe('StepRegistry', () => {
	describe('register', () => {
		it('should register a step handler', () => {
			const registry = new StepRegistry();
			const handler: StepHandler = async () => ({ result: 'test' });

			registry.register('TestWorkflow', 'step1', handler);

			expect(registry.has('TestWorkflow', 'step1')).toBe(true);
		});

		it('should register multiple steps for the same workflow', () => {
			const registry = new StepRegistry();
			const validateHandler: StepHandler = async () => ({ result: 1 });
			const processHandler: StepHandler = async () => ({ result: 2 });

			registry.register('TestWorkflow', 'validate', validateHandler);
			registry.register('TestWorkflow', 'process', processHandler);

			expect(registry.has('TestWorkflow', 'validate')).toBe(true);
			expect(registry.has('TestWorkflow', 'process')).toBe(true);
		});

		it('should register steps for different workflows', () => {
			const registry = new StepRegistry();
			const workflow1Handler: StepHandler = async () => ({ wf: 1 });
			const workflow2Handler: StepHandler = async () => ({ wf: 2 });

			registry.register('Workflow1', 'step1', workflow1Handler);
			registry.register('Workflow2', 'step1', workflow2Handler);

			expect(registry.has('Workflow1', 'step1')).toBe(true);
			expect(registry.has('Workflow2', 'step1')).toBe(true);
		});

		it('should overwrite handler if registering same step twice', () => {
			const registry = new StepRegistry();
			const originalHandler: StepHandler = async () => ({ v: 1 });
			const replacementHandler: StepHandler = async () => ({ v: 2 });

			registry.register('TestWorkflow', 'step1', originalHandler);
			registry.register('TestWorkflow', 'step1', replacementHandler);

			const retrieved = registry.get('TestWorkflow', 'step1');
			expect(retrieved).toBe(replacementHandler);
		});
	});

	describe('get', () => {
		it('should return registered handler', () => {
			const registry = new StepRegistry();
			const handler: StepHandler = async () => ({ found: true });

			registry.register('TestWorkflow', 'step1', handler);

			const retrieved = registry.get('TestWorkflow', 'step1');
			expect(retrieved).toBe(handler);
		});

		it('should throw StepNotFoundError when workflow is unregistered', () => {
			const registry = new StepRegistry();

			expect(() => registry.get('UnknownWorkflow', 'step1')).toThrow(StepNotFoundError);
			expect(() => registry.get('UnknownWorkflow', 'step1')).toThrow(
				"Step 'step1' not found for workflow 'UnknownWorkflow'"
			);
		});

		it('should throw StepNotFoundError when step is unregistered', () => {
			const registry = new StepRegistry();
			registry.register('TestWorkflow', 'step1', async () => ({}));

			expect(() => registry.get('TestWorkflow', 'unknown')).toThrow(StepNotFoundError);
			expect(() => registry.get('TestWorkflow', 'unknown')).toThrow(
				"Step 'unknown' not found for workflow 'TestWorkflow'"
			);
		});
	});

	describe('has', () => {
		it('should return true when step is registered', () => {
			const registry = new StepRegistry();
			registry.register('TestWorkflow', 'step1', async () => ({}));

			expect(registry.has('TestWorkflow', 'step1')).toBe(true);
		});

		it('should return false when workflow is unregistered', () => {
			const registry = new StepRegistry();

			expect(registry.has('UnknownWorkflow', 'step1')).toBe(false);
		});

		it('should return false when step is unregistered', () => {
			const registry = new StepRegistry();
			registry.register('TestWorkflow', 'step1', async () => ({}));

			expect(registry.has('TestWorkflow', 'step2')).toBe(false);
		});
	});

	describe('getWorkflowSteps', () => {
		it('should return all step names for a workflow', () => {
			const registry = new StepRegistry();
			registry.register('TestWorkflow', 'validate', async () => ({}));
			registry.register('TestWorkflow', 'process', async () => ({}));
			registry.register('TestWorkflow', 'notify', async () => ({}));

			const steps = registry.getWorkflowSteps('TestWorkflow');

			expect(steps.sort()).toEqual(['notify', 'process', 'validate']);
		});

		it('should return empty array when workflow is unknown', () => {
			const registry = new StepRegistry();

			const steps = registry.getWorkflowSteps('UnknownWorkflow');

			expect(steps).toEqual([]);
		});
	});

	describe('clear', () => {
		it('should remove all registered handlers', () => {
			const registry = new StepRegistry();
			registry.register('Workflow1', 'step1', async () => ({}));
			registry.register('Workflow2', 'step2', async () => ({}));

			registry.clear();

			expect(registry.has('Workflow1', 'step1')).toBe(false);
			expect(registry.has('Workflow2', 'step2')).toBe(false);
		});
	});

	describe('getStep', () => {
		it('should return full step info including handler', () => {
			const registry = new StepRegistry();
			const handler: StepHandler = async () => ({ result: true });

			registry.register('TestWorkflow', 'step1', handler);

			const step = registry.getStep('TestWorkflow', 'step1');
			expect(step.handler).toBe(handler);
			expect(step.rollback).toBeUndefined();
		});

		it('should return full step info including rollback', () => {
			const registry = new StepRegistry();
			const handler: StepHandler = async () => ({ result: true });
			const rollback: RollbackHandler = async () => {};

			registry.register('TestWorkflow', 'step1', handler, rollback);

			const step = registry.getStep('TestWorkflow', 'step1');
			expect(step.handler).toBe(handler);
			expect(step.rollback).toBe(rollback);
		});

		it('should throw StepNotFoundError when workflow is unknown', () => {
			const registry = new StepRegistry();

			expect(() => registry.getStep('UnknownWorkflow', 'step1')).toThrow(StepNotFoundError);
		});

		it('should throw StepNotFoundError when step is unknown', () => {
			const registry = new StepRegistry();
			registry.register('TestWorkflow', 'step1', async () => ({}));

			expect(() => registry.getStep('TestWorkflow', 'unknownStep')).toThrow(StepNotFoundError);
		});
	});

	describe('getRollback', () => {
		it('should return rollback handler when registered', () => {
			const registry = new StepRegistry();
			const handler: StepHandler = async () => ({});
			const rollback: RollbackHandler = async () => {};

			registry.register('TestWorkflow', 'step1', handler, rollback);

			expect(registry.getRollback('TestWorkflow', 'step1')).toBe(rollback);
		});

		it('should return undefined when step has no rollback', () => {
			const registry = new StepRegistry();
			registry.register('TestWorkflow', 'step1', async () => ({}));

			expect(registry.getRollback('TestWorkflow', 'step1')).toBeUndefined();
		});

		it('should return undefined when workflow is unknown', () => {
			const registry = new StepRegistry();

			expect(registry.getRollback('UnknownWorkflow', 'step1')).toBeUndefined();
		});

		it('should return undefined when step is unknown', () => {
			const registry = new StepRegistry();
			registry.register('TestWorkflow', 'step1', async () => ({}));

			expect(registry.getRollback('TestWorkflow', 'unknownStep')).toBeUndefined();
		});
	});
});

describe('StepNotFoundError', () => {
	it('should have correct name and message', () => {
		const error = new StepNotFoundError('MyWorkflow', 'myStep');

		expect(error.name).toBe('StepNotFoundError');
		expect(error.message).toBe("Step 'myStep' not found for workflow 'MyWorkflow'");
		expect(error.workflowName).toBe('MyWorkflow');
		expect(error.stepName).toBe('myStep');
	});

	it('should be instanceof Error', () => {
		const error = new StepNotFoundError('MyWorkflow', 'myStep');
		expect(error).toBeInstanceOf(Error);
	});
});

describe('createStepRegistry', () => {
	it('should create a new StepRegistry instance', () => {
		const registry = createStepRegistry();
		expect(registry).toBeInstanceOf(StepRegistry);
	});

	it('should create independent instances', () => {
		const registry1 = createStepRegistry();
		const registry2 = createStepRegistry();

		registry1.register('TestWorkflow', 'step1', async () => ({}));

		expect(registry1.has('TestWorkflow', 'step1')).toBe(true);
		expect(registry2.has('TestWorkflow', 'step1')).toBe(false);
	});
});
