import { levels, type LevelName, type LevelNumber, isLevelEnabled } from './levels';
import { consoleTransport } from './transports/console';
import { logBuffer } from './log-buffer';
import { registerTraceFields, resetTraceFields } from './trace-fields';
import type { LogObject, Transport, LoggerOptions, LoggerGlobalOptions } from './types';

/**
 * Callback type for notifying when setMeta is called.
 * Used by RequestContext to update AsyncLocalStorage.
 */
export type SetMetaCallback = (meta: Record<string, unknown>) => void;

// Re-export types for backwards compatibility
export type { LogObject, Transport, LoggerOptions, LoggerGlobalOptions };

/**
 * Fast, structured logger with Pino-inspired design.
 *
 * - Produces structured log objects
 * - Writes to configurable transports
 * - Async buffered writes for high performance (default)
 * - Sonic-boom style string buffering
 * - Immutable context via with()
 * - Cross-service propagation support
 */
export class Logger {
	private static globalTransports: Transport[] | null = null;
	private static globalLevel: LevelName = 'info';
	private static pendingLogs: LogObject[] = [];
	private static initialized = false;

	private readonly name: string;
	private readonly level: LevelNumber;
	private readonly explicitTransports: Transport[] | null;
	private context: Record<string, unknown>;
	private setMetaCallback: SetMetaCallback | null = null;

	constructor(name: string, options: LoggerOptions = {}, context: Record<string, unknown> = {}) {
		this.name = name;
		this.level = levels[options.level ?? Logger.globalLevel];
		// Store explicit transports, or null to use global (checked at write time)
		this.explicitTransports = options.transports ?? null;
		this.context = context;
	}

	/**
	 * Registers a callback to be invoked when setMeta is called.
	 * Used by RequestContext to update AsyncLocalStorage when metadata is injected.
	 * @internal Framework use only
	 */
	onSetMeta(callback: SetMetaCallback): void {
		this.setMetaCallback = callback;
	}

	/**
	 * Injects application-specific metadata into the logger context.
	 * Used by guards and middleware to add fields like userId, accountUuid.
	 *
	 * The injected metadata:
	 * - Persists for the duration of the request
	 * - Is automatically propagated across service boundaries (events, workflows)
	 * - Appears as trace fields in logs if registered via Logger.configure({ traceFields })
	 *
	 * @example
	 * ```typescript
	 * // In AuthGuard
	 * ctx.log.setMeta({ userId: payload.userId, accountUuid: payload.accountUuid });
	 * ```
	 */
	setMeta(meta: Record<string, unknown>): void {
		// Merge into this logger's context
		this.context = { ...this.context, ...meta };

		// Notify callback (RequestContext uses this to update AsyncLocalStorage)
		if (this.setMetaCallback) {
			this.setMetaCallback(meta);
		}
	}

	private get transports(): Transport[] {
		return this.explicitTransports ?? Logger.globalTransports ?? [Logger.defaultTransport()];
	}

	/**
	 * Configure global defaults for all Logger instances.
	 * Call this once at app startup before creating any loggers.
	 * Flushes any buffered early logs through the new transports.
	 */
	static configure(options: LoggerGlobalOptions): void {
		if (options.level) {
			Logger.globalLevel = options.level;
		}
		if (options.transports) {
			Logger.globalTransports = options.transports;
		}

		// Register application-specific trace fields
		if (options.traceFields) {
			registerTraceFields(options.traceFields);
		}

		// Configure async buffering via LogBuffer
		logBuffer.configure({
			enabled: options.async ?? true,
			flushInterval: options.flushInterval,
			bufferSize: options.bufferSize
		});

		// Set transport resolver so LogBuffer can flush to transports
		logBuffer.setTransportResolver(() => Logger.globalTransports);

		// Flush pending logs through the configured transports
		if (!Logger.initialized && Logger.pendingLogs.length > 0) {
			const transports = Logger.globalTransports ?? [Logger.defaultTransport()];
			for (const logObj of Logger.pendingLogs) {
				for (const transport of transports) {
					transport.write(logObj);
				}
			}
			Logger.pendingLogs = [];
		}
		Logger.initialized = true;
	}

