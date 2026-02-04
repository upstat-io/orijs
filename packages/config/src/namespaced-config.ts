import type { ConfigProvider } from './types';
import { Logger } from '@orijs/logging';

export type FailMode = 'error' | 'warn';

/**
 * A class constructor that creates a ConfigProvider.
 */
export type ConfigProviderConstructor = new () => ConfigProvider;

/**
 * A factory object with a static create method.
 */
export interface ConfigProviderFactory {
	create(): Promise<ConfigProvider>;
}

/**
 * A config provider - can be an instance, constructor, or factory.
 */
export type ConfigProviderInput = ConfigProvider | ConfigProviderConstructor | ConfigProviderFactory;

/**
 * Type guard to check if input is a factory object with create() method.
 */
function isConfigProviderFactory(input: ConfigProviderInput): input is ConfigProviderFactory {
	return (
		typeof input === 'object' && input !== null && 'create' in input && typeof input.create === 'function'
	);
}

/**
 * Type guard to check if input is a constructor function.
 */
function isConfigProviderConstructor(input: ConfigProviderInput): input is ConfigProviderConstructor {
	return typeof input === 'function';
}

/**
 * Result of validating expected config keys.
 */
export interface NamespacedValidationResult {
	valid: boolean;
	missing: { namespace: string; key: string }[];
	present: { namespace: string; key: string }[];
}

/**
 * A config transformer - pure function that derives a property from validated config.
 *
 * @example
 * ```ts
 * const RedisConfigTransformer: ConfigTransformer<{ secrets: SecretsConfig }, RedisConfig> = {
 *   property: 'redis',
 *   transform: (config) => ({
 *     host: config.secrets.SECRET_REDIS_HOST,
 *     port: Number(config.secrets.SECRET_REDIS_PORT) || 6379,
 *   }),
 * };
 * ```
 */
export interface ConfigTransformer<TInput = unknown, TOutput = unknown> {
	/** The property name to add to the config */
	readonly property: string;
	/** Pure function that derives the value from validated config */
	readonly transform: (config: TInput) => TOutput;
}

/**
 * Sync accessor for a namespace's cached config values.
 */
export type NamespaceAccessor = Record<string, string | undefined>;

/**
 * The validated config object with namespaced access.
 * Access values via config.namespace.KEY
 */
export type NamespacedConfigResult = {
	env: NamespaceAccessor;
	[namespace: string]: NamespaceAccessor;
};

/**
 * Builder for creating a namespaced config with multiple providers.
 *
 * The `env` namespace is always available and reads from Bun.env.
 * Additional namespaces can be added for cloud secret providers.
 *
 * @example
 * ```ts
 * const config = await createConfigProvider()
 *   .add('secrets', GsmConfigProvider)
 *   .expectKeys({
 *     env: ['PORT', 'NODE_ENV'],
 *     secrets: ['SECRET_DB_CONNECTION_STRING', 'SECRET_REDIS_HOST']
 *   })
 *   .validate();
 *
 * // All access is sync after validate():
 * const port = config.env.PORT;
 * const dbUrl = config.secrets.SECRET_DB_CONNECTION_STRING;
 * ```
 */
export class NamespacedConfigBuilder {
	private readonly log: Logger;
	private readonly providers = new Map<string, ConfigProviderInput>();
	private readonly transformers: ConfigTransformer[] = [];
	private expectedKeys: Record<string, string[]> = {};
	private failMode: FailMode = 'error';

	constructor(logger?: Logger) {
		this.log = logger ?? new Logger('Config');
	}

	/**
	 * Add a namespace with its config provider.
	 * The provider can be an instance, a class constructor, or a factory object.
	 */
	add(namespace: string, provider: ConfigProviderInput): this {
		if (namespace === 'env') {
			throw new Error('Cannot override "env" namespace - it is reserved for environment variables');
		}
		this.providers.set(namespace, provider);
		return this;
	}

	/**
	 * Declare expected keys per namespace.
	 * These keys will be loaded and cached during validate().
	 */
	expectKeys(keys: Record<string, string[]>): this {
		this.expectedKeys = keys;
		return this;
	}

	/**
	 * Set behavior when validation fails.
	 * - 'error': Log error and exit (default)
	 * - 'warn': Log warning but continue
	 */
	onFail(mode: FailMode): this {
		this.failMode = mode;
		return this;
	}

	/**
	 * Add a transformer to derive a property from validated config.
	 * Transformers are applied in order after validation.
	 *
	 * @example
	 * ```ts
	 * const RedisConfigTransformer: ConfigTransformer<{ secrets: SecretsConfig }, RedisConfig> = {
	 *   property: 'redis',
	 *   transform: (config) => ({
	 *     host: config.secrets.SECRET_REDIS_HOST,
	 *     port: Number(config.secrets.SECRET_REDIS_PORT) || 6379,
	 *   }),
	 * };
	 *
	 * const config = await createConfigProvider()
	 *   .add('secrets', GsmConfigProvider)
	 *   .expectKeys({ secrets: ['SECRET_REDIS_HOST', 'SECRET_REDIS_PORT'] })
	 *   .transform(RedisConfigTransformer)
	 *   .validate<AppConfig>();
	 *
	 * // config.redis is now available
	 * ```
	 */
	transform<TInput, TOutput>(transformer: ConfigTransformer<TInput, TOutput>): this {
		this.transformers.push(transformer as ConfigTransformer);
		return this;
	}

