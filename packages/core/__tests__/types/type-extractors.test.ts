/**
 * Tests for pure type extraction utilities (Data, Result).
 *
 * ## Purpose
 *
 * These types have NO dependencies on consumer interfaces, making them safe to
 * import anywhere without pulling in the full consumer type system. This separation
 * prevents circular dependencies.
 *
 * Data<T> and Result<T> work for BOTH EventDefinition and WorkflowDefinition
 * since they share the same _data/_result type carrier pattern.
 *
 * ## Testing Strategy
 *
 * 1. **Type Assignment Tests** - Verify extracted types accept correct data shapes
 *
 * 2. **@ts-expect-error Tests** - Verify type constraints reject invalid inputs
 *    at compile time (not silently returning `never`)
 *
 * 3. **Independence Tests** - Verify extractors work without importing consumer.ts
 *
 * ## Type Constraint Design
 *
 * These extractors use type constraints (`<T extends { _data; _result }>`) rather
 * than conditional types (`T extends X ? Y : never`). This produces helpful compile
 * errors instead of silently returning `never` when given invalid input.
 *
 * @see utility.ts for consumer-aware utility types that re-export these
 */

import { describe, expect, it } from 'bun:test';
import { Type, type Static } from '@sinclair/typebox';
import type { Data, Result } from '../../src/types/type-extractors';
import type { EventDefinition } from '../../src/types/event-definition';
import type { WorkflowDefinition } from '../../src/types/workflow-definition';

describe('Data type extractor for events', () => {
	it('should extract data type from EventDefinition', () => {
		const DataSchema = Type.Object({
			userId: Type.String(),
			email: Type.String()
		});
		const ResultSchema = Type.Void();

		type TData = Static<typeof DataSchema>;
		type TResult = Static<typeof ResultSchema>;

		const UserCreated: EventDefinition<TData, TResult> = {
			name: 'user.created',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult
		};

		// Type-level test: Data<T> extracts the correct type
		type ExtractedData = Data<typeof UserCreated>;

		// Runtime verification that the type works
		const data: ExtractedData = { userId: 'u-1', email: 'test@example.com' };
		expect(data.userId).toBe('u-1');
		expect(data.email).toBe('test@example.com');
	});

	it('should produce compile error for non-definition types', () => {
		// Type-level test: Data<T> now produces a compile error for invalid types
		// This is verified via @ts-expect-error - if the error disappears, the test fails

		// @ts-expect-error - Type does not satisfy constraint
		type _InvalidData = Data<{ foo: string }>;

		// @ts-expect-error - Type 'string' does not satisfy constraint
		type _InvalidFromString = Data<string>;

		// This test passes if the @ts-expect-error comments are valid
		expect(true).toBe(true);
	});
});

describe('Result type extractor for events', () => {
	it('should extract result type from EventDefinition', () => {
		const DataSchema = Type.Object({ id: Type.String() });
		const ResultSchema = Type.Object({
			processed: Type.Boolean(),
			timestamp: Type.String()
		});

		type TData = Static<typeof DataSchema>;
		type TResult = Static<typeof ResultSchema>;

		const TestEvent: EventDefinition<TData, TResult> = {
			name: 'test.event',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult
		};

		type ExtractedResult = Result<typeof TestEvent>;

		const result: ExtractedResult = { processed: true, timestamp: '2024-01-01' };
		expect(result.processed).toBe(true);
		expect(result.timestamp).toBe('2024-01-01');
	});

	it('should handle void result type', () => {
		const DataSchema = Type.Object({ id: Type.String() });
		const ResultSchema = Type.Void();

		type TData = Static<typeof DataSchema>;
		type TResult = Static<typeof ResultSchema>;

		const VoidEvent: EventDefinition<TData, TResult> = {
			name: 'void.event',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult
		};

		type ExtractedResult = Result<typeof VoidEvent>;

		const result: ExtractedResult = undefined as void;
		expect(result).toBeUndefined();
	});
});

describe('Data type extractor for workflows', () => {
	it('should extract data type from WorkflowDefinition', () => {
		const DataSchema = Type.Object({
			orderId: Type.String(),
			items: Type.Array(Type.Object({ sku: Type.String() }))
		});
		const ResultSchema = Type.Object({ success: Type.Boolean() });

		type TData = Static<typeof DataSchema>;
		type TResult = Static<typeof ResultSchema>;

		const ProcessOrder: WorkflowDefinition<TData, TResult> = {
			name: 'process-order',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			stepGroups: [],
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult,
			_steps: undefined as unknown as Record<never, never>
		};

		type ExtractedData = Data<typeof ProcessOrder>;

		const data: ExtractedData = { orderId: 'ord-1', items: [{ sku: 'SKU-001' }] };
		expect(data.orderId).toBe('ord-1');
		expect(data.items[0]!.sku).toBe('SKU-001');
	});
});