	/**
	 * Reset global configuration to defaults.
	 * Useful for test isolation.
	 *
	 * **IMPORTANT**: Tests that modify Logger configuration (via Logger.configure())
	 * MUST call Logger.reset() in afterEach() to prevent test pollution.
	 *
	 * @example
	 * ```ts
	 * describe('MyService', () => {
	 *   afterEach(() => {
	 *     Logger.reset(); // Required if any test calls Logger.configure()
	 *   });
	 *
	 *   it('should log at debug level', () => {
	 *     Logger.configure({ level: 'debug' });
	 *     // ... test code
	 *   });
	 * });
	 * ```
	 */
	static reset(): void {
		logBuffer.reset();
		resetTraceFields();
		Logger.globalLevel = 'info';
		Logger.globalTransports = null;
		Logger.pendingLogs = [];
		Logger.initialized = false;
	}

	/**
	 * Flush all buffered logs to transports.
	 * Call this before exiting to ensure all logs are written.
	 */
	static flush(): void {
		// Flush async buffer first
		logBuffer.flush();

		// Flush pending (pre-initialization) logs
		if (Logger.pendingLogs.length > 0) {
			const transport = Logger.defaultTransport();
			for (const logObj of Logger.pendingLogs) {
				transport.write(logObj);
			}
			Logger.pendingLogs = [];
		}
	}

	/**
	 * Shutdown the logger - flushes all buffers and awaits transport cleanup.
	 * Call this during application shutdown.
	 *
	 * This method:
	 * 1. Stops the LogBuffer timer and flushes buffered logs to transports
	 * 2. Flushes all transports in parallel (ensures async buffers like file transport are written)
	 * 3. Closes all transports in parallel (cleanup file handles, connections, etc.)
	 *
	 * Uses Promise.allSettled to ensure all transports complete shutdown regardless of
	 * individual failures. This prevents one failing transport from blocking others.
	 */
	static async shutdown(): Promise<void> {
		// Stop timer and flush LogBuffer (writes to transports synchronously)
		logBuffer.shutdown();
		Logger.flush();

		// Flush and close all transports in parallel
		// Using allSettled ensures all transports get a chance to close even if some fail
		const transports = Logger.globalTransports ?? [];
		await Promise.allSettled(transports.map((transport) => transport.flush()));
		await Promise.allSettled(transports.map((transport) => transport.close()));
	}

	debug(msg: string, data?: Record<string, unknown>): void {
		this.log(levels.debug, msg, data);
	}

	info(msg: string, data?: Record<string, unknown>): void {
		this.log(levels.info, msg, data);
	}

	warn(msg: string, data?: Record<string, unknown>): void {
		this.log(levels.warn, msg, data);
	}

	error(msg: string, data?: Record<string, unknown>): void {
		this.log(levels.error, msg, data);
	}

	/**
	 * Logs tabular data in a formatted ASCII table.
	 * Uses Bun.inspect.table() for rendering.
	 *
	 * @example
	 * ```ts
	 * log.table('Users', [
	 *   { name: 'Alice', role: 'admin' },
	 *   { name: 'Bob', role: 'user' }
	 * ]);
	 *
	 * // With specific columns
	 * log.table('Users', users, ['name', 'email']);
	 * ```
	 */
	table(msg: string, data: Record<string, unknown>[], columns?: string[]): void {
		if (!isLevelEnabled(levels.info, this.level)) {
			return;
		}

		const tableStr = columns
			? Bun.inspect.table(data, columns, { colors: true })
			: Bun.inspect.table(data, { colors: true });

		const logObj: LogObject = {
			time: Date.now(),
			level: levels.info,
			msg: `${msg}\n${tableStr}`,
			name: this.name,
			...this.context
		};

		this.writeLogObject(logObj);
	}

