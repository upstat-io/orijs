/**
 * Logging level utilities.
 */
import type { LevelName, LevelNumber } from './types';

// Re-export for backwards compatibility
export type { LevelName, LevelNumber };

/**
 * Mapping of log level names to their numeric values
 */
export type LogLevels = Record<LevelName, LevelNumber>;

/**
 * Log level constants (Pino-compatible numbering)
 */
export const levels: LogLevels = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

const levelNames: Record<LevelNumber, LevelName> = {
	10: 'debug',
	20: 'info',
	30: 'warn',
	40: 'error'
};

export function getLevelName(level: LevelNumber): LevelName {
	return levelNames[level];
}

export function getLevelNumber(name: LevelName): LevelNumber {
	return levels[name];
}

export function isLevelEnabled(current: LevelNumber, threshold: LevelNumber): boolean {
	return current >= threshold;
}