describe('Result type extractor for workflows', () => {
	it('should extract result type from WorkflowDefinition', () => {
		const DataSchema = Type.Object({ id: Type.String() });
		const ResultSchema = Type.Object({
			completed: Type.Boolean(),
			output: Type.String()
		});

		type TData = Static<typeof DataSchema>;
		type TResult = Static<typeof ResultSchema>;

		const TestWorkflow: WorkflowDefinition<TData, TResult> = {
			name: 'test-workflow',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			stepGroups: [],
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult,
			_steps: undefined as unknown as Record<never, never>
		};

		type ExtractedResult = Result<typeof TestWorkflow>;

		const result: ExtractedResult = { completed: true, output: 'done' };
		expect(result.completed).toBe(true);
		expect(result.output).toBe('done');
	});

	it('should handle complex nested result types', () => {
		const DataSchema = Type.Object({ id: Type.String() });
		const ResultSchema = Type.Object({
			status: Type.Union([Type.Literal('success'), Type.Literal('failure')]),
			details: Type.Object({
				steps: Type.Array(
					Type.Object({
						name: Type.String(),
						duration: Type.Number()
					})
				)
			})
		});

		type TData = Static<typeof DataSchema>;
		type TResult = Static<typeof ResultSchema>;

		const ComplexWorkflow: WorkflowDefinition<TData, TResult> = {
			name: 'complex-workflow',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			stepGroups: [],
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult,
			_steps: undefined as unknown as Record<never, never>
		};

		type ExtractedResult = Result<typeof ComplexWorkflow>;

		const result: ExtractedResult = {
			status: 'success',
			details: {
				steps: [{ name: 'step1', duration: 100 }]
			}
		};
		expect(result.status).toBe('success');
		expect(result.details.steps[0]!.name).toBe('step1');
	});
});

describe('type extractors independence', () => {
	it('should work without importing consumer types', () => {
		// This test verifies that type-extractors.ts has no consumer dependencies
		// by only using the types exported from it
		const DataSchema = Type.Object({ id: Type.String() });
		const ResultSchema = Type.Object({ ok: Type.Boolean() });

		type TData = Static<typeof DataSchema>;
		type TResult = Static<typeof ResultSchema>;

		const Event: EventDefinition<TData, TResult> = {
			name: 'test',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult
		};

		// All these types work without consumer.ts
		type D = Data<typeof Event>;
		type R = Result<typeof Event>;

		const d: D = { id: 'test' };
		const r: R = { ok: true };

		expect(d.id).toBe('test');
		expect(r.ok).toBe(true);
	});

	it('should work for both EventDefinition and WorkflowDefinition', () => {
		// Data<T> and Result<T> work for both definition types
		const DataSchema = Type.Object({ id: Type.String() });
		const ResultSchema = Type.Object({ ok: Type.Boolean() });

		type TData = Static<typeof DataSchema>;
		type TResult = Static<typeof ResultSchema>;

		const Event: EventDefinition<TData, TResult> = {
			name: 'test-event',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult
		};

		const Workflow: WorkflowDefinition<TData, TResult> = {
			name: 'test-workflow',
			dataSchema: DataSchema,
			resultSchema: ResultSchema,
			stepGroups: [],
			_data: undefined as unknown as TData,
			_result: undefined as unknown as TResult,
			_steps: undefined as unknown as Record<never, never>
		};

		// Same utility types work for both
		type EventData = Data<typeof Event>;
		type WorkflowData = Data<typeof Workflow>;
		type EventResult = Result<typeof Event>;
		type WorkflowResult = Result<typeof Workflow>;

		const ed: EventData = { id: 'event' };
		const wd: WorkflowData = { id: 'workflow' };
		const er: EventResult = { ok: true };
		const wr: WorkflowResult = { ok: false };

		expect(ed.id).toBe('event');
		expect(wd.id).toBe('workflow');
		expect(er.ok).toBe(true);
		expect(wr.ok).toBe(false);
	});
});
