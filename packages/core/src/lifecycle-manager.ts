/**
 * Lifecycle Manager - Handles application lifecycle concerns.
 *
 * Extracted from Application class to reduce its size and improve cohesion.
 * Manages:
 * - Signal handler registration (SIGTERM, SIGINT)
 * - Graceful shutdown with timeout
 * - Cleanup of registered handlers
 *
 * @module core/lifecycle-manager
 */

import type { Logger } from '@orijs/logging';

/** Options for lifecycle manager */
export interface LifecycleOptions {
	/** Logger for lifecycle events */
	logger: Logger;
	/** Graceful shutdown timeout in milliseconds (default: 10000) */
	shutdownTimeoutMs?: number;
	/** Whether to register signal handlers (default: true) */
	enableSignalHandling?: boolean;
}

/** Callback for shutdown operations */
export type ShutdownCallback = () => Promise<void>;

/**
 * Manages application lifecycle including signal handling and graceful shutdown.
 *
 * Uses WeakRef to avoid preventing garbage collection of the parent application.
 * Signal handlers are cleaned up when stop() is called.
 */
export class LifecycleManager {
	private readonly logger: Logger;
	private shutdownTimeoutMs: number;
	private enableSignalHandling: boolean;
	private signalHandlerCleanups: Array<() => void> = [];
	private isShuttingDown = false;

	constructor(options: LifecycleOptions) {
		this.logger = options.logger;
		this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10000;
		this.enableSignalHandling = options.enableSignalHandling ?? true;
	}

	/**
	 * Sets the graceful shutdown timeout in milliseconds.
	 * @param timeoutMs - Timeout in milliseconds
	 */
	public setShutdownTimeout(timeoutMs: number): void {
		this.shutdownTimeoutMs = timeoutMs;
	}

	/**
	 * Disables signal handling (useful for tests).
	 * Must be called before registerSignalHandlers().
	 */
	public disableSignalHandling(): void {
		this.enableSignalHandling = false;
	}

	/**
	 * Registers SIGTERM and SIGINT handlers for graceful shutdown.
	 *
	 * @param onShutdown - Callback to execute during shutdown (should call stop())
	 */
	public registerSignalHandlers(onShutdown: () => Promise<void>): void {
		if (!this.enableSignalHandling) {
			return;
		}

		// Skip if handlers already registered
		if (this.signalHandlerCleanups.length > 0) {
			return;
		}

		const shutdown = async (signal: string) => {
			this.logger.info(`Received Shutdown Signal: ${signal}`);
			await onShutdown();
			process.exit(0);
		};

		// Named handlers so we can remove them later
		const sigtermHandler = () => shutdown('SIGTERM');
		const sigintHandler = () => shutdown('SIGINT');

		process.on('SIGTERM', sigtermHandler);
		process.on('SIGINT', sigintHandler);

		// Store cleanup functions
		this.signalHandlerCleanups.push(
			() => process.removeListener('SIGTERM', sigtermHandler),
			() => process.removeListener('SIGINT', sigintHandler)
		);
	}

	/**
	 * Executes graceful shutdown with timeout protection.
	 *
	 * @param shutdownWork - Async function containing shutdown operations
	 * @returns Promise that resolves when shutdown completes (or times out)
	 */
	public async executeGracefulShutdown(shutdownWork: ShutdownCallback): Promise<void> {
		// Guard against multiple calls
		if (this.isShuttingDown) {
			return;
		}
		this.isShuttingDown = true;

		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const shutdownPromise = shutdownWork();

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error('Shutdown timeout exceeded')), this.shutdownTimeoutMs);
		});

		try {
			await Promise.race([shutdownPromise, timeoutPromise]);
		} catch (err) {
			this.logger.warn('Shutdown Timeout: forcing stop', {
				timeoutMs: this.shutdownTimeoutMs,
				error: err instanceof Error ? err.message : String(err)
			});
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		}

		// Clean up signal handlers to prevent memory leaks
		this.cleanupSignalHandlers();

		this.isShuttingDown = false;
	}

	/**
	 * Removes all registered signal handlers.
	 * Called automatically during shutdown, but can be called manually.
	 */
	public cleanupSignalHandlers(): void {
		for (const cleanup of this.signalHandlerCleanups) {
			cleanup();
		}
		this.signalHandlerCleanups = [];
	}

	/** Returns whether shutdown is in progress */
	public isInShutdown(): boolean {
		return this.isShuttingDown;
	}
}
