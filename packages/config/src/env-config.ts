import type { ConfigProvider } from './types';

/**
 * Configuration provider that reads from environment variables.
 *
 * Uses Bun.env which automatically loads:
 * 1. Shell environment variables
 * 2. .env.local
 * 3. .env.{NODE_ENV} (e.g., .env.development)
 * 4. .env
 *
 * This is the default provider for local development.
 * Wrap with ValidatedConfig to add key tracking and validation.
 *
 * @example
 * ```ts
 * // Simple usage
 * const config = new EnvConfigProvider();
 * const dbUrl = await config.getRequired('DATABASE_URL');
 *
 * // With validation (recommended)
 * const config = new ValidatedConfig(new EnvConfigProvider())
 *   .expectKeys('DATABASE_URL', 'REDIS_URL')
 *   .onFail('error')
 *   .validate();
 * ```
 */
export class EnvConfigProvider implements ConfigProvider {
	/**
	 * Gets an environment variable value.
	 * @param key - The environment variable name
	 * @returns The value, or undefined if not set
	 */
	async get(key: string): Promise<string | undefined> {
		return Bun.env[key];
	}

	/**
	 * Gets a required environment variable.
	 * @param key - The environment variable name
	 * @throws Error if the variable is not set or empty
	 */
	async getRequired(key: string): Promise<string> {
		const value = Bun.env[key];
		if (value === undefined || value === '') {
			throw new Error(`Required config '${key}' is not set. Add it to your .env file or environment.`);
		}
		return value;
	}

	/**
	 * Loads multiple environment variables at once.
	 * @param keys - The keys to load
	 * @returns Key-value pairs for the requested keys
	 */
	async loadKeys(keys: string[]): Promise<Record<string, string | undefined>> {
		const result: Record<string, string | undefined> = {};
		for (const key of keys) {
			result[key] = Bun.env[key];
		}
		return result;
	}
}
