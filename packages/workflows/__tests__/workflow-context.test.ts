/**
 * Tests for WorkflowContext
 *
 * Covers:
 * - Context creation with all properties
 * - Accumulated results (Q4 verification)
 * - Logger and meta propagation
 * - Immutability
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DefaultWorkflowContext, createWorkflowContext } from '../src/workflow-context.ts';
import { Logger, type PropagationMeta } from '@orijs/logging';

describe('WorkflowContext', () => {
	let testLogger: Logger;
	let testMeta: PropagationMeta;

	beforeEach(() => {
		Logger.reset();
		testLogger = new Logger('TestWorkflow');
		testMeta = {
			correlationId: 'req-123',
			traceId: 'trace-456',
			userId: 'user-789',
			account_uuid: 'acc-abc'
		};
	});

	describe('DefaultWorkflowContext', () => {
		it('should create context with all properties', () => {
			const flowId = 'flow-test-123';
			const data = { orderId: 'ORD-001', amount: 99.99 };
			const results = { step1: { processed: true } };

			const ctx = new DefaultWorkflowContext(flowId, data, results, testLogger, testMeta);

			expect(ctx.flowId).toBe(flowId);
			expect(ctx.data).toBe(data);
			expect(ctx.results).toBe(results);
			expect(ctx.log).toBe(testLogger);
			expect(ctx.meta).toBe(testMeta);
		});

		it('should preserve data type', () => {
			interface OrderData {
				orderId: string;
				items: Array<{ sku: string; qty: number }>;
			}

			const data: OrderData = {
				orderId: 'ORD-002',
				items: [
					{ sku: 'ITEM-A', qty: 2 },
					{ sku: 'ITEM-B', qty: 1 }
				]
			};

			const ctx = new DefaultWorkflowContext<OrderData>('flow-1', data, {}, testLogger, testMeta);

			expect(ctx.data.orderId).toBe('ORD-002');
			expect(ctx.data.items).toHaveLength(2);
			expect(ctx.data.items[0]!.sku).toBe('ITEM-A');
		});
	});

	describe('createWorkflowContext', () => {
		it('should create frozen context', () => {
			const ctx = createWorkflowContext('flow-frozen', { value: 42 }, {}, testLogger, testMeta);

			expect(Object.isFrozen(ctx)).toBe(true);
		});

		it('should include all provided properties', () => {
			const flowId = 'flow-create';
			const data = { key: 'value' };
			const results = { init: { done: true } };

			const ctx = createWorkflowContext(flowId, data, results, testLogger, testMeta);

			expect(ctx.flowId).toBe(flowId);
			expect(ctx.data).toEqual(data);
			expect(ctx.results).toEqual(results);
			// Logger is a child with workflow context added automatically
			expect(ctx.log).toBeInstanceOf(Logger);
			expect(ctx.meta).toBe(testMeta);
		});

		describe('input validation', () => {
			it('should reject empty flowId', () => {
				expect(() => {
					createWorkflowContext('', {}, {}, testLogger, testMeta);
				}).toThrow('flowId must be a non-empty string');
			});

			it('should reject null flowId', () => {
				expect(() => {
					createWorkflowContext(null as unknown as string, {}, {}, testLogger, testMeta);
				}).toThrow('flowId must be a non-empty string');
			});

			it('should reject undefined flowId', () => {
				expect(() => {
					createWorkflowContext(undefined as unknown as string, {}, {}, testLogger, testMeta);
				}).toThrow('flowId must be a non-empty string');
			});

			it('should reject null logger', () => {
				expect(() => {
					createWorkflowContext('flow-1', {}, {}, null as unknown as Logger, testMeta);
				}).toThrow('log (Logger) is required');
			});

			it('should reject undefined logger', () => {
				expect(() => {
					createWorkflowContext('flow-1', {}, {}, undefined as unknown as Logger, testMeta);
				}).toThrow('log (Logger) is required');
			});

			it('should reject null results', () => {
				expect(() => {
					createWorkflowContext(
						'flow-1',
						{},
						null as unknown as Record<string, unknown>,
						testLogger,
						testMeta
					);
				}).toThrow('results must be an object');
			});

			it('should reject array as results', () => {
				expect(() => {
					createWorkflowContext('flow-1', {}, [] as unknown as Record<string, unknown>, testLogger, testMeta);
				}).toThrow('results must be an object');
			});

			it('should reject null meta', () => {
				expect(() => {
					createWorkflowContext('flow-1', {}, {}, testLogger, null as unknown as PropagationMeta);
				}).toThrow('meta must be an object');
			});

			it('should reject array as meta', () => {
				expect(() => {
					createWorkflowContext('flow-1', {}, {}, testLogger, [] as unknown as PropagationMeta);
				}).toThrow('meta must be an object');
			});

			it('should accept valid inputs', () => {
				// Should not throw
				const ctx = createWorkflowContext('valid-flow', { data: 'test' }, {}, testLogger, {});

				expect(ctx.flowId).toBe('valid-flow');
				expect(ctx.data).toEqual({ data: 'test' });
			});
		});
	});

	describe('accumulated results (Q4)', () => {
		it('should provide access to accumulated step results', () => {
			// Simulate accumulated results from multiple steps
			const accumulatedResults = {
				validate: { isValid: true, errors: [] },
				process: { processed: true, count: 5 },
				notify: { emailSent: true, smsSent: false }
			};

			const ctx = createWorkflowContext(
				'flow-accumulated',
				{ orderId: 'ORD-003' },
				accumulatedResults,
				testLogger,
				testMeta
			);

			// Steps can access previous step results
			expect(ctx.results['validate']).toEqual({ isValid: true, errors: [] });
			expect(ctx.results['process']).toEqual({ processed: true, count: 5 });
			expect(ctx.results['notify']).toEqual({ emailSent: true, smsSent: false });
		});

		it('should handle empty results for first step', () => {
			const ctx = createWorkflowContext(
				'flow-first',
				{ data: 'test' },
				{}, // No previous results
				testLogger,
				testMeta
			);

			expect(ctx.results).toEqual({});
			expect(Object.keys(ctx.results)).toHaveLength(0);
		});

		it('should preserve result types', () => {
			interface Step1Result {
				validated: boolean;
			}
			interface Step2Result {
				processedCount: number;
			}

			const results = {
				step1: { validated: true } as Step1Result,
				step2: { processedCount: 10 } as Step2Result
			};

			const ctx = createWorkflowContext('flow-typed', {}, results, testLogger, testMeta);

			// Type casting is required since results is Record<string, unknown>
			const step1 = ctx.results['step1'] as Step1Result;
			const step2 = ctx.results['step2'] as Step2Result;

			expect(step1.validated).toBe(true);
			expect(step2.processedCount).toBe(10);
		});
	});

	describe('logger and meta', () => {
		it('should include logger for step logging', () => {
			const ctx = createWorkflowContext('flow-log', {}, {}, testLogger, testMeta);

			expect(ctx.log).toBeInstanceOf(Logger);
		});

		it('should include propagation meta', () => {
			const meta: PropagationMeta = {
				correlationId: 'req-999',
				traceId: 'trace-888',
				spanId: 'span-777',
				parentSpanId: 'parent-666',
				userId: 'user-555',
				account_uuid: 'acc-444',
				custom_field: 'custom-value'
			};

			const ctx = createWorkflowContext('flow-meta', {}, {}, testLogger, meta);

			expect(ctx.meta.correlationId).toBe('req-999');
			expect(ctx.meta.traceId).toBe('trace-888');
			expect(ctx.meta.spanId).toBe('span-777');
			expect(ctx.meta.parentSpanId).toBe('parent-666');
			expect(ctx.meta.userId).toBe('user-555');
			expect(ctx.meta.account_uuid).toBe('acc-444');
			expect(ctx.meta.custom_field).toBe('custom-value');
		});

		it('should handle minimal meta', () => {
			const minimalMeta: PropagationMeta = {};

			const ctx = createWorkflowContext('flow-minimal', {}, {}, testLogger, minimalMeta);

			expect(ctx.meta.correlationId).toBeUndefined();
			expect(ctx.meta.traceId).toBeUndefined();
		});
	});
});
