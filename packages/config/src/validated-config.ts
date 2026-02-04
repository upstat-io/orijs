import type { ConfigProvider } from './types';
import { Logger } from '@orijs/logging';

/**
 * Result of validating expected config keys.
 */
export interface ConfigValidationResult {
	valid: boolean;
	missing: string[];
	present: string[];
}

export type FailMode = 'error' | 'warn';

/**
 * Wrapper that adds validation and tracking to any ConfigProvider.
 *
 * Keeps providers simple (just get/getRequired) while adding:
 * - Expected key validation with fail-fast on startup
 * - Key access tracking for debugging
 * - Configurable error vs warn behavior
 *
 * @example
 * ```ts
 * // Wrap any provider with validation
 * const config = new ValidatedConfig(new EnvConfigProvider())
 *   .expectKeys('DATABASE_URL', 'REDIS_URL', 'SECRET_JWT')
 *   .onFail('error')  // or 'warn' (default)
 *   .validate();
 *
 * // Use normally - delegates to wrapped provider
 * const dbUrl = await config.getRequired('DATABASE_URL');
 *
 * // See what was accessed
 * config.logLoadedKeys();
 * ```
 */
export class ValidatedConfig implements ConfigProvider {
	private readonly log: Logger;
	private readonly loadedKeys = new Set<string>();
	private readonly expectedKeys = new Set<string>();
	private readonly validatedMissingKeys = new Set<string>();
	private readonly cache = new Map<string, string | undefined>();
	private failMode: FailMode = 'warn';
	private validated = false;

	constructor(
		private readonly provider: ConfigProvider,
		logger?: Logger
	) {
		this.log = logger ?? new Logger('Config');
	}

	/**
	 * Declare keys that must be present for the application to run.
	 * Call validate() after to check all at once.
	 */
	expectKeys(...keys: string[]): this {
		for (const key of keys) {
			this.expectedKeys.add(key);
		}
		return this;
	}

	/**
	 * Set behavior when validation fails.
	 * - 'warn': Log warnings but continue (default)
	 * - 'error': Throw error and stop startup
	 */
	onFail(mode: FailMode): this {
		this.failMode = mode;
		return this;
	}

	/**
	 * Validates that all expected keys are present and non-empty.
	 * Behavior depends on onFail() setting.
	 */
	async validate(): Promise<this> {
		const result = await this.checkExpectedKeys();

		if (!result.valid) {
			// Track missing keys for warn mode behavior
			for (const key of result.missing) {
				this.validatedMissingKeys.add(key);
			}

			const missingList = result.missing.join(', ');
			const message = `Missing required config keys: ${missingList}`;

			if (this.failMode === 'error') {
				this.log.error(message);
				throw new Error(message);
			} else {
				this.log.warn(message);
			}
		} else {
			this.log.info(`Config Validated: ${result.present.length} expected keys present`);
		}

		this.validated = true;
		return this;
	}

	/**
	 * Checks expected keys without throwing or logging.
	 * Caches all values for sync access after validation.
	 */
	async checkExpectedKeys(): Promise<ConfigValidationResult> {
		const missing: string[] = [];
		const present: string[] = [];

		for (const key of this.expectedKeys) {
			const value = await this.provider.get(key);
			// Cache all values (including undefined) for sync access
			this.cache.set(key, value);

			if (value === undefined || value === '') {
				missing.push(key);
			} else {
				present.push(key);
			}
		}

		return {
			valid: missing.length === 0,
			missing,
			present
		};
	}

	/**
	 * Gets a configuration value. Tracks key access.
	 */
	async get(key: string): Promise<string | undefined> {
		this.trackKey(key);
		return this.provider.get(key);
	}

	/**
	 * Gets a required configuration value. Tracks key access.
	 * Always throws for missing keys - use get() for optional values.
	 */
	async getRequired(key: string): Promise<string> {
		this.trackKey(key);

		// Always throw for missing required keys - use get() for optional values
		// Even in warn mode, getRequired() should fail for missing keys
		return this.provider.getRequired(key);
	}

	/**
	 * Synchronously gets a cached configuration value.
	 * Only works for keys that were included in expectKeys() and validated.
	 * @throws Error if key was not in expectedKeys or validate() hasn't been called
	 */
	getSync(key: string): string | undefined {
		if (!this.validated) {
			throw new Error('Cannot use getSync() before validate() is called');
		}
		if (!this.cache.has(key)) {
			throw new Error(`Key "${key}" was not in expectedKeys - add it to expectKeys() for sync access`);
		}
		this.trackKey(key);
		return this.cache.get(key);
	}

	/**
	 * Synchronously gets a required cached configuration value.
	 * Only works for keys that were included in expectKeys() and validated.
	 * @throws Error if key was not in expectedKeys, validate() hasn't been called, or value is missing
	 */
	getRequiredSync(key: string): string {
		const value = this.getSync(key);

		// Always throw for missing required keys - use getSync() for optional values
		if (value === undefined || value === '') {
			throw new Error(`Required config key "${key}" is missing or empty`);
		}
		return value;
	}

	/**
	 * Loads multiple configuration values from the underlying provider.
	 * @param keys - The keys to load
	 * @returns Key-value pairs for the requested keys
	 */
	async loadKeys(keys: string[]): Promise<Record<string, string | undefined>> {
		return this.provider.loadKeys(keys);
	}

	/**
	 * Returns all config keys that have been accessed.
	 */
	getLoadedKeys(): string[] {
		return [...this.loadedKeys];
	}

	/**
	 * Logs summary of all accessed keys.
	 */
	logLoadedKeys(): void {
		const keys = this.getLoadedKeys();
		if (keys.length === 0) {
			this.log.info('No Config Keys Accessed');
		} else {
			this.log.info(`Config Keys Accessed: ${keys.join(', ')}`);
		}
	}

	private trackKey(key: string): void {
		if (!this.loadedKeys.has(key)) {
			this.loadedKeys.add(key);
			this.log.debug(`Config Key Accessed: ${key}`);
		}
	}
}
