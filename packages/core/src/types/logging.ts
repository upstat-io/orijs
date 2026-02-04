/**
 * Logging type definitions for OriJS.
 *
 * These types are defined here (not imported from logging/) to maintain
 * Clean Architecture: types layer has no dependencies on implementation.
 */

/**
 * Log level names (Pino-compatible)
 */
export type LevelName = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log level numeric values (Pino-compatible numbering)
 */
export type LevelNumber = 10 | 20 | 30 | 40;

/**
 * Structured log object produced by the logger (Pino-compatible)
 */
export interface LogObject {
	time: number;
	level: LevelNumber;
	msg: string;
	name?: string;
	[key: string]: unknown;
}

/**
 * Transport interface for log output destinations.
 *
 * All transports MUST implement flush() and close() to ensure logs are written
 * before process exit. Logger.shutdown() awaits flush() and close() on all transports.
 */
export interface Transport {
	/** Write a log object to the transport */
	write(obj: LogObject): void;
	/** Flush any buffered logs - awaited on shutdown */
	flush(): Promise<void>;
	/** Cleanup (close file handles, connections, etc.) - awaited on shutdown */
	close(): Promise<void>;
}

/**
 * Options for creating a Logger instance
 */
export interface LoggerOptions {
	level?: LevelName;
	transports?: Transport[];
}

/**
 * Trace field definition for log formatting.
 */
export interface TraceFieldDef {
	/** Abbreviated name for display (e.g., 'acctId') */
	readonly abbrev: string;
	/** ANSI color code for terminal output */
	readonly color: string;
}

/**
 * Global logger configuration options
 */
export interface LoggerGlobalOptions extends LoggerOptions {
	/** Enable async buffered writes for high performance (default: true) */
	async?: boolean;
	/** Buffer flush interval in ms when async=true (default: 10) */
	flushInterval?: number;
	/** Buffer size before auto-flush (default: 4096) */
	bufferSize?: number;
	/**
	 * Application-specific trace fields for log formatting.
	 * These fields will be displayed with abbreviated names and colors.
	 *
	 * @example
	 * ```typescript
	 * Logger.configure({
	 *   traceFields: {
	 *     accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan },
	 *     userId: { abbrev: 'usrId', color: ANSI_COLORS.blue },
	 *   }
	 * });
	 * ```
	 */
	traceFields?: Record<string, TraceFieldDef>;
}

/**
 * Logging interface for use in type declarations.
 * The Logger class in logging/logger.ts satisfies this interface.
 * Defined here to maintain Clean Architecture (types layer has no impl dependencies).
 */
export interface Logging {
	/** Log at debug level */
	debug(msg: string, context?: Record<string, unknown>): void;
	/** Log at info level */
	info(msg: string, context?: Record<string, unknown>): void;
	/** Log at warn level */
	warn(msg: string, context?: Record<string, unknown>): void;
	/** Log at error level */
	error(msg: string, context?: Record<string, unknown>): void;
	/** Create child logger with additional context */
	with(context: Record<string, unknown>): Logging;
	/** Get propagation metadata for cross-service tracing */
	propagationMeta(): Record<string, unknown>;
}
