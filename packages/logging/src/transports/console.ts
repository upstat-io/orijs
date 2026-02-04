import type { Transport, LogObject } from '../logger.ts';
import type { LevelNumber } from '../levels.ts';
import { ANSI_COLORS, getTraceFields, truncateValue } from '../trace-fields.ts';

export interface ConsoleTransportOptions {
	pretty?: boolean;
	json?: boolean;
	/** Depth for object inspection (default: 4) */
	depth?: number;
	/** Show colors in pretty mode (default: auto-detect TTY) */
	colors?: boolean;
}

// Re-export colors for backward compatibility
const colors = ANSI_COLORS;

const levelColors: Record<LevelNumber, string> = {
	10: colors.magenta, // debug (D)
	20: colors.cyan, // info (I)
	30: colors.yellow, // warn (W)
	40: colors.red // error (E)
};

const levelChars: Record<LevelNumber, string> = {
	10: 'D',
	20: 'I',
	30: 'W',
	40: 'E'
};

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const hours = date.getHours().toString().padStart(2, '0');
	const minutes = date.getMinutes().toString().padStart(2, '0');
	const seconds = date.getSeconds().toString().padStart(2, '0');
	return `${hours}:${minutes}:${seconds}`;
}

function formatValue(value: unknown, useColors: boolean, depth: number): string {
	if (value === null || value === undefined) {
		return String(value);
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	// Use Bun.inspect for objects, arrays, errors, etc.
	// This respects [Bun.inspect.custom] symbols on objects
	return Bun.inspect(value, { colors: useColors, depth });
}

function formatArray(arr: unknown[], options: FormatOptions): string {
	if (arr.length === 0) return '[]';
	const items = arr.map((v) => formatValue(v, options.colors, options.depth));
	return `[${items.join(', ')}]`;
}

function formatKeyValue(key: string, value: unknown, options: FormatOptions): string {
	const formattedValue = Array.isArray(value)
		? formatArray(value, options)
		: formatValue(value, options.colors, options.depth);
	return `${colors.white}${key}:${formattedValue}${colors.reset}`;
}

interface FormatOptions {
	colors: boolean;
	depth: number;
}

function formatError(error: Error, options: FormatOptions): string {
	// Use Bun.inspect for errors - provides syntax-highlighted source preview
	return Bun.inspect(error, { colors: options.colors, depth: options.depth });
}

function formatPretty(obj: LogObject, options: FormatOptions): string {
	const time = formatTime(obj.time);
	const levelColor = levelColors[obj.level] ?? colors.reset;
	const levelChar = levelChars[obj.level] ?? '?';
	const name = obj.name ?? 'Application';
	const isError = obj.level === 40;
	const isWarn = obj.level === 30;

	// Build context string, handling errors specially
	const { time: _time, level: _level, msg, name: _name, error, err, ...context } = obj;

	// Get current trace field definitions (core + application-registered)
	const traceFields = getTraceFields();

	// Extract trace fields (shown right after context name, before message)
	// ALL fields use camelCase - this is the framework standard
	const traceParts: string[] = [];
	const otherParts: string[] = [];

	for (const [key, value] of Object.entries(context)) {
		const traceFieldDef = traceFields[key];

		if (traceFieldDef && typeof value === 'string') {
			// Trace field: use abbreviated name, specific color, truncate
			const truncated = truncateValue(value);
			traceParts.push(`${traceFieldDef.color}${traceFieldDef.abbrev}:${truncated}${colors.reset}`);
		} else {
			// Other context: shown after message
			otherParts.push(formatKeyValue(key, value, options));
		}
	}

	const traceStr = traceParts.length > 0 ? ` ${traceParts.join(' ')}` : '';
	const contextStr = otherParts.length > 0 ? `: ${otherParts.join(' ')}` : '';

	// Color the message for errors/warnings
	const message = isError
		? `${colors.red}${msg}${colors.reset}`
		: isWarn
			? `${colors.yellow}${msg}${colors.reset}`
			: msg;

	// Format: HH:MM:SS:L:ContextName trcId:xxx acctId:xxx message: otherContext
	let output = `${colors.gray}${time}${colors.reset}:${levelColor}${levelChar}${colors.reset}:${colors.yellow}${name}${colors.reset}${traceStr} ${message}${contextStr}`;

	// Handle error objects with enhanced formatting (syntax-highlighted stack traces)
	const errorObj = error ?? err;
	if (errorObj instanceof Error) {
		const errorOutput = formatError(errorObj, options);
		output += '\n' + (isError ? `${colors.red}${errorOutput}${colors.reset}` : errorOutput);
	}

	return output;
}

function formatJson(obj: LogObject): string {
	return JSON.stringify(obj);
}

function isPrettyMode(options: ConsoleTransportOptions): boolean {
	if (options.pretty !== undefined) return options.pretty;
	if (options.json !== undefined) return !options.json;

	// Auto-detect: pretty in dev, JSON only in production
	// Don't require TTY - most dev environments want pretty output
	const isProduction = process.env.NODE_ENV === 'production';
	return !isProduction;
}

function shouldUseColors(options: ConsoleTransportOptions): boolean {
	if (options.colors !== undefined) return options.colors;
	// Auto-detect based on TTY
	return process.stdout.isTTY ?? false;
}

/**
 * Console transport - outputs to stdout with pretty or JSON formatting.
 *
 * Features:
 * - Auto-detects mode (pretty in dev + TTY, JSON in prod)
 * - Uses Bun.inspect() for rich object formatting
 * - Respects [Bun.inspect.custom] for custom object display
 * - Syntax-highlighted error stack traces with source preview
 * - Configurable depth and colors
 *
 * @example
 * ```ts
 * // Auto-detect mode
 * transports.console()
 *
 * // Force pretty with colors
 * transports.console({ pretty: true, colors: true })
 *
 * // JSON for production
 * transports.console({ json: true })
 *
 * // Custom depth for deep objects
 * transports.console({ depth: 6 })
 * ```
 */
export function consoleTransport(options: ConsoleTransportOptions = {}): Transport {
	const pretty = isPrettyMode(options);
	const formatOptions: FormatOptions = {
		colors: shouldUseColors(options),
		depth: options.depth ?? 4
	};

	return {
		write(obj: LogObject): void {
			const output = pretty ? formatPretty(obj, formatOptions) : formatJson(obj);
			console.log(output);
		},

		async flush(): Promise<void> {
			// Console writes are synchronous, nothing to flush
		},

		async close(): Promise<void> {
			// Console has no resources to close
		}
	};
}
