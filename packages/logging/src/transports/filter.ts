import type { Transport, LogObject } from '../logger.ts';

export interface FilterOptions {
	/** Only log these names (empty = all) */
	includeNames?: string[];
	/** Never log these names */
	excludeNames?: string[];
}

/**
 * Filter transport - wraps another transport and filters by logger name.
 *
 * @example
 * ```ts
 * // Only log from specific services
 * filterTransport(consoleTransport(), {
 *   includeNames: ['AuthService', 'UserService']
 * })
 *
 * // Exclude noisy loggers
 * filterTransport(consoleTransport(), {
 *   excludeNames: ['HealthCheck', 'Metrics']
 * })
 * ```
 */
export function filterTransport(transport: Transport, options: FilterOptions): Transport {
	const includeSet = options.includeNames?.length ? new Set(options.includeNames) : null;
	const excludeSet = options.excludeNames?.length ? new Set(options.excludeNames) : null;

	function shouldLog(name?: string): boolean {
		if (!name) return true;

		// If include list exists, name must be in it
		if (includeSet && !includeSet.has(name)) {
			return false;
		}

		// If exclude list exists, name must not be in it
		if (excludeSet && excludeSet.has(name)) {
			return false;
		}

		return true;
	}

	return {
		write(obj: LogObject): void {
			if (shouldLog(obj.name)) {
				transport.write(obj);
			}
		},

		async flush(): Promise<void> {
			await transport.flush();
		},

		async close(): Promise<void> {
			await transport.close();
		}
	};
}
