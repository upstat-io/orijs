/**
 * Shared constants for @orijs/bullmq package.
 *
 * @module constants
 */

/**
 * Default timeout in milliseconds for request-response patterns.
 * Used by both event emit with waitForResult and completion tracking.
 * 30 seconds provides a reasonable balance between allowing slow operations
 * and preventing indefinite waits.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
