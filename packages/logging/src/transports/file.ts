import type { Transport, LogObject } from '../logger.ts';
import { existsSync, unlinkSync, renameSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileRotateOptions {
	size?: string; // e.g., '10mb', '100kb'
	interval?: string; // e.g., '1d', '1h'
	keep?: number; // number of old files to keep
}

export interface FileTransportOptions {
	rotate?: FileRotateOptions;
	sync?: boolean;
	/** Optional callback for write errors (useful for monitoring) */
	onError?: (error: Error) => void;
}

function parseSize(size: string): number {
	const match = size.match(/^(\d+)(kb|mb|gb)?$/i);
	if (!match) {
		throw new Error(`Invalid size format: ${size}`);
	}

	const value = parseInt(match[1]!, 10);
	const unit = (match[2] ?? 'b').toLowerCase();

	switch (unit) {
		case 'kb':
			return value * 1024;
		case 'mb':
			return value * 1024 * 1024;
		case 'gb':
			return value * 1024 * 1024 * 1024;
		default:
			return value;
	}
}

function ensureDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function rotateFiles(basePath: string, keep: number): boolean {
	try {
		// Delete oldest if it exists
		const oldestPath = `${basePath}.${keep}`;
		if (existsSync(oldestPath)) {
			unlinkSync(oldestPath);
		}

		// Shift existing files
		for (let i = keep - 1; i >= 1; i--) {
			const from = `${basePath}.${i}`;
			const to = `${basePath}.${i + 1}`;
			if (existsSync(from)) {
				renameSync(from, to);
			}
		}

		// Move current to .1
		if (existsSync(basePath)) {
			renameSync(basePath, `${basePath}.1`);
		}
		return true;
	} catch {
		// Rotation failed - continue writing to current file
		// This is better than crashing the application
		return false;
	}
}

function getFileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/**
 * File transport - writes JSON logs to a file with optional rotation.
 *
 * @param path - File path (e.g., './logs/app.log')
 * @param options - Rotation and sync options
 */
export function fileTransport(path: string, options: FileTransportOptions = {}): Transport {
	const maxSize = options.rotate?.size ? parseSize(options.rotate.size) : null;
	const keep = options.rotate?.keep ?? 5;
	const isSync = options.sync ?? false;
	const onError = options.onError;

	let currentSize = 0;
	let writeBuffer: string[] = [];
	let flushScheduled = false;

	ensureDir(path);
	currentSize = getFileSize(path);

	function checkRotation(pendingBytes: number = 0): void {
		if (maxSize && currentSize + pendingBytes >= maxSize) {
			const rotated = rotateFiles(path, keep);
			if (rotated) {
				currentSize = 0;
			}
		}
	}

	async function flush(): Promise<void> {
		if (writeBuffer.length === 0) return;

		const data = writeBuffer.join('\n') + '\n';
		writeBuffer = [];
		flushScheduled = false;

		await appendFile(path, data);
	}

	/** Track consecutive write failures for circuit breaker pattern */
	let writeFailures = 0;
	const MAX_WRITE_FAILURES = 5;

	function scheduleFlush(): void {
		if (flushScheduled) return;
		flushScheduled = true;

		// Use setImmediate-like behavior for batching
		queueMicrotask(() => {
			flush()
				.then(() => {
					writeFailures = 0; // Reset on success
				})
				.catch((error: Error) => {
					writeFailures++;
					// Report error to callback if provided
					onError?.(error);
					// After too many failures, stop trying to prevent buffer growth
					if (writeFailures >= MAX_WRITE_FAILURES) {
						// CRITICAL: Log data loss warning to stderr before clearing
						const lostCount = writeBuffer.length;
						process.stderr.write(
							`[ori-logger] CRITICAL: Clearing ${lostCount} buffered log entries after ${MAX_WRITE_FAILURES} write failures. ` +
								`Last error: ${error.message}\n`
						);
						writeBuffer = []; // Clear buffer to prevent memory exhaustion
					}
				});
		});
	}

	return {
		write(obj: LogObject): void {
			const line = JSON.stringify(obj);
			const lineSize = line.length + 1; // +1 for newline

			// Check rotation BEFORE incrementing size, considering pending bytes
			checkRotation(lineSize);
			currentSize += lineSize;

			if (isSync) {
				// Sync write (blocking)
				appendFileSync(path, line + '\n');
			} else {
				// Async batched write
				writeBuffer.push(line);
				scheduleFlush();
			}
		},

		async flush(): Promise<void> {
			await flush();
		},

		async close(): Promise<void> {
			await flush();
		}
	};
}
