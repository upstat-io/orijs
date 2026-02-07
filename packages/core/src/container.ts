import type { Constructor, ConstructorDeps, InjectionToken } from './types/index';
import type { Logger } from '@orijs/logging';
import { DependencyValidator } from './dependency-validator';

/**
 * Simple dependency injection container.
 *
 * Services are registered with their dependencies explicitly - no decorators
 * or reflect-metadata required. Supports both class constructors and tokens
 * (symbols/strings) as keys.
 *
 * @example
 * ```ts
 * const container = new Container();
 * container.register(DatabaseService);
 * container.register(UserService, [DatabaseService]);
 *
 * const userService = container.resolve(UserService);
 *
 * // With tokens
 * const ConfigToken = Symbol('Config');
 * container.registerInstance(ConfigToken, { apiKey: '...' });
 * ```
 */
/** Default timeout warning threshold for service resolution (5 seconds) */
const DEFAULT_RESOLUTION_TIMEOUT_MS = 5000;

export interface ContainerOptions {
	/** Logger for container warnings (optional) */
	logger?: Logger;
}

export class Container {
	private instances = new Map<InjectionToken, unknown>();
	private registry = new Map<InjectionToken, Constructor[]>();
	private resolving = new Set<InjectionToken>();
	/** Tracks external npm packages that services depend on */
	private externalDeps = new Map<Constructor, string[]>();
	/** Start time of the current top-level resolution (for timeout tracking, using monotonic clock) */
	private resolutionStartTime: number | null = null;
	/** Configurable resolution timeout warning threshold in milliseconds */
	private resolutionTimeoutMs = DEFAULT_RESOLUTION_TIMEOUT_MS;
	/** Whether we've already warned about slow resolution for current top-level call */
	private hasWarnedAboutTimeout = false;
	/** Logger for warnings (injected) */
	private logger: Logger | null = null;
	/** Handles dependency graph validation */
	private readonly validator = new DependencyValidator();

	constructor(options?: ContainerOptions) {
		this.logger = options?.logger ?? null;
	}

	/** Sets the logger for container warnings */
	public setLogger(logger: Logger): void {
		this.logger = logger;
	}

	/**
	 * Registers a service with no dependencies.
	 * @param service - The service class to register
	 */
	public register<T extends new () => unknown>(service: T): void;
	/**
	 * Registers a service with its dependencies.
	 * TypeScript enforces correct dependency types and order.
	 * @param service - The service class to register
	 * @param deps - Array of dependency classes (must match constructor parameter types and order)
	 */
	public register<T extends Constructor>(service: T, deps: ConstructorDeps<T>): void;
	public register<T extends Constructor>(service: T, deps: Constructor[] = []): void {
		this.registry.set(service, deps);
	}

	/**
	 * Registers a service with its dependencies and external npm package requirements.
	 * External packages are validated during `validate()` to ensure they're installed.
	 *
	 * @param service - The service class to register
	 * @param deps - Array of dependency classes (must match constructor parameter types and order)
	 * @param external - Array of npm package names this service requires (e.g., ['ioredis', 'bullmq'])
	 *
	 * @example
	 * ```ts
	 * // Service depends on ioredis which is a peer dependency
	 * container.registerWithExternal(CacheService, [ConfigService], ['ioredis']);
	 *
	 * // Service depends on multiple external packages
	 * container.registerWithExternal(QueueService, [], ['bullmq', 'ioredis']);
	 *
	 * // validate() will throw if packages are not installed
	 * container.validate();
	 * ```
	 */
	public registerWithExternal<T extends Constructor>(
		service: T,
		deps: ConstructorDeps<T>,
		external: string[]
	): void {
		// Set registry directly to avoid type system complexity with overloads
		this.registry.set(service, deps as Constructor[]);
		if (external.length > 0) {
			this.externalDeps.set(service, external);
		}
	}

	/**
	 * Resolves a service instance synchronously, instantiating it and its dependencies if needed.
	 * Instances are cached (singleton behavior).
	 *
	 * For services with async constructors, use resolveAsync() instead.
	 *
	 * @param token - The service class or injection token to resolve
	 * @returns The service instance
	 * @throws Error if the service is not registered or has an async constructor
	 */
	public resolve<T>(token: InjectionToken<T>): T {
		// Track if this is the top-level resolution call
		const isTopLevel = this.resolutionStartTime === null;
		if (isTopLevel) {
			this.resolutionStartTime = performance.now();
			this.hasWarnedAboutTimeout = false;
		}

		try {
			return this.resolveInternalSync(token);
		} finally {
			// Clear the start time when top-level call completes
			if (isTopLevel) {
				this.resolutionStartTime = null;
				this.hasWarnedAboutTimeout = false;
			}
		}
	}