	/**
	 * Validate expected keys and return a sync accessor object.
	 * Loads only the declared keys from each provider at startup.
	 *
	 * @template T - Optional typed config interface. When provided, the result
	 *               is typed as T instead of the generic NamespacedConfigResult.
	 *
	 * @example
	 * ```ts
	 * interface AppConfig {
	 *   secrets: {
	 *     SECRET_DB_URL: string;
	 *     SECRET_API_KEY: string;
	 *   };
	 * }
	 *
	 * const config = await createConfigProvider()
	 *   .add('secrets', GsmConfigProvider)
	 *   .expectKeys({ secrets: ['SECRET_DB_URL', 'SECRET_API_KEY'] })
	 *   .validate<AppConfig>();
	 *
	 * // config.secrets.SECRET_DB_URL is typed as string
	 * ```
	 */
	async validate<T = NamespacedConfigResult>(): Promise<T & ConfigProvider> {
		const cache: Record<string, Record<string, string | undefined>> = {};
		const missing: { namespace: string; key: string }[] = [];
		const present: { namespace: string; key: string }[] = [];

		// Load expected env keys
		const envKeys = this.expectedKeys.env ?? [];
		cache.env = {};
		for (const key of envKeys) {
			const value = Bun.env[key];
			cache.env[key] = value;
			if (value === undefined || value === '') {
				missing.push({ namespace: 'env', key });
			} else {
				present.push({ namespace: 'env', key });
			}
		}

		// Check for keys in namespaces that weren't added
		for (const namespace of Object.keys(this.expectedKeys)) {
			if (namespace !== 'env' && !this.providers.has(namespace)) {
				throw new Error(`Namespace "${namespace}" in expectKeys was not added via .add()`);
			}
		}

		// Load expected keys from each provider
		for (const [namespace, providerOrClass] of this.providers) {
			const keys = this.expectedKeys[namespace] ?? [];
			if (keys.length === 0) {
				cache[namespace] = {};
				continue;
			}

			// Resolve provider: can be instance, constructor, or factory
			let provider: ConfigProvider;
			if (isConfigProviderFactory(providerOrClass)) {
				provider = await providerOrClass.create();
			} else if (isConfigProviderConstructor(providerOrClass)) {
				provider = new providerOrClass();
			} else {
				provider = providerOrClass;
			}

			// Load only the expected keys (in parallel)
			cache[namespace] = await provider.loadKeys(keys);
			this.log.debug(`Loaded ${namespace} config`, { count: keys.length });

			// Validate the keys
			for (const key of keys) {
				const value = cache[namespace][key];
				if (value === undefined || value === '') {
					missing.push({ namespace, key });
				} else {
					present.push({ namespace, key });
				}
			}
		}

		// Handle validation result
		if (missing.length > 0) {
			const missingList = missing.map((m) => `${m.namespace}.${m.key}`).join(', ');
			const message = `Missing required config keys: ${missingList}`;

			if (this.failMode === 'error') {
				this.log.error(message);
				throw new Error(message);
			} else {
				this.log.warn(message);
			}
		} else {
			this.log.info(`Config Validated: ${present.length} keys loaded`);
		}

		// Apply transformers to derive additional properties
		const result: Record<string, unknown> = { ...cache };
		for (const transformer of this.transformers) {
			result[transformer.property] = transformer.transform(result);
			this.log.debug(`Applied transformer: ${transformer.property}`);
		}

		// Create ConfigProvider methods that operate on the cache
		const configProvider: ConfigProvider = {
			async get(key: string): Promise<string | undefined> {
				// Search all namespaces for the key (secrets first, then env)
				for (const namespace of ['secrets', ...Object.keys(cache)]) {
					if (cache[namespace]?.[key] !== undefined) {
						return cache[namespace][key];
					}
				}
				return undefined;
			},
			async getRequired(key: string): Promise<string> {
				const value = await this.get(key);
				if (value === undefined) {
					throw new Error(`Required config key '${key}' not found`);
				}
				return value;
			},
			async loadKeys(keys: string[]): Promise<Record<string, string | undefined>> {
				const values: Record<string, string | undefined> = {};
				for (const key of keys) {
					values[key] = await this.get(key);
				}
				return values;
			}
		};

		// Return a proxy that provides sync access AND implements ConfigProvider
		// The generic T allows callers to get typed results
		return new Proxy(result, {
			get(target, prop: string) {
				// ConfigProvider methods
				if (prop === 'get') return configProvider.get.bind(configProvider);
				if (prop === 'getRequired') return configProvider.getRequired.bind(configProvider);
				if (prop === 'loadKeys') return configProvider.loadKeys.bind(configProvider);

				if (prop in target) {
					return target[prop];
				}
				// Return empty object for unknown namespaces (will return undefined for any key)
				return {};
			}
		}) as T & ConfigProvider;
	}
}

/**
 * Creates a new namespaced config builder.
 * The `env` namespace is always available.
 */
export function createConfigProvider(logger?: Logger): NamespacedConfigBuilder {
	return new NamespacedConfigBuilder(logger);
}
