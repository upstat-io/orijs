import type { Transport, LogObject } from '../logger.ts';

/**
 * Multi transport - writes to multiple transports simultaneously.
 * Each transport is wrapped in try/catch to ensure one failing transport
 * doesn't prevent others from receiving the log.
 */
export function multiTransport(transports: Transport[]): Transport {
	return {
		write(obj: LogObject): void {
			for (const transport of transports) {
				try {
					transport.write(obj);
				} catch {
					// Silently ignore - one transport failing shouldn't break others
					// Logging the error would cause recursion if this IS the error handler
				}
			}
		},

		async flush(): Promise<void> {
			const results = await Promise.allSettled(transports.map((t) => t.flush()));

			// Collect errors but don't throw until all transports have flushed
			const errors = results
				.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
				.map((r) => r.reason);

			if (errors.length > 0) {
				throw new AggregateError(errors, `${errors.length} transport(s) failed to flush`);
			}
		},

		async close(): Promise<void> {
			const results = await Promise.allSettled(transports.map((t) => t.close()));

			// Collect errors but don't throw until all transports have closed
			const errors = results
				.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
				.map((r) => r.reason);

			if (errors.length > 0) {
				throw new AggregateError(errors, `${errors.length} transport(s) failed to close`);
			}
		}
	};
}
