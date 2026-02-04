/**
 * Configuration provider interface.
 *
 * OriJS uses a provider-based config system where the implementation
 * can be swapped based on environment:
 * - Development: EnvConfigProvider (reads from Bun.env)
 * - Production: Custom provider (e.g., Google Secrets Manager)
 *
 * @example
 * ```ts
 * // app.ts
 * const configProvider = hasEnvFile
 *   ? new EnvConfigProvider()
 *   : await GsmConfigProvider.create();
 *
 * Ori.create()
 *   .config(configProvider)
 *   .provider(MyService, [AppContext])
 *   .listen(3000);
 *
 * // In service
 * class MyService {
 *   constructor(private app: AppContext) {}
 *   async doThing() {
 *     const secret = await this.app.config.getRequired('SECRET_API_KEY');
 *   }
 * }
 * ```
 */
export interface ConfigProvider {
	/**
	 * Gets a configuration value by key.
	 * @param key - The configuration key
	 * @returns The value, or undefined if not found
	 */
	get(key: string): Promise<string | undefined>;

	/**
	 * Gets a required configuration value.
	 * @param key - The configuration key
	 * @throws Error if the value is not found or empty
	 */
	getRequired(key: string): Promise<string>;

	/**
	 * Loads multiple configuration values at once.
	 * Called during startup to eagerly cache values for sync access.
	 * @param keys - The keys to load
	 * @returns Key-value pairs for the requested keys
	 */
	loadKeys(keys: string[]): Promise<Record<string, string | undefined>>;
}