	/**
	 * Write a log object to transports, using async buffering when enabled
	 * Uses sonic-boom style string concatenation for high performance
	 */
	private writeLogObject(logObj: LogObject): void {
		// Buffer logs if no explicit transports and not yet initialized
		if (!this.explicitTransports && !Logger.initialized) {
			Logger.pendingLogs.push(logObj);
			return;
		}

		// Use async buffering when enabled and using global transports
		if (logBuffer.isEnabled() && !this.explicitTransports) {
			logBuffer.write(logObj);
			return;
		}

		// Synchronous write
		for (const transport of this.transports) {
			transport.write(logObj);
		}
	}

	/**
	 * Formats a value using Bun.inspect for debugging.
	 * Respects [Bun.inspect.custom] symbols.
	 */
	static inspect(value: unknown, options?: { colors?: boolean; depth?: number }): string {
		return Bun.inspect(value, {
			colors: options?.colors ?? true,
			depth: options?.depth ?? 4
		});
	}

	/**
	 * Creates a new logger with additional context (immutable)
	 */
	with(data: Record<string, unknown>): Logger {
		const newContext = { ...this.context, ...data };
		const options: LoggerOptions = { level: this.getLevelName() };
		// Preserve explicit transports (or lack thereof) for buffering behavior
		if (this.explicitTransports) {
			options.transports = this.explicitTransports;
		}
		const logger = new Logger(this.name, options, newContext);
		// Preserve callback so setMeta on child loggers still updates AsyncLocalStorage
		if (this.setMetaCallback) {
			logger.onSetMeta(this.setMetaCallback);
		}
		return logger;
	}

	/**
	 * Creates a child logger with a new name (immutable)
	 * Inherits context, level, and transports from parent
	 */
	child(name: string): Logger {
		const options: LoggerOptions = { level: this.getLevelName() };
		// Preserve explicit transports (or lack thereof) for buffering behavior
		if (this.explicitTransports) {
			options.transports = this.explicitTransports;
		}
		const logger = new Logger(name, options, { ...this.context });
		// Preserve callback so setMeta on child loggers still updates AsyncLocalStorage
		if (this.setMetaCallback) {
			logger.onSetMeta(this.setMetaCallback);
		}
		return logger;
	}

	/**
	 * Returns headers for cross-service HTTP propagation
	 */
	propagationHeaders(): Record<string, string> {
		const headers: Record<string, string> = {};

		if (this.context.correlationId) {
			headers['x-request-id'] = String(this.context.correlationId);
		}

		// Encode additional context
		const propagationContext = this.getPropagationContext();
		if (Object.keys(propagationContext).length > 0) {
			headers['x-correlation-context'] = JSON.stringify(propagationContext);
		}

		return headers;
	}

	/**
	 * Returns metadata object for queue message propagation.
	 * All fields use camelCase - this is the framework standard.
	 */
	propagationMeta(): Record<string, unknown> {
		// Return the full context - all fields are already camelCase
		return { ...this.context };
	}

	/**
	 * Creates a logger from propagation metadata.
	 * All fields use camelCase - this is the framework standard.
	 *
	 * @param name - Logger name (e.g., workflow name, consumer name)
	 * @param meta - PropagationMeta from capturePropagationMeta()
	 * @param options - Optional logger configuration
	 */
	static fromMeta(name: string, meta: Record<string, unknown>, options: LoggerOptions = {}): Logger {
		// All fields are already camelCase, just copy them as context
		return new Logger(name, options, { ...meta });
	}

	/**
	 * Creates a simple console-based logger (fallback for no-context situations)
	 */
	static console(name = 'App'): Logger {
		return new Logger(name, { level: 'debug' }, {});
	}

	private log(level: LevelNumber, msg: string, data?: Record<string, unknown>): void {
		if (!isLevelEnabled(level, this.level)) {
			return;
		}

		const logObj: LogObject = {
			time: Date.now(),
			level,
			msg,
			name: this.name,
			...this.context,
			...data
		};

		this.writeLogObject(logObj);
	}

	private getLevelName(): LevelName {
		for (const [name, num] of Object.entries(levels)) {
			if (num === this.level) {
				return name as LevelName;
			}
		}
		return 'info';
	}

	private getPropagationContext(): Record<string, unknown> {
		const { correlationId: _correlationId, ...rest } = this.context;
		return rest;
	}

	private static defaultTransport(): Transport {
		return consoleTransport();
	}
}
