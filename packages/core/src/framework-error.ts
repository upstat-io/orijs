/**
 * Framework Error Handling
 *
 * Provides clean error messages for framework consumers while allowing
 * full stack traces for framework developers when debugging.
 *
 * Behavior controlled by ORIJS_DEBUG environment variable:
 * - ORIJS_DEBUG=true: Full stack traces with source code (for framework devs)
 * - ORIJS_DEBUG not set: Clean error messages only (for consumers)
 */

/**
 * Check if debug mode is enabled.
 * When enabled, framework errors show full stack traces.
 */
export function isDebugMode(): boolean {
	return Bun.env.ORIJS_DEBUG === 'true';
}

/**
 * Framework error for configuration/bootstrap issues.
 * Shows clean messages to consumers, full traces to framework developers.
 */
export class FrameworkError extends Error {
	public override readonly name = 'FrameworkError';

	constructor(message: string) {
		super(message);

		// Capture stack trace from call site
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, FrameworkError);
		}
	}
}

/**
 * Throw a framework error with clean output for consumers.
 * Use this for configuration/bootstrap errors that should be user-friendly.
 *
 * - Debug mode (ORIJS_DEBUG=true): throws error normally (shows stack trace)
 * - Normal mode: prints clean message and exits (no source code shown)
 *
 * @example
 * ```ts
 * if (errors.length > 0) {
 *   throwFrameworkError(
 *     'Dependency injection validation failed:\n\n' +
 *     errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
 *   );
 * }
 * ```
 */
export function throwFrameworkError(message: string): never {
	if (isDebugMode()) {
		throw new FrameworkError(message);
	}

	// Clean output for consumers - no source code shown
	console.error('\n' + message + '\n');
	process.exit(1);
}
