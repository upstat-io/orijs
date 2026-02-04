import { describe, it, expect, beforeEach } from 'bun:test';
import {
	ANSI_COLORS,
	getTraceFields,
	registerTraceFields,
	resetTraceFields,
	isTraceField,
	getTraceField,
	truncateValue,
	formatTraceField,
	extractTraceFields,
	DEFAULT_TRUNCATE_LENGTH,
	TRACE_FIELDS,
	Logger
} from '../src/index.ts';

describe('trace-fields', () => {
	beforeEach(() => {
		// Reset application-registered fields before each test
		resetTraceFields();
	});

	describe('ANSI_COLORS', () => {
		it('should export standard ANSI color codes', () => {
			expect(ANSI_COLORS.reset).toBe('\x1b[0m');
			expect(ANSI_COLORS.red).toBe('\x1b[31m');
			expect(ANSI_COLORS.green).toBe('\x1b[32m');
			expect(ANSI_COLORS.yellow).toBe('\x1b[33m');
			expect(ANSI_COLORS.blue).toBe('\x1b[34m');
			expect(ANSI_COLORS.cyan).toBe('\x1b[36m');
			expect(ANSI_COLORS.gray).toBe('\x1b[90m');
			expect(ANSI_COLORS.brightYellow).toBe('\x1b[93m');
		});
	});

	describe('Core trace fields', () => {
		it('should include correlationId as core field', () => {
			const fields = getTraceFields();
			expect(fields.correlationId).toEqual({
				abbrev: 'corrId',
				color: ANSI_COLORS.brightYellow
			});
		});

		it('should include traceId as core field', () => {
			const fields = getTraceFields();
			expect(fields.traceId).toEqual({
				abbrev: 'trcId',
				color: ANSI_COLORS.brightYellow
			});
		});

		it('should include correlationId as core field', () => {
			const fields = getTraceFields();
			expect(fields.correlationId).toEqual({
				abbrev: 'corrId',
				color: ANSI_COLORS.brightYellow
			});
		});

		it('should include spanId as core field', () => {
			const fields = getTraceFields();
			expect(fields.spanId).toEqual({
				abbrev: 'spanId',
				color: ANSI_COLORS.gray
			});
		});

		it('should include parentSpanId as core field', () => {
			const fields = getTraceFields();
			expect(fields.parentSpanId).toEqual({
				abbrev: 'pSpanId',
				color: ANSI_COLORS.gray
			});
		});
	});

	describe('registerTraceFields', () => {
		it('should register application-specific trace fields', () => {
			registerTraceFields({
				accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan },
				userId: { abbrev: 'usrId', color: ANSI_COLORS.blue }
			});

			const fields = getTraceFields();
			expect(fields.accountUuid).toEqual({
				abbrev: 'acctId',
				color: ANSI_COLORS.cyan
			});
			expect(fields.userId).toEqual({
				abbrev: 'usrId',
				color: ANSI_COLORS.blue
			});
		});

		it('should not affect core fields when registering', () => {
			registerTraceFields({
				customField: { abbrev: 'cust', color: ANSI_COLORS.magenta }
			});

			const fields = getTraceFields();
			expect(fields.correlationId!.abbrev).toBe('corrId');
			expect(fields.traceId!.abbrev).toBe('trcId');
		});

		it('should allow multiple registration calls', () => {
			registerTraceFields({
				fieldA: { abbrev: 'fldA', color: ANSI_COLORS.cyan }
			});
			registerTraceFields({
				fieldB: { abbrev: 'fldB', color: ANSI_COLORS.magenta }
			});

			const fields = getTraceFields();
			expect(fields.fieldA!.abbrev).toBe('fldA');
			expect(fields.fieldB!.abbrev).toBe('fldB');
		});
	});

	describe('resetTraceFields', () => {
		it('should remove application-registered fields', () => {
			registerTraceFields({
				accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan }
			});

			expect(getTraceFields().accountUuid).toBeDefined();

			resetTraceFields();

			expect(getTraceFields().accountUuid).toBeUndefined();
		});

		it('should preserve core fields after reset', () => {
			registerTraceFields({
				accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan }
			});

			resetTraceFields();

			const fields = getTraceFields();
			expect(fields.correlationId).toBeDefined();
			expect(fields.traceId).toBeDefined();
			expect(fields.spanId).toBeDefined();
		});
	});

	describe('isTraceField', () => {
		it('should return true for core trace fields', () => {
			expect(isTraceField('correlationId')).toBe(true);
			expect(isTraceField('traceId')).toBe(true);
			expect(isTraceField('spanId')).toBe(true);
			expect(isTraceField('parentSpanId')).toBe(true);
			expect(isTraceField('correlationId')).toBe(true);
		});

		it('should return true for registered application fields', () => {
			registerTraceFields({
				accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan }
			});

			expect(isTraceField('accountUuid')).toBe(true);
		});

		it('should return false for unregistered fields', () => {
			expect(isTraceField('unknownField')).toBe(false);
			expect(isTraceField('accountUuid')).toBe(false);
		});
	});

	describe('getTraceField', () => {
		it('should return definition for core fields', () => {
			const def = getTraceField('correlationId');
			expect(def).toEqual({
				abbrev: 'corrId',
				color: ANSI_COLORS.brightYellow
			});
		});

		it('should return definition for registered fields', () => {
			registerTraceFields({
				projectUuid: { abbrev: 'prjId', color: ANSI_COLORS.magenta }
			});

			const def = getTraceField('projectUuid');
			expect(def).toEqual({
				abbrev: 'prjId',
				color: ANSI_COLORS.magenta
			});
		});

		it('should return undefined for unregistered fields', () => {
			expect(getTraceField('unknownField')).toBeUndefined();
		});
	});

	describe('truncateValue', () => {
		it('should truncate values longer than default length', () => {
			const uuid = '3df69a75-030b-4221-9f6e-eda1acdfc3e4';
			expect(truncateValue(uuid)).toBe('3df69a75');
		});

		it('should not truncate values shorter than default length', () => {
			expect(truncateValue('short')).toBe('short');
		});

		it('should handle exact length values', () => {
			expect(truncateValue('12345678')).toBe('12345678');
		});

		it('should respect custom length parameter', () => {
			expect(truncateValue('1234567890', 4)).toBe('1234');
			expect(truncateValue('abc', 10)).toBe('abc');
		});

		it('should use default length of 8', () => {
			expect(DEFAULT_TRUNCATE_LENGTH).toBe(8);
		});
	});

	describe('formatTraceField', () => {
		it('should format core trace field with colors', () => {
			const result = formatTraceField('correlationId', 'abc-123-def-456', true);
			expect(result).toContain('corrId:abc-123-');
			expect(result).toContain(ANSI_COLORS.brightYellow);
			expect(result).toContain(ANSI_COLORS.reset);
		});

		it('should format trace field without colors', () => {
			const result = formatTraceField('traceId', 'trace-uuid-value', false);
			expect(result).toBe('trcId:trace-uu');
			expect(result).not.toContain('\x1b');
		});

		it('should format registered application fields', () => {
			registerTraceFields({
				accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan }
			});

			const result = formatTraceField('accountUuid', '3df69a75-030b-4221', false);
			expect(result).toBe('acctId:3df69a75');
		});

		it('should fallback to field name for unregistered fields', () => {
			const result = formatTraceField('unknownField', 'some-value', false);
			expect(result).toBe('unknownField:some-value');
		});
	});

	describe('Logger.configure({ traceFields })', () => {
		beforeEach(() => {
			Logger.reset();
		});

		it('should register trace fields via Logger.configure', () => {
			Logger.configure({
				traceFields: {
					accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan },
					userId: { abbrev: 'usrId', color: ANSI_COLORS.blue }
				}
			});

			expect(isTraceField('accountUuid')).toBe(true);
			expect(isTraceField('userId')).toBe(true);
			expect(getTraceField('accountUuid')?.abbrev).toBe('acctId');
		});

		it('should preserve core fields when configuring', () => {
			Logger.configure({
				traceFields: {
					customField: { abbrev: 'cust', color: ANSI_COLORS.magenta }
				}
			});

			expect(isTraceField('correlationId')).toBe(true);
			expect(isTraceField('traceId')).toBe(true);
			expect(isTraceField('customField')).toBe(true);
		});

		it('should reset application fields on Logger.reset()', () => {
			Logger.configure({
				traceFields: {
					accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan }
				}
			});

			expect(isTraceField('accountUuid')).toBe(true);

			Logger.reset();

			expect(isTraceField('accountUuid')).toBe(false);
			expect(isTraceField('correlationId')).toBe(true); // Core field preserved
		});
	});

	describe('extractTraceFields', () => {
		it('should separate trace fields from other fields', () => {
			const context = {
				correlationId: 'req-123',
				traceId: 'trace-456',
				userId: 'user-789',
				customData: { foo: 'bar' }
			};

			const [traceFields, otherFields] = extractTraceFields(context);

			expect(traceFields).toEqual({
				correlationId: 'req-123',
				traceId: 'trace-456'
			});
			expect(otherFields).toEqual({
				userId: 'user-789',
				customData: { foo: 'bar' }
			});
		});

		it('should include registered application fields in trace fields', () => {
			registerTraceFields({
				accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan }
			});

			const context = {
				correlationId: 'req-123',
				accountUuid: 'acct-456',
				otherField: 'value'
			};

			const [traceFields, otherFields] = extractTraceFields(context);

			expect(traceFields).toEqual({
				correlationId: 'req-123',
				accountUuid: 'acct-456'
			});
			expect(otherFields).toEqual({
				otherField: 'value'
			});
		});

		it('should return empty trace fields when none present', () => {
			const context = {
				customField: 'value',
				anotherField: 123
			};

			const [traceFields, otherFields] = extractTraceFields(context);

			expect(traceFields).toEqual({});
			expect(otherFields).toEqual(context);
		});

		it('should return empty other fields when all are trace fields', () => {
			const context = {
				correlationId: 'req-123',
				traceId: 'trace-456',
				spanId: 'span-789'
			};

			const [traceFields, otherFields] = extractTraceFields(context);

			expect(traceFields).toEqual(context);
			expect(otherFields).toEqual({});
		});

		it('should handle empty context', () => {
			const [traceFields, otherFields] = extractTraceFields({});

			expect(traceFields).toEqual({});
			expect(otherFields).toEqual({});
		});
	});

	describe('TRACE_FIELDS (deprecated Proxy)', () => {
		it('should return field definition via get', () => {
			const def = TRACE_FIELDS['correlationId'];
			expect(def).toEqual({
				abbrev: 'corrId',
				color: ANSI_COLORS.brightYellow
			});
		});

		it('should return undefined for non-existent field', () => {
			const def = TRACE_FIELDS['nonExistentField'];
			expect(def).toBeUndefined();
		});

		it('should support "in" operator via has trap', () => {
			expect('correlationId' in TRACE_FIELDS).toBe(true);
			expect('traceId' in TRACE_FIELDS).toBe(true);
			expect('nonExistent' in TRACE_FIELDS).toBe(false);
		});

		it('should support Object.keys via ownKeys trap', () => {
			const keys = Object.keys(TRACE_FIELDS);
			expect(keys).toContain('correlationId');
			expect(keys).toContain('traceId');
			expect(keys).toContain('spanId');
			expect(keys).toContain('parentSpanId');
			expect(keys).toContain('correlationId');
		});

		it('should include registered fields in Object.keys', () => {
			registerTraceFields({
				accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan }
			});

			const keys = Object.keys(TRACE_FIELDS);
			expect(keys).toContain('accountUuid');
		});

		it('should support property descriptor via getOwnPropertyDescriptor', () => {
			const descriptor = Object.getOwnPropertyDescriptor(TRACE_FIELDS, 'correlationId');
			expect(descriptor).toBeDefined();
			expect(descriptor?.enumerable).toBe(true);
			expect(descriptor?.configurable).toBe(true);
			expect(descriptor?.value).toEqual({
				abbrev: 'corrId',
				color: ANSI_COLORS.brightYellow
			});
		});

		it('should return undefined descriptor for non-existent field', () => {
			const descriptor = Object.getOwnPropertyDescriptor(TRACE_FIELDS, 'nonExistent');
			expect(descriptor).toBeUndefined();
		});

		it('should support Object.entries', () => {
			const entries = Object.entries(TRACE_FIELDS);
			const correlationIdEntry = entries.find(([key]) => key === 'correlationId');
			expect(correlationIdEntry).toBeDefined();
			expect(correlationIdEntry![1]).toEqual({
				abbrev: 'corrId',
				color: ANSI_COLORS.brightYellow
			});
		});
	});
});