	/**
	 * Resolves a service instance asynchronously, supporting async constructors.
	 * Instances are cached (singleton behavior).
	 *
	 * Use this method when your service dependency graph includes services with
	 * async constructors (constructors that return a Promise).
	 *
	 * @param token - The service class or injection token to resolve
	 * @returns Promise resolving to the service instance
	 * @throws Error if the service is not registered
	 */
	public async resolveAsync<T>(token: InjectionToken<T>): Promise<T> {
		// Track if this is the top-level resolution call
		const isTopLevel = this.resolutionStartTime === null;
		if (isTopLevel) {
			this.resolutionStartTime = performance.now();
			this.hasWarnedAboutTimeout = false;
		}

		try {
			return await this.resolveInternalAsync(token);
		} finally {
			// Clear the start time when top-level call completes
			if (isTopLevel) {
				this.resolutionStartTime = null;
				this.hasWarnedAboutTimeout = false;
			}
		}
	}

	/** Internal synchronous resolution with timeout checking */
	private resolveInternalSync<T>(token: InjectionToken<T>): T {
		this.checkResolutionTimeout(token);

		if (this.instances.has(token)) return this.instances.get(token) as T;

		const { service, deps } = this.prepareResolution(token);

		this.resolving.add(service);
		try {
			const resolvedDeps = deps.map((dep) => this.resolveInternalSync(dep));
			const instance = new service(...resolvedDeps);

			if (this.isPromise(instance)) {
				throw this.createAsyncConstructorError(service);
			}

			this.checkResolutionTimeout(token);
			this.instances.set(service, instance);
			return instance;
		} finally {
			this.resolving.delete(service);
		}
	}

	/** Internal async resolution with timeout checking - supports async constructors */
	private async resolveInternalAsync<T>(token: InjectionToken<T>): Promise<T> {
		this.checkResolutionTimeout(token);

		if (this.instances.has(token)) return this.instances.get(token) as T;

		const { service, deps } = this.prepareResolution(token);

		this.resolving.add(service);
		try {
			// Resolve deps in parallel (typical service has 2-5, most hit cache)
			const resolvedDeps = await Promise.all(deps.map((dep) => this.resolveInternalAsync(dep)));
			const constructorResult = new service(...resolvedDeps);

			// Await if constructor returns Promise (async constructor pattern)
			const instance = this.isPromise(constructorResult) ? await constructorResult : constructorResult;

			this.checkResolutionTimeout(token);
			this.instances.set(service, instance);
			return instance;
		} finally {
			this.resolving.delete(service);
		}
	}

	/** Validates token and returns service class with dependencies. Throws on invalid state. */
	private prepareResolution<T>(token: InjectionToken<T>): { service: Constructor<T>; deps: Constructor[] } {
		// Token-based providers must be pre-instantiated
		if (typeof token === 'symbol' || typeof token === 'string') {
			throw this.createTokenNotRegisteredError(token);
		}

		const service = token as Constructor<T>;
		if (this.resolving.has(service)) {
			throw this.createCircularDependencyError(service);
		}

		const deps = this.registry.get(service);
		if (!deps) {
			throw this.createServiceNotRegisteredError(service);
		}

		return { service, deps };
	}

	/** Type guard to check if a value is a Promise */
	private isPromise(value: unknown): value is Promise<unknown> {
		return (
			value !== null &&
			typeof value === 'object' &&
			'then' in value &&
			typeof (value as Promise<unknown>).then === 'function'
		);
	}

	/** Checks if resolution has exceeded the timeout threshold and logs a warning */
	private checkResolutionTimeout(token: InjectionToken): void {
		if (this.resolutionStartTime === null || this.hasWarnedAboutTimeout) return;
		if (!this.logger) return; // No logger configured, skip warning

		const elapsed = performance.now() - this.resolutionStartTime;
		if (elapsed > this.resolutionTimeoutMs) {
			this.hasWarnedAboutTimeout = true;
			const tokenName = this.getTokenName(token);
			const resolvingChain = [...this.resolving].map((s) => this.getTokenName(s)).join(' -> ');
			this.logger.warn(`Slow Service Resolution: ${elapsed}ms resolving ${tokenName}`, {
				elapsed,
				service: tokenName,
				chain: resolvingChain || '(top-level)',
				hint: 'Check for blocking operations in service constructors'
			});
		}
	}

