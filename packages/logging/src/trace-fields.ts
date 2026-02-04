/**
 * Trace Field Definitions and Utilities
 *
 * Centralized handling of trace/context fields for logging output.
 * Provides consistent abbreviation, truncation, and field recognition
 * across all logging components.
 *
 * ALL fields use camelCase throughout the framework:
 * - correlationId, traceId, spanId, parentSpanId (core framework)
 * - userId, accountUuid, projectUuid (application-registered via Logger.configure)
 *
 * Display uses abbreviated names: corrId, trcId, spanId, usrId
 *
 * @module logging/trace-fields
 */

import type { TraceFieldDef } from './types';

// ANSI color codes for terminal output
export const ANSI_COLORS = {
	reset: '\x1b[0m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	white: '\x1b[37m',
	gray: '\x1b[90m',
	brightYellow: '\x1b[93m'
} as const;

/**
 * Core framework trace field definitions (distributed tracing).
 * These are built-in and always available.
 */
const CORE_TRACE_FIELDS: Record<string, TraceFieldDef> = {
	correlationId: { abbrev: 'corrId', color: ANSI_COLORS.brightYellow },
	traceId: { abbrev: 'trcId', color: ANSI_COLORS.brightYellow },
	spanId: { abbrev: 'spanId', color: ANSI_COLORS.gray },
	parentSpanId: { abbrev: 'pSpanId', color: ANSI_COLORS.gray }
};

/**
 * Application-registered trace field definitions.
 * Populated via registerTraceFields() at application startup.
 */
const appTraceFields: Record<string, TraceFieldDef> = {};

/**
 * Combined trace fields (core + application).
 * Used by isTraceField() and getTraceField().
 */
export function getTraceFields(): Readonly<Record<string, TraceFieldDef>> {
	return { ...CORE_TRACE_FIELDS, ...appTraceFields };
}

/**
 * Registers application-specific trace fields.
 * Call this at application startup before any logging occurs.
 *
 * @example
 * ```typescript
 * // In app.ts
 * registerTraceFields({
 *   accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan },
 *   projectUuid: { abbrev: 'prjId', color: ANSI_COLORS.magenta },
 *   userId: { abbrev: 'usrId', color: ANSI_COLORS.blue },
 * });
 * ```
 */
export function registerTraceFields(fields: Record<string, TraceFieldDef>): void {
	for (const [key, def] of Object.entries(fields)) {
		appTraceFields[key] = def;
	}
}

/**
 * Resets application trace fields (for testing).
 */
export function resetTraceFields(): void {
	for (const key of Object.keys(appTraceFields)) {
		delete appTraceFields[key];
	}
}

/**
 * @deprecated Use getTraceFields() instead. This is for backwards compatibility.
 */
export const TRACE_FIELDS: Readonly<Record<string, TraceFieldDef>> = new Proxy(
	{} as Record<string, TraceFieldDef>,
	{
		get(_target, prop: string) {
			return getTraceFields()[prop];
		},
		has(_target, prop: string) {
			return prop in getTraceFields();
		},
		ownKeys() {
			return Object.keys(getTraceFields());
		},
		getOwnPropertyDescriptor(_target, prop: string) {
			const fields = getTraceFields();
			if (prop in fields) {
				return { configurable: true, enumerable: true, value: fields[prop] };
			}
			return undefined;
		}
	}
);

/** Default truncation length for UUIDs and long IDs */
export const DEFAULT_TRUNCATE_LENGTH = 8;

/**
 * Checks if a field name is a known trace field (core or application-registered).
 */
export function isTraceField(fieldName: string): boolean {
	const fields = getTraceFields();
	return fieldName in fields;
}

/**
 * Gets the trace field definition.
 * Returns undefined if not a trace field.
 */
export function getTraceField(fieldName: string): TraceFieldDef | undefined {
	const fields = getTraceFields();
	return fields[fieldName];
}

/**
 * Truncates a string value to the specified length.
 * Useful for displaying UUIDs in a compact format.
 */
export function truncateValue(value: string, length: number = DEFAULT_TRUNCATE_LENGTH): string {
	if (value.length <= length) {
		return value;
	}
	return value.slice(0, length);
}

/**
 * Formats a trace field value for display with abbreviation and truncation.
 *
 * @param fieldName - Field name (camelCase)
 * @param value - Field value (string)
 * @param useColors - Whether to include ANSI color codes
 * @returns Formatted string like "trcId:abc12345"
 */
export function formatTraceField(fieldName: string, value: string, useColors: boolean = true): string {
	const def = TRACE_FIELDS[fieldName];
	if (!def) {
		return `${fieldName}:${value}`;
	}

	const truncated = truncateValue(value);

	if (useColors) {
		return `${def.color}${def.abbrev}:${truncated}${ANSI_COLORS.reset}`;
	}
	return `${def.abbrev}:${truncated}`;
}

/**
 * Extracts trace fields from a context object.
 * Returns two objects: trace fields and other fields.
 */
export function extractTraceFields(
	context: Record<string, unknown>
): [Record<string, unknown>, Record<string, unknown>] {
	const traceFields: Record<string, unknown> = {};
	const otherFields: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(context)) {
		if (isTraceField(key)) {
			traceFields[key] = value;
		} else {
			otherFields[key] = value;
		}
	}

	return [traceFields, otherFields];
}
