/**
 * Async log buffer for high-performance logging (sonic-boom inspired).
 *
 * Responsibilities:
 * - Buffer log objects as JSON strings
 * - Flush to transports on interval or buffer size threshold
 * - Handle direct stdout writes for maximum performance
 *
 * This is a singleton managing global buffering state.
 */
import type { LogObject, Transport } from './types';
import { consoleTransport } from './transports/console';

// Default buffer settings (sonic-boom inspired)
/** Default flush interval in milliseconds */
export const DEFAULT_FLUSH_INTERVAL = 10;
/** Default buffer size before auto-flush (4KB) */
export const DEFAULT_BUFFER_SIZE = 4096;
/** Maximum write size per flush (16KB - docker buffer limit) */
export const MAX_WRITE_SIZE = 16 * 1024;
/** Maximum buffer size to prevent unbounded memory growth (1MB) */
export const MAX_BUFFER_SIZE = 1024 * 1024;

export interface LogBufferOptions {
	/** Enable async buffered writes (default: true) */
	enabled?: boolean;
	/** Buffer flush interval in ms (default: 10) */
	flushInterval?: number;
	/** Buffer size before auto-flush in bytes (default: 4096) */
	bufferSize?: number;
	/** Maximum buffer size before dropping logs (default: 1MB) */
	maxBufferSize?: number;
}

/**
 * Manages async buffering for log writes.
 * Uses string concatenation (sonic-boom style) for high performance.
 */
class LogBufferManager {
	private enabled = true;
	private buffer = '';
	private flushIntervalMs = DEFAULT_FLUSH_INTERVAL;
	private bufferSizeThreshold = DEFAULT_BUFFER_SIZE;
	private maxBufferSize = MAX_BUFFER_SIZE;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private writing = false;
	private droppedCount = 0;

	/** Get transport resolver - set by Logger during configure */
	private transportResolver: (() => Transport[] | null) | null = null;

	/**
	 * Configure buffer settings.
	 */
	configure(options: LogBufferOptions): void {
		this.enabled = options.enabled ?? true;
		this.flushIntervalMs = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
		this.bufferSizeThreshold = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
		this.maxBufferSize = options.maxBufferSize ?? MAX_BUFFER_SIZE;

		if (this.enabled && this.flushTimer === null) {
			this.startTimer();
		} else if (!this.enabled && this.flushTimer !== null) {
			this.stopTimer();
		}
	}

	/**
	 * Set the function to resolve transports (called during flush).
	 */
	setTransportResolver(resolver: () => Transport[] | null): void {
		this.transportResolver = resolver;
	}

	/**
	 * Check if async buffering is enabled.
	 */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Write a log object to the buffer.
	 * Returns true if buffered, false if should use sync write.
	 */
	write(logObj: LogObject): boolean {
		if (!this.enabled) {
			return false;
		}

		// Start flush timer lazily if not already running
		if (this.flushTimer === null) {
			this.startTimer();
		}

		// Sonic-boom style: serialize to JSON and concatenate strings
		const line = JSON.stringify(logObj) + '\n';

		// Check if adding this log would exceed max buffer size
		if (this.buffer.length + line.length > this.maxBufferSize) {
			this.droppedCount++;
			return true; // Return true to indicate "handled" (dropped, not sync write)
		}

		this.buffer += line;

		// Flush when buffer exceeds threshold
		if (this.buffer.length >= this.bufferSizeThreshold) {
			this.flush();
		}

		return true;
	}

