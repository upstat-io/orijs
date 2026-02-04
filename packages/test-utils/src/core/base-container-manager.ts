/**
 * Base container manager with robust lifecycle management
 * Implements modern testcontainers best practices
 */

import type { StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';

export abstract class BaseContainerManager {
	protected container: StartedTestContainer | null = null;
	protected isStarted = false;
	protected packageName: string;
	protected maxRetries = 3;
	protected retryDelay = 2000;
	protected failures = 0;
	protected lastFailureTime = 0;
	protected readonly circuitBreakerThreshold = 5;
	protected readonly circuitBreakerTimeout = 30000;

	// Health check caching to avoid redundant checks
	private lastHealthCheckTime = 0;
	private lastHealthCheckResult = false;
	private readonly healthCheckCacheDuration = 30000; // Cache for 30 seconds

	constructor(packageName: string) {
		this.packageName = packageName;
	}

	/**
	 * Start container with retry logic and circuit breaker
	 */
	async start(): Promise<StartedTestContainer> {
		if (this.container && this.isStarted) {
			return this.container;
		}

		if (this.isCircuitBreakerOpen()) {
			throw new Error(`Circuit breaker is open for ${this.packageName} container`);
		}

		// Each retry gets 5 seconds, with 3 retries = max 15 seconds total
		return this.executeWithRetry(async () => {
			await this.cleanupFailedContainers();
			this.container = await this.createContainer();
			await this.verifyContainerHealth();
			this.isStarted = true;
			this.onSuccess();
			return this.container;
		});
	}

	/**
	 * Stop container gracefully with aggressive timeout protection
	 */
	async stop(): Promise<void> {
		if (!this.container) {
			return;
		}

		try {
			// Add overall timeout to prevent hanging
			await this.withTimeout(
				(async () => {
					try {
						await this.container!.stop({
							timeout: 5_000, // Reduced timeout
							remove: true,
							removeVolumes: true
						});
					} catch (error) {
						console.warn(`Failed to stop container gracefully, forcing removal:`, error);
						// Force remove immediately if graceful stop fails
						await this.container!.stop({ remove: true, timeout: 0 });
					}
				})(),
				10_000 // Maximum 10 seconds for entire stop operation
			);
		} catch (error) {
			console.warn(`Container stop timed out for ${this.packageName}, forcing cleanup:`, error);
			try {
				// Last resort: force stop with no timeout
				await this.container.stop({ remove: true, timeout: 0 });
			} catch (forceError) {
				console.warn(`Failed to force remove container:`, forceError);
			}
		} finally {
			this.container = null;
			this.isStarted = false;
		}
	}

	/**
	 * Check if container is ready
	 */
	isReady(): boolean {
		return this.isStarted && this.container !== null;
	}

	/**
	 * Perform health check with caching to avoid redundant checks
	 */
	async healthCheck(): Promise<boolean> {
		if (!this.container || !this.isStarted) {
			return false;
		}

		// Return cached result if still valid
		const now = Date.now();
		if (now - this.lastHealthCheckTime < this.healthCheckCacheDuration && this.lastHealthCheckResult) {
			return true;
		}

		try {
			this.lastHealthCheckResult = await this.performHealthCheck();
			this.lastHealthCheckTime = now;
			return this.lastHealthCheckResult;
		} catch (error) {
			console.warn(`Health check failed for ${this.packageName}:`, error);
			this.lastHealthCheckResult = false;
			this.lastHealthCheckTime = now;
			return false;
		}
	}

	/**
	 * Force cleanup for emergency scenarios
	 */
	async forceStop(): Promise<void> {
		try {
			await this.cleanupFailedContainers();
		} catch (error) {
			console.warn(`Force cleanup failed for ${this.packageName}:`, error);
		} finally {
			this.container = null;
			this.isStarted = false;
		}
	}

	/**
	 * Abstract methods to be implemented by subclasses
	 */
	protected abstract createContainer(): Promise<StartedTestContainer>;
	protected abstract performHealthCheck(): Promise<boolean>;
	protected abstract getContainerImage(): string;
	protected abstract getContainerType(): string;

	/**
	 * Execute operation with aggressive retry logic and immediate cleanup on failure
	 */
	private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
		let lastError: Error = new Error('Unknown error');

		for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
			try {
				// Wrap operation with 60-second timeout (containers can take time to start in CI)
				return await this.withTimeout(operation(), 60000);
			} catch (error) {
				lastError = error as Error;
				this.onFailure();
				console.warn(`Container start attempt ${attempt} failed for ${this.packageName}:`, lastError.message);

				if (attempt < this.maxRetries) {
					// Immediate aggressive cleanup on failure
					console.log(`Performing immediate cleanup after failure ${attempt}`);
					await this.aggressiveCleanup();

					// Short delay before retry (no exponential backoff - we want speed)
					await this.sleep(1000);
				}
			}
		}

		throw new Error(
			`Failed to start ${this.packageName} container after ${this.maxRetries} attempts. Last error: ${lastError.message}`
		);
	}

	/**
	 * Verify container health after startup with aggressive timeouts
	 */
	private async verifyContainerHealth(): Promise<void> {
		const maxChecks = 10; // Much more aggressive
		const checkInterval = 300; // Very fast checks

		for (let i = 0; i < maxChecks; i++) {
			try {
				if (await this.withTimeout(this.performHealthCheck(), 3000)) {
					// Shorter per-check timeout
					console.log(`Container health verified for ${this.packageName} after ${i + 1} checks`);
					return;
				}
			} catch (error) {
				console.warn(`Health check ${i + 1} failed for ${this.packageName}:`, (error as Error).message);
			}
			await this.sleep(checkInterval);
		}

		throw new Error(`Container failed health verification after ${maxChecks} attempts: ${this.packageName}`);
	}

	/**
	 * Clean up failed containers before retry
	 */
	private async cleanupFailedContainers(): Promise<void> {
		try {
			// Use docker CLI for cleanup since testcontainers client API varies
			// Kill and remove failed containers with testcontainers label
			const containerImage = this.getContainerImage();
			execSync(
				`docker ps -a --filter "label=org.testcontainers=true" --filter "ancestor=${containerImage}" --filter "status=exited" -q | xargs -r docker rm -f`,
				{ stdio: 'ignore' }
			);

			execSync(
				`docker ps -a --filter "label=org.testcontainers=true" --filter "ancestor=${containerImage}" --filter "status=dead" -q | xargs -r docker rm -f`,
				{ stdio: 'ignore' }
			);
		} catch (error) {
			console.warn(`Failed to cleanup failed containers for ${this.packageName}:`, error);
		}
	}

	/**
	 * Aggressive cleanup using direct Docker commands (for immediate retry scenarios)
	 * IMPORTANT: Only cleans up containers for THIS package to avoid killing parallel test containers
	 */
	private async aggressiveCleanup(): Promise<void> {
		try {
			// Kill containers for THIS package only
			const dbName = `orijs_test_${this.packageName}`;

			// Kill containers using our test database
			execSync(`docker ps -a --filter "env=POSTGRES_DB=${dbName}" -q | xargs -r docker kill`, {
				stdio: 'ignore'
			});
			execSync(`docker ps -a --filter "env=POSTGRES_DB=${dbName}" -q | xargs -r docker rm -f`, {
				stdio: 'ignore'
			});

			// NOTE: We intentionally do NOT kill all testcontainers here anymore.
			// The old behavior killed ALL containers with label=org.testcontainers=true,
			// which would destroy containers from parallel test suites.

			console.log(`Aggressive cleanup completed for ${this.packageName}`);
		} catch (error) {
			console.warn(`Aggressive cleanup failed for ${this.packageName}:`, error);
		}
	}

	/**
	 * Circuit breaker implementation
	 */
	private isCircuitBreakerOpen(): boolean {
		return (
			this.failures >= this.circuitBreakerThreshold &&
			Date.now() - this.lastFailureTime < this.circuitBreakerTimeout
		);
	}

	private onSuccess(): void {
		this.failures = 0;
	}

	private onFailure(): void {
		this.failures++;
		this.lastFailureTime = Date.now();
	}

	/**
	 * Add timeout to any operation to prevent hanging
	 */
	private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Operation timed out after ${timeoutMs}ms for ${this.packageName} container`));
			}, timeoutMs);
		});

		return Promise.race([promise, timeoutPromise]);
	}

	/**
	 * Utility sleep function
	 */
	protected sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
