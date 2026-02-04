/**
 * Async Test Helpers
 *
 * Utilities for handling asynchronous operations in tests without relying
 * on arbitrary fixed delays. These helpers provide deterministic waiting
 * patterns that are more reliable in CI environments.
 *
 * @example
 * // Instead of arbitrary delays:
 * await new Promise(r => setTimeout(r, 200)); // BAD - flaky
 *
 * // Use polling assertions:
 * await waitFor(() => messages.length > 0); // GOOD - deterministic
 *
 * @example
 * // Wait for async condition with custom timeout:
 * await waitFor(
 *   () => provider.getConnectionCount() === 2,
 *   { timeout: 5000, interval: 100 }
 * );
 *
 * @example
 * // Wrap a promise with timeout to prevent hanging tests:
 * const result = await withTimeout(
 *   fetchData(),
 *   3000,
 *   'Data fetch took too long'
 * );
 */

/**
 * Options for the waitFor helper.
 */
export interface WaitForOptions {
	/**
	 * Maximum time to wait in milliseconds before throwing.
	 * @default 5000
	 */
	readonly timeout?: number;

	/**
	 * Interval between condition checks in milliseconds.
	 * @default 50
	 */
	readonly interval?: number;

	/**
	 * Custom error message when timeout is reached.
	 * If not provided, a default message with the timeout value is used.
	 */
	readonly message?: string;
}

/**
 * Waits for a synchronous condition to become true by polling.
 *
 * Use this instead of fixed `setTimeout` delays when waiting for:
 * - Messages to arrive in a mock
 * - State changes after async operations
 * - Redis pub/sub message delivery
 * - Any observable state change
 *
 * @param condition - Function that returns true when the wait should end
 * @param options - Configuration for timeout and polling interval
 * @throws Error if condition is not met within the timeout period
 *
 * @example
 * // Wait for messages to arrive
 * const messages: string[] = [];
 * someEmitter.on('message', (m) => messages.push(m));
 *
 * await waitFor(() => messages.length >= 2);
 * expect(messages).toHaveLength(2);
 *
 * @example
 * // Wait with custom timeout for slow operations
 * await waitFor(
 *   () => database.isConnected(),
 *   { timeout: 10000, message: 'Database connection timeout' }
 * );
 */
export async function waitFor(condition: () => boolean, options: WaitForOptions = {}): Promise<void> {
	const { timeout = 5000, interval = 50, message } = options;
	const start = Date.now();

	while (!condition()) {
		const elapsed = Date.now() - start;
		if (elapsed > timeout) {
			const errorMessage = message ?? `waitFor timeout after ${timeout}ms`;
			throw new Error(errorMessage);
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}

/**
 * Waits for an async condition to become true by polling.
 *
 * Similar to `waitFor` but the condition function can be async.
 * Useful when the condition itself requires async operations like
 * database queries or API calls.
 *
 * @param condition - Async function that returns true when the wait should end
 * @param options - Configuration for timeout and polling interval
 * @throws Error if condition is not met within the timeout period
 *
 * @example
 * // Wait for database record to exist
 * await waitForAsync(
 *   async () => {
 *     const record = await db.findById(id);
 *     return record !== null;
 *   },
 *   { timeout: 5000 }
 * );
 */
export async function waitForAsync(
	condition: () => Promise<boolean>,
	options: WaitForOptions = {}
): Promise<void> {
	const { timeout = 5000, interval = 50, message } = options;
	const start = Date.now();

	while (!(await condition())) {
		const elapsed = Date.now() - start;
		if (elapsed > timeout) {
			const errorMessage = message ?? `waitForAsync timeout after ${timeout}ms`;
			throw new Error(errorMessage);
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}

/**
 * Wraps a promise with a timeout, rejecting if it doesn't resolve in time.
 *
 * Use this to prevent tests from hanging indefinitely when an operation
 * might never complete due to bugs or infrastructure issues.
 *
 * @param promise - The promise to wrap with a timeout
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param message - Custom error message for timeout (optional)
 * @returns The resolved value of the promise
 * @throws Error if the promise doesn't resolve within the timeout
 *
 * @example
 * // Prevent hanging on network operations
 * const data = await withTimeout(
 *   fetch('https://api.example.com/data'),
 *   5000,
 *   'API request timed out'
 * );
 *
 * @example
 * // Use with workflow completion
 * const result = await withTimeout(
 *   workflow.waitForCompletion(),
 *   30000,
 *   'Workflow did not complete in time'
 * );
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message = 'Operation timed out'
): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => reject(new Error(`${message} (after ${timeoutMs}ms)`)), timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

/**
 * Simple delay helper for cases where a fixed wait is actually appropriate.
 *
 * Use sparingly - prefer `waitFor` with a condition when possible.
 * Appropriate uses include:
 * - Allowing time for background cleanup after tests
 * - Rate limiting between operations
 * - Simulating real-world timing in specific scenarios
 *
 * @param ms - Time to wait in milliseconds
 *
 * @example
 * // Allow cleanup between tests
 * afterEach(async () => {
 *   await provider.stop();
 *   await delay(50); // Allow background cleanup
 * });
 */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