	/**
	 * Flush buffered logs to transports.
	 *
	 * Thread-safety: JavaScript is single-threaded, so the `writing` flag check
	 * is atomic. The flag prevents re-entry if flush() is called while already
	 * flushing (e.g., from timer while threshold flush is running).
	 *
	 * The buffer is swapped immediately after setting `writing=true`, so new
	 * writes during flush go to a fresh buffer and won't be lost.
	 */
	flush(): void {
		// Early exit if already flushing
		if (this.writing) {
			return;
		}

		// Capture and reset dropped count (must happen before early return)
		const dropped = this.droppedCount;
		this.droppedCount = 0;

		// Early exit if nothing to flush and no dropped logs to report
		if (this.buffer.length === 0 && dropped === 0) {
			return;
		}

		// Atomically swap buffer before processing (JS is single-threaded)
		this.writing = true;
		let data = this.buffer;
		this.buffer = ''; // New writes go to fresh buffer

		// Prepend warning about dropped logs if any were dropped
		if (dropped > 0) {
			const warning: LogObject = {
				time: Date.now(),
				level: 40, // WARN level
				msg: `LogBuffer overflow: dropped ${dropped} log(s) due to buffer size limit`,
				name: 'LogBuffer'
			};
			data = JSON.stringify(warning) + '\n' + data;
		}

		try {
			const transports = this.transportResolver?.();

			// Use configured transports, or fall back to default console transport
			const outputTransports =
				transports && transports.length > 0 ? transports : [this.getDefaultTransport()];

			// Parse each line back to object and send to transports
			const lines = data.split('\n').filter((line) => line.length > 0);
			for (const line of lines) {
				let logObj: LogObject;
				try {
					logObj = JSON.parse(line) as LogObject;
				} catch (error) {
					// Log parse error to stderr (can't use logger - would cause infinite loop)
					// Truncate line preview to avoid flooding stderr with large corrupted data
					const preview = line.length > 100 ? line.slice(0, 100) + '...' : line;
					const errorMsg = error instanceof Error ? error.message : 'Unknown error';
					process.stderr.write(`[ori-logger] Buffer parse error: ${errorMsg} | Line: ${preview}\n`);
					continue;
				}

				// Send to each transport, catching errors to prevent one transport from blocking others
				for (const transport of outputTransports) {
					try {
						transport.write(logObj);
					} catch (error) {
						// Log transport error to stderr - don't lose the log, don't crash
						const errorMsg = error instanceof Error ? error.message : 'Unknown error';
						process.stderr.write(`[ori-logger] Transport write error: ${errorMsg}\n`);
					}
				}
			}
		} finally {
			// Always reset writing flag, even if transport throws
			this.writing = false;
		}
	}

	/**
	 * Reset buffer state. Used for test isolation.
	 * Discards buffered logs without flushing to stdout.
	 */
	reset(): void {
		this.stopTimer();
		// Don't flush - just discard the buffer to avoid spurious stdout output during tests
		this.buffer = '';
		this.enabled = true;
		this.flushIntervalMs = DEFAULT_FLUSH_INTERVAL;
		this.bufferSizeThreshold = DEFAULT_BUFFER_SIZE;
		this.maxBufferSize = MAX_BUFFER_SIZE;
		this.droppedCount = 0;
		this.writing = false;
		this.transportResolver = null;
		this.defaultTransport = null;
	}

	/**
	 * Returns the number of logs dropped due to buffer overflow.
	 * Useful for testing and monitoring.
	 */
	getDroppedCount(): number {
		return this.droppedCount;
	}

	/**
	 * Returns current buffer size in bytes.
	 * Useful for testing and monitoring.
	 */
	getBufferSize(): number {
		return this.buffer.length;
	}

	/**
	 * Shutdown the buffer - flushes and stops timer.
	 */
	shutdown(): void {
		this.stopTimer();
		this.flush();
	}

	private startTimer(): void {
		this.flushTimer = setInterval(() => {
			this.flush();
		}, this.flushIntervalMs);
		// Don't keep process alive just for logging
		this.flushTimer.unref?.();
	}

	private stopTimer(): void {
		if (this.flushTimer !== null) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}

	/** Cached default transport instance */
	private defaultTransport: Transport | null = null;

	private getDefaultTransport(): Transport {
		if (!this.defaultTransport) {
			this.defaultTransport = consoleTransport();
		}
		return this.defaultTransport;
	}
}

/**
 * Global log buffer instance (singleton).
 * Exported for use by Logger class.
 */
export const logBuffer = new LogBufferManager();
