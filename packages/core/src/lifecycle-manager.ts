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

import type { Logger } from "@orijs/logging";

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
 * Signal handlers are cleaned up when the shutdown attempt settles.
 */
export class LifecycleManager {
  private readonly logger: Logger;
  private shutdownTimeoutMs: number;
  private enableSignalHandling: boolean;
  private signalHandlerCleanups: Array<() => void> = [];
  private isShuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownSucceeded = false;

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

  /** @internal Starts a new lifecycle only after the previous drain succeeded. */
  public resetForStartup(): void {
    if (this.shutdownPromise && !this.shutdownSucceeded) {
      throw new Error("Previous application shutdown did not succeed");
    }
    this.shutdownPromise = undefined;
    this.shutdownSucceeded = false;
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
      try {
        await onShutdown();
        process.exit(0);
      } catch {
        this.logger.error("Application shutdown failed");
        process.exit(1);
      }
    };

    // Named handlers so we can remove them later
    const sigtermHandler = () => shutdown("SIGTERM");
    const sigintHandler = () => shutdown("SIGINT");

    process.on("SIGTERM", sigtermHandler);
    process.on("SIGINT", sigintHandler);

    // Store cleanup functions
    this.signalHandlerCleanups.push(
      () => process.removeListener("SIGTERM", sigtermHandler),
      () => process.removeListener("SIGINT", sigintHandler),
    );
  }

  /**
   * Executes graceful shutdown with timeout protection.
   *
   * @param shutdownWork - Async function containing shutdown operations
   * Concurrent and subsequent callers observe the same outcome.
   * @returns Promise resolving only after shutdown work completes
   * @throws The shutdown error, or a deadline error while work may still run
   */
  public executeGracefulShutdown(
    shutdownWork: ShutdownCallback,
  ): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.isShuttingDown = true;
    this.shutdownPromise = this.awaitShutdown(shutdownWork);
    return this.shutdownPromise;
  }

  private async awaitShutdown(shutdownWork: ShutdownCallback): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // Defer invocation so a synchronous throw follows the same cleanup path.
    const shutdownPromise = Promise.resolve().then(shutdownWork);

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Shutdown timeout exceeded")),
        this.shutdownTimeoutMs,
      );
    });

    try {
      await Promise.race([shutdownPromise, timeoutPromise]);
      this.shutdownSucceeded = true;
    } catch (err) {
      this.logger.warn("Application shutdown did not complete", {
        timeoutMs: this.shutdownTimeoutMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.cleanupSignalHandlers();
      this.isShuttingDown = false;
    }
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
