/**
 * Duration Parser
 *
 * Converts human-readable duration strings to seconds.
 * Supports: s (seconds), m (minutes), h (hours), d (days)
 *
 * @example
 * parseDuration('5m')  // 300
 * parseDuration('1h')  // 3600
 * parseDuration('30s') // 30
 * parseDuration('1d')  // 86400
 * parseDuration(60)    // 60 (passthrough)
 */

import type { Duration } from './types';

/**
 * Duration unit multipliers (in seconds)
 */
const UNITS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400
};

// Extract known units for cleaner code (avoids confusing a! === b pattern)
const SECONDS_PER_DAY = UNITS['d']!;
const SECONDS_PER_HOUR = UNITS['h']!;
const SECONDS_PER_MINUTE = UNITS['m']!;

/**
 * Maximum allowed duration: 365 days in seconds
 * Prevents overflow and unreasonable cache TTLs
 */
export const MAX_DURATION_SECONDS = 365 * 86400; // 31,536,000 seconds

/**
 * Parse a duration value to seconds
 *
 * @param duration - Number (seconds) or string ('5m', '1h', '30s', '1d')
 * @returns Number of seconds
 * @throws Error if duration format is invalid
 */
export function parseDuration(duration: Duration): number {
	// Numeric passthrough
	if (typeof duration === 'number') {
		if (!Number.isFinite(duration)) {
			throw new Error('Duration must be a finite number');
		}
		if (duration < 0) {
			throw new Error('Duration must be non-negative');
		}
		if (duration > MAX_DURATION_SECONDS) {
			throw new Error(`Duration exceeds maximum of 365 days (${MAX_DURATION_SECONDS} seconds)`);
		}
		return duration;
	}

	// String parsing
	if (!duration || typeof duration !== 'string') {
		throw new Error('Invalid duration format: empty or not a string');
	}

	// Handle '0' or '0s' etc
	if (duration === '0') {
		return 0;
	}

	// Match pattern: integer followed by unit (case-insensitive)
	const match = duration.toLowerCase().match(/^(\d+)([smhd])$/);
	if (!match) {
		throw new Error(`Invalid duration format: ${duration}`);
	}

	const [, valueStr, unit] = match;
	const value = parseInt(valueStr!, 10);

	// Zero is valid (no-cache)
	if (value === 0) {
		return 0;
	}

	const multiplier = UNITS[unit!];
	if (multiplier === undefined) {
		throw new Error(`Unknown duration unit: ${unit}`);
	}

	const seconds = value * multiplier;
	if (seconds > MAX_DURATION_SECONDS) {
		throw new Error(`Duration exceeds maximum of 365 days (${MAX_DURATION_SECONDS} seconds)`);
	}

	return seconds;
}

/**
 * Format seconds back to human-readable duration string
 * Useful for logging and debugging
 *
 * @param seconds - Number of seconds
 * @returns Human-readable string (e.g., '5m', '1h', '1d')
 */
export function formatDuration(seconds: number): string {
	if (seconds < 0) {
		throw new Error('Duration must be non-negative');
	}

	if (seconds === 0) {
		return '0s';
	}

	// Try to find the best unit (prefer larger units when evenly divisible)
	if (seconds >= SECONDS_PER_DAY && seconds % SECONDS_PER_DAY === 0) {
		return `${seconds / SECONDS_PER_DAY}d`;
	}
	if (seconds >= SECONDS_PER_HOUR && seconds % SECONDS_PER_HOUR === 0) {
		return `${seconds / SECONDS_PER_HOUR}h`;
	}
	if (seconds >= SECONDS_PER_MINUTE && seconds % SECONDS_PER_MINUTE === 0) {
		return `${seconds / SECONDS_PER_MINUTE}m`;
	}

	return `${seconds}s`;
}
