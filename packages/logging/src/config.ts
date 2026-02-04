import type { Transport, LoggerOptions } from './logger';
import type { LevelName } from './levels';
import { consoleTransport } from './transports/console';
import { fileTransport } from './transports/file';
import { filterTransport } from './transports/filter';
import { multiTransport } from './transports/multi';

/**
 * Minimal ConfigProvider interface for logging configuration.
 * Defined locally to avoid circular dependency with @orijs/config.
 */
interface ConfigProvider {
	get(key: string): Promise<string | undefined>;
	getRequired(key: string): Promise<string>;
	loadKeys(keys: string[]): Promise<Record<string, string | undefined>>;
}

/**
 * Logging configuration read from config provider.
 */
export interface LogConfig {
	/** Log level threshold (debug, info, warn, error). Default: 'info' */
	level: LevelName;
	/** Logger names to include (empty = all) */
	includeNames: string[];
	/** Logger names to exclude */
	excludeNames: string[];
	/** Enable file logging */
	fileEnabled: boolean;
	/** File path for logs. Default: './logs/app.log' */
	filePath: string;
	/** Max file size before rotation (e.g., '10mb'). Default: '10mb' */
	fileMaxSize: string;
	/** Number of rotated files to keep. Default: 5 */
	fileMaxFiles: number;
	/** Use JSON format (production) vs pretty format (dev) */
	jsonFormat: boolean;
}

const DEFAULT_CONFIG: LogConfig = {
	level: 'info',
	includeNames: [],
	excludeNames: [],
	fileEnabled: false,
	filePath: './logs/app.log',
	fileMaxSize: '10mb',
	fileMaxFiles: 5,
	jsonFormat: false
};

/**
 * Parse comma-separated string into array, filtering empty values.
 */
function parseList(value: string | undefined): string[] {
	if (!value || value.trim() === '') return [];
	return value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Parse a size string, normalizing common formats.
 * Accepts: '10m', '10mb', '10MB', '100kb', etc.
 */
function normalizeSize(value: string | undefined, defaultValue: string): string {
	if (!value) return defaultValue;
	// Normalize: ensure lowercase and 'mb' suffix
	const normalized = value.toLowerCase().replace(/^(\d+)m$/, '$1mb');
	return normalized;
}

/**
 * Read logging configuration from a config provider.
 *
 * Reads these keys:
 * - LOG_LEVEL: debug | info | warn | error (default: info)
 * - LOG_INCLUDE_NAMES: comma-separated logger names to include
 * - LOG_EXCLUDE_NAMES: comma-separated logger names to exclude
 * - LOG_FILE_ENABLED: true | false (default: false)
 * - LOG_FILE_PATH: file path (default: ./logs/app.log)
 * - LOG_FILE_MAX_SIZE: size with unit (default: 10mb)
 * - LOG_FILE_MAX_COUNT: number of files (default: 5)
 * - LOG_JSON: true | false (default: false)
 */
export async function readLogConfig(config: ConfigProvider): Promise<LogConfig> {
	const level = (await config.get('LOG_LEVEL')) as LevelName | undefined;
	const includeNames = await config.get('LOG_INCLUDE_NAMES');
	const excludeNames = await config.get('LOG_EXCLUDE_NAMES');
	const fileEnabled = await config.get('LOG_FILE_ENABLED');
	const filePath = await config.get('LOG_FILE_PATH');
	const fileMaxSize = await config.get('LOG_FILE_MAX_SIZE');
	const fileMaxCount = await config.get('LOG_FILE_MAX_COUNT');
	const jsonFormat = await config.get('LOG_JSON');

	return {
		level: level && ['debug', 'info', 'warn', 'error'].includes(level) ? level : DEFAULT_CONFIG.level,
		includeNames: parseList(includeNames),
		excludeNames: parseList(excludeNames),
		fileEnabled: fileEnabled === 'true',
		filePath: filePath || DEFAULT_CONFIG.filePath,
		fileMaxSize: normalizeSize(fileMaxSize, DEFAULT_CONFIG.fileMaxSize),
		fileMaxFiles: fileMaxCount ? parseInt(fileMaxCount, 10) : DEFAULT_CONFIG.fileMaxFiles,
		jsonFormat: jsonFormat === 'true'
	};
}

/**
 * Build logger options from a LogConfig.
 *
 * @example
 * ```ts
 * const logConfig = await readLogConfig(config);
 * const loggerOptions = buildLoggerOptions(logConfig);
 *
 * Ori.create()
 *   .logger(loggerOptions)
 *   .listen(3000);
 * ```
 */
export function buildLoggerOptions(config: LogConfig): LoggerOptions {
	const transports: Transport[] = [];

	// Console transport
	let consoleT: Transport = consoleTransport({
		json: config.jsonFormat,
		pretty: !config.jsonFormat
	});

	// File transport (if enabled)
	let fileT: Transport | null = null;
	if (config.fileEnabled) {
		fileT = fileTransport(config.filePath, {
			rotate: {
				size: config.fileMaxSize,
				keep: config.fileMaxFiles
			}
		});
	}

	// Apply name filtering if configured
	const hasFilter = config.includeNames.length > 0 || config.excludeNames.length > 0;
	if (hasFilter) {
		consoleT = filterTransport(consoleT, {
			includeNames: config.includeNames.length > 0 ? config.includeNames : undefined,
			excludeNames: config.excludeNames.length > 0 ? config.excludeNames : undefined
		});

		if (fileT) {
			fileT = filterTransport(fileT, {
				includeNames: config.includeNames.length > 0 ? config.includeNames : undefined,
				excludeNames: config.excludeNames.length > 0 ? config.excludeNames : undefined
			});
		}
	}

	transports.push(consoleT);
	if (fileT) {
		transports.push(fileT);
	}

	return {
		level: config.level,
		transports: transports.length > 1 ? [multiTransport(transports)] : transports
	};
}

/**
 * Convenience function to create logger options directly from config provider.
 *
 * @example
 * ```ts
 * const loggerOptions = await createLoggerOptionsFromConfig(config);
 *
 * Ori.create()
 *   .logger({ ...loggerOptions, clearConsole: !isProduction })
 *   .listen(3000);
 * ```
 */
export async function createLoggerOptionsFromConfig(config: ConfigProvider): Promise<LoggerOptions> {
	const logConfig = await readLogConfig(config);
	return buildLoggerOptions(logConfig);
}
