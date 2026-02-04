import type { Constructor, ConstructorDeps, InjectionToken } from './types/index';
import type { ProviderConfig } from './types/application';
import type { Container } from './container';
import type { Logger } from '@orijs/logging';

/**
 * Coordinates provider (service) registration concerns.
 * Handles provider configuration collection, container registration, and eager instantiation.
 */
export class ProviderCoordinator {
	private providers: ProviderConfig[] = [];

	constructor(
		private readonly container: Container,
		private readonly logger: Logger
	) {}

	/**
	 * Adds a provider configuration for later registration.
	 * Called by Application.provider() methods.
	 */
	public addProvider<T extends Constructor>(service: T, deps: Constructor[], eager?: boolean): void {
		this.providers.push({ service, deps, eager });
	}

	/**
	 * Registers a pre-instantiated value as a provider.
	 * Useful for services that need external configuration (e.g., database connections).
	 */
	public registerInstance<T>(token: InjectionToken<T>, instance: T): void {
		this.container.registerInstance(token, instance);
		const providerName =
			typeof token === 'symbol'
				? (token.description ?? 'Symbol')
				: typeof token === 'string'
					? token
					: token.name;
		this.logger.debug(`Provider Loaded: ${providerName}`);
	}

	/**
	 * Registers all collected providers with the container.
	 * Called during bootstrap.
	 */
	public registerProviders(): void {
		for (const { service, deps } of this.providers) {
			// Type assertion safe: deps validated at API boundary via ConstructorDeps<T>
			this.container.register(service, deps as ConstructorDeps<typeof service>);
		}
	}

	/**
	 * Instantiates all eager providers.
	 * Called during bootstrap after all providers are registered.
	 */
	public instantiateEagerProviders(): void {
		const eagerProviders = this.providers.filter((p) => p.eager);
		for (const { service } of eagerProviders) {
			this.container.resolve(service);
			this.logger.debug(`Provider Loaded: ${service.name}`);
		}
	}

	/**
	 * Returns the count of registered providers.
	 */
	public getProviderCount(): number {
		return this.providers.length;
	}
}