	/**
	 * Sets the resolution timeout in milliseconds.
	 * @param timeoutMs - Timeout in milliseconds (default: 5000)
	 */
	public setResolutionTimeout(timeoutMs: number): void {
		this.resolutionTimeoutMs = timeoutMs;
	}

	/** Gets a readable name for a token (for error messages) */
	private getTokenName(token: InjectionToken): string {
		if (typeof token === 'symbol') return token.description ?? 'Symbol';
		if (typeof token === 'string') return token;
		return token.name;
	}

	/** Creates error for unregistered token-based providers */
	private createTokenNotRegisteredError(token: InjectionToken): Error {
		return new Error(
			`Token ${String(token)} is not registered.\n\n` +
				`Fix: Token-based providers must be registered with a pre-created instance:\n` +
				`  container.registerInstance(${String(token)}, yourInstance)\n\n` +
				`Or in Application builder:\n` +
				`  .providerInstance(${String(token)}, yourInstance)`
		);
	}

	/** Creates error for circular dependencies */
	private createCircularDependencyError(service: Constructor): Error {
		const chain = [...this.resolving].map((s) => this.getTokenName(s)).join(' -> ');
		return new Error(`Circular dependency detected: ${chain} -> ${service.name}`);
	}

	/** Creates error for unregistered services */
	private createServiceNotRegisteredError(service: Constructor): Error {
		return new Error(
			`Service ${service.name} is not registered.\n\n` +
				`Fix: Register the service as a provider:\n` +
				`  .provider(${service.name}, [/* dependencies */])\n\n` +
				`Or if it's pre-instantiated:\n` +
				`  .providerInstance(${service.name}, instance)`
		);
	}

	/** Creates error when sync resolve is used on async constructor */
	private createAsyncConstructorError(service: Constructor): Error {
		return new Error(
			`${service.name} has an async constructor (returns a Promise).\n\n` +
				`Fix: Use resolveAsync() instead of resolve() for services with async constructors:\n` +
				`  const instance = await container.resolveAsync(${service.name});`
		);
	}

	/**
	 * Checks if a service or token is registered.
	 * @param token - The service class or injection token to check
	 */
	public has(token: InjectionToken): boolean {
		return this.registry.has(token);
	}

	/**
	 * Validates the dependency graph at startup.
	 * Throws an error if:
	 * - A service declares dependencies that aren't registered
	 * - A service declares fewer dependencies than its constructor requires
	 * - Circular dependencies exist in the graph
	 * - External npm packages are not installed
	 * @throws Error with details about validation failures
	 */
	public validate(): void {
		this.validator.validate(this.registry, this.instances, this.externalDeps);
	}

	/**
	 * Registers a pre-instantiated value as a service.
	 * Works with both class constructors and injection tokens (symbols/strings).
	 * @param token - The service class or injection token (used as the key)
	 * @param instance - The pre-created instance
	 */
	public registerInstance<T>(token: InjectionToken<T>, instance: T): void {
		this.registry.set(token, []);
		this.instances.set(token, instance);
	}

	/**
	 * Registers a service with explicit dependencies that may include tokens.
	 * Use this when a service depends on token-based providers (symbols).
	 *
	 * Unlike register(), this method accepts InjectionToken[] instead of ConstructorDeps<T>,
	 * allowing you to mix class constructors and tokens in the dependency list.
	 *
	 * @param service - The service class to register
	 * @param deps - Array of dependencies (can be classes or tokens)
	 *
	 * @example
	 * ```ts
	 * const ConfigToken = createToken<Config>('Config');
	 * container.registerInstance(ConfigToken, { apiKey: 'secret' });
	 * container.registerWithTokenDeps(ApiService, [Logger, ConfigToken]);
	 * ```
	 */
	public registerWithTokenDeps<T extends Constructor>(service: T, deps: InjectionToken[]): void {
		this.registry.set(service, deps as Constructor[]);
	}

	/** Clears all cached instances while keeping registrations. */
	public clearInstances(): void {
		this.instances.clear();
	}

	/** Clears all registrations, instances, external dependency tracking, and package cache. */
	public clear(): void {
		this.instances.clear();
		this.registry.clear();
		this.externalDeps.clear();
		this.validator.clearPackageCache();
	}

	/** Returns the count of registered services. */
	public getRegisteredCount(): number {
		return this.registry.size;
	}

	/** Returns the names of all registered services. */
	public getRegisteredNames(): string[] {
		return [...this.registry.keys()].map((token) => this.getTokenName(token));
	}

	/** Returns the number of cached package resolution results (for testing). */
	public getPackageCacheSize(): number {
		return this.validator.getPackageCacheSize();
	}
}
