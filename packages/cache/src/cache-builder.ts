/**
 * Cache Builder (Registry-Aware)
 *
 * Fluent builder for defining cache configurations with auto-derivation from EntityRegistry.
 *
 * Key Design Points:
 * - Takes an EntityRegistry and auto-derives scope, params, hierarchy dependencies
 * - Type-safe entity names at compile time
 * - Accepts EntityDef objects (no string literals needed)
 * - Minimal API: .for() → .ttl() → .build() for simple cases
 * - Optional: .grace(), .dependsOn(), .cacheNull()
 *
 * ## params vs metaParams
 *
 * These serve different purposes:
 *
 * - **params**: All parameters needed to uniquely identify the cached entity.
 *   Used for generating the cache key. Includes scope chain params + entity's own param.
 *   Example: Product has params `['accountUuid', 'projectUuid', 'productUuid']`
 *
 * - **metaParams**: Parameters used for cascade invalidation lookup (the meta key).
 *   Derived from the entity's scope params only (not the entity's own param).
 *   Example: Product has metaParams `['accountUuid', 'projectUuid']` (from project scope)
 *
 * Why the distinction? When invalidating "all Product caches for a project",
 * you provide `{ accountUuid, projectUuid }` - the metaParams identify the invalidation
 * scope, while params are used when getting/setting a specific cache entry.
 *
 * @example Basic Setup
 * ```typescript
 * // 1. Define scopes and entities using factory functions
 * const Scope = defineScopes({
 *   Global: { name: 'global' },
 *   Account: { name: 'account', param: 'accountUuid' },
 *   Project: { name: 'project', param: 'projectUuid' },
 * });
 *
 * const Entities = defineEntities({
 *   Account: { name: 'Account', scope: Scope.Account },
 *   Project: { name: 'Project', scope: Scope.Project },
 *   Product: { name: 'Product', scope: Scope.Project, param: 'productUuid' },
 *   ProductDetails: { name: 'ProductDetails', scope: Scope.Project, param: 'productUuid' },
 * });
 *
 * // 2. Build registry using bulk registration
 * const registry = EntityRegistry.create()
 *   .scopes(Scope)
 *   .entities(Entities)
 *   .build();
 *
 * // 3. Create cache builder bound to registry
 * const Cache = createCacheBuilder(registry);
 *
 * // 4. Define caches using EntityDef objects (no string literals!)
 * const ProductCache = Cache.for(Entities.Product).ttl('5m').build();
 * // ProductCache.scope = 'project'
 * // ProductCache.params = ['accountUuid', 'projectUuid', 'productUuid']
 * // ProductCache.metaParams = ['accountUuid', 'projectUuid']
 * // ProductCache.dependsOn = { Account: ['accountUuid'], Project: ['accountUuid', 'projectUuid'] }
 * ```
 *
 * @example Dependency Scenarios
 * ```typescript
 * // Scenario 1: Auto-derived hierarchy dependencies
 * // Product at project scope automatically depends on Account and Project
 * const ProductCache = Cache.for(Entities.Product).ttl('5m').build();
 * // dependsOn = { Account: ['accountUuid'], Project: ['accountUuid', 'projectUuid'] }
 *
 * // Scenario 2: Sibling entity dependency (same scope level)
 * // ProductDetails depends on Product (both at project scope with productUuid)
 * const ProductDetailsCache = Cache.for(Entities.ProductDetails)
 *   .ttl('5m')
 *   .dependsOn(Entities.Product)  // params auto-derived from registry
 *   .build();
 * // dependsOn = { Account: [...], Project: [...], Product: ['accountUuid', 'projectUuid', 'productUuid'] }
 *
 * // Scenario 3: Explicit params override (cross-entity dependency)
 * // When the dependent entity uses different param names
 * const OrderCache = Cache.for(Entities.Order)
 *   .ttl('10m')
 *   .dependsOn(Entities.Product, ['accountUuid', 'projectUuid', 'orderProductUuid'])
 *   .build();
 * ```
 *
 * @example Complete Configuration with All Options
 * ```typescript
 * const ProductCache = Cache.for(Entities.Product)
 *   .ttl('5m')                    // Required: time-to-live
 *   .grace('1m')                  // Optional: stale-while-revalidate window
 *   .timeout('10s')               // Optional: data fetch timeout (default 1s)
 *   .cacheNull()                  // Optional: cache null/undefined results
 *   .dependsOn(Entities.Category) // Optional: additional dependency
 *   .build();
 * ```
 */

import type { Duration, CacheConfig, DefaultTTL } from './types';
import type { BuiltEntityRegistry, EntityDef } from './entity-registry.types';
import { parseDuration } from './duration';
import { Logger } from '@orijs/logging';

// Lazy init to pick up configured transports
let logger: Logger | null = null;
function getLogger(): Logger {
	if (!logger) logger = new Logger('CacheBuilder');
	return logger;
}

// --- UTILITIES ---

/**
 * Extract entity name from EntityInput (string or EntityDef object)
 */
function extractEntityName<T extends string>(entity: T | EntityDef<T>): T {
	return typeof entity === 'string' ? entity : entity.name;
}

// --- BUILDER INTERFACES ---

/**
 * Input type for .for() - accepts entity name string or EntityDef object
 */
export type EntityInput<TEntityNames extends string> = TEntityNames | EntityDef<TEntityNames>;

/**
 * Factory returned by createCacheBuilder
 */
export interface CacheBuilderFactory<TEntityNames extends string> {
	/**
	 * Start defining a cache for an entity
	 *
	 * @param entity - Entity name or EntityDef object (type-checked against registry)
	 * @returns Builder for setting TTL and other options
	 *
	 * @example
	 * // With string name
	 * Cache.for('Product').ttl('5m').build();
	 *
	 * // With EntityDef object
	 * Cache.for(Entities.Product).ttl('5m').build();
	 */
	for<TParams extends object>(
		entity: EntityInput<TEntityNames>
	): CacheBuilderForEntity<TEntityNames, TParams>;
}

/**
 * Builder state after .for() - requires .ttl() before .build()
 */
export interface CacheBuilderForEntity<TEntityNames extends string, TParams extends object> {
	/**
	 * Set time-to-live (required)
	 *
	 * By default, only accepts pre-defined TTL values (DefaultTTL).
	 * To use custom TTL values, provide your own type:
	 *
	 * @example
	 * ```typescript
	 * // Default - only allows DefaultTTL values
	 * Cache.for(Entities.Product).ttl('5m').build();  // OK
	 * Cache.for(Entities.Product).ttl('32m').build(); // Type error
	 *
	 * // Custom - define your own allowed values
	 * type MyTTL = '2m' | '32m' | '2h';
	 * Cache.for(Entities.Product).ttl<MyTTL>('32m').build(); // OK
	 *
	 * // Numeric seconds always work
	 * Cache.for(Entities.Product).ttl(300).build(); // OK
	 * ```
	 *
	 * @param duration - Seconds or duration string from allowed set
	 */
	ttl<T extends string = DefaultTTL>(duration: T | number): CacheBuilderWithTtl<TEntityNames, TParams>;
}

/**
 * Builder state after .ttl() - can now .build() or add optional settings
 */
export interface CacheBuilderWithTtl<TEntityNames extends string, TParams extends object> {
	/**
	 * Set grace period for stale-while-revalidate (optional)
	 *
	 * @param duration - Seconds or human-readable string
	 */
	grace(duration: Duration): CacheBuilderWithTtl<TEntityNames, TParams>;

	/**
	 * Add dependency on another entity (auto-lookup params from registry)
	 *
	 * @param entity - Entity name or EntityDef to depend on
	 */
	dependsOn(entity: EntityInput<TEntityNames>): CacheBuilderWithTtl<TEntityNames, TParams>;

	/**
	 * Add dependency on another entity with explicit params override
	 *
	 * @param entity - Entity name or EntityDef to depend on
	 * @param params - Param keys to use for this dependency
	 */
	dependsOn(
		entity: EntityInput<TEntityNames>,
		params: readonly (keyof TParams)[]
	): CacheBuilderWithTtl<TEntityNames, TParams>;

	/**
	 * Cache null/undefined results (default: false)
	 *
	 * @param value - Whether to cache null (default: true when called)
	 */
	cacheNull(value?: boolean): CacheBuilderWithTtl<TEntityNames, TParams>;

	/**
	 * Set timeout for data fetching on cache miss
	 *
	 * If fetching takes longer than this, a CacheTimeoutError is thrown.
	 * Default: 1 second. Override for slow data sources.
	 *
	 * @param duration - Timeout in seconds or human-readable string (e.g., '10s', '30s')
	 *
	 * @example
	 * Cache.for(Entities.User).ttl('5m').timeout('10s').build();
	 */
	timeout(duration: Duration): CacheBuilderWithTtl<TEntityNames, TParams>;

	/**
	 * Set tags for cross-scope invalidation
	 *
	 * @param tagsFn - Function that takes params and returns tag strings
	 */
	tags(tagsFn: (params: TParams) => string[]): CacheBuilderWithTtl<TEntityNames, TParams>;

	/**
	 * Build the cache configuration
	 *
	 * Returns an immutable (frozen) CacheConfig with all auto-derived values.
	 */
	build(): Readonly<CacheConfig<TParams>>;
}

// --- BUILDER IMPLEMENTATION ---

/**
 * Internal builder implementation
 */
class CacheBuilderInternal<TEntityNames extends string, TParams extends object>
	implements CacheBuilderForEntity<TEntityNames, TParams>, CacheBuilderWithTtl<TEntityNames, TParams>
{
	private readonly registry: BuiltEntityRegistry<TEntityNames>;
	private readonly entityName: TEntityNames;
	private ttlSeconds?: number;
	private graceSeconds: number = 0;
	private additionalDeps: Map<TEntityNames, readonly (keyof TParams)[]> = new Map();
	private shouldCacheNull: boolean = false;
	private timeoutMs?: number;
	private tagsFn?: (params: TParams) => string[];

	public constructor(registry: BuiltEntityRegistry<TEntityNames>, entityName: TEntityNames) {
		this.registry = registry;
		this.entityName = entityName;
	}

	public ttl<T extends string = DefaultTTL>(
		duration: T | number
	): CacheBuilderWithTtl<TEntityNames, TParams> {
		// Type constraint at compile time; parseDuration handles all valid Duration patterns at runtime
		this.ttlSeconds = parseDuration(duration as Duration);
		return this;
	}

	public grace(duration: Duration): CacheBuilderWithTtl<TEntityNames, TParams> {
		this.graceSeconds = parseDuration(duration);
		return this;
	}

	public dependsOn(
		entity: EntityInput<TEntityNames>,
		params?: readonly (keyof TParams)[]
	): CacheBuilderWithTtl<TEntityNames, TParams> {
		const depEntityName = extractEntityName(entity);

		if (params !== undefined) {
			// Explicit params override
			this.additionalDeps.set(depEntityName, params);
		} else {
			// Auto-lookup params from registry
			const depEntity = this.registry.getEntity(depEntityName);
			this.additionalDeps.set(depEntityName, depEntity.params as readonly (keyof TParams)[]);
		}
		return this;
	}

	public cacheNull(value: boolean = true): CacheBuilderWithTtl<TEntityNames, TParams> {
		this.shouldCacheNull = value;
		return this;
	}

	public timeout(duration: Duration): CacheBuilderWithTtl<TEntityNames, TParams> {
		this.timeoutMs = parseDuration(duration) * 1000; // Convert to milliseconds
		return this;
	}

	public tags(tagsFn: (params: TParams) => string[]): CacheBuilderWithTtl<TEntityNames, TParams> {
		this.tagsFn = tagsFn;
		return this;
	}

	public build(): Readonly<CacheConfig<TParams>> {
		if (this.ttlSeconds === undefined) {
			throw new Error(`ttl() is required before build() for entity '${this.entityName}'`);
		}

		// Get entity definition from registry
		const entity = this.registry.getEntity(this.entityName);

		// Auto-derive scope and params
		const scope = entity.scope;
		const params = entity.params as readonly (keyof TParams)[];

		// Auto-derive metaParams from scope params
		const scopeDef = this.registry.getScope(scope);
		const metaParams = scopeDef.params as readonly (keyof TParams)[];

		// Build dependsOn map: hierarchy deps + additional deps
		const dependsOn = this.buildDependsOn(scope);

		// Log cache configuration
		const deps = Object.keys(dependsOn);
		const depsStr = deps.length > 0 ? deps.join(', ') : 'none';
		getLogger().info(`Cache Loaded: ${this.entityName} -> [${depsStr}]`);

		return Object.freeze({
			entity: this.entityName,
			scope,
			ttl: this.ttlSeconds,
			grace: this.graceSeconds,
			params: Object.freeze([...params]) as readonly (keyof TParams)[],
			metaParams: Object.freeze([...metaParams]) as readonly (keyof TParams)[],
			dependsOn: Object.freeze(dependsOn) as Readonly<Partial<Record<string, readonly (keyof TParams)[]>>>,
			cacheNull: this.shouldCacheNull,
			timeout: this.timeoutMs,
			tags: this.tagsFn
		});
	}

	/**
	 * Build dependsOn map with hierarchy dependencies + additional deps
	 *
	 * Hierarchy deps include all scope-level entities up to and including the entity's scope,
	 * except for the entity itself (e.g., Product depends on Account and Project, but not Product).
	 */
	private buildDependsOn(entityScope: string): Partial<Record<string, readonly (keyof TParams)[]>> {
		const result: Partial<Record<string, readonly (keyof TParams)[]>> = {};

		// Add hierarchy dependencies (scope entities up to and including entity's scope)
		const scopeNames = this.registry.getScopeNames();
		const entityScopeIndex = scopeNames.indexOf(entityScope);

		// For each scope up to and including the entity's scope
		for (let i = 0; i <= entityScopeIndex; i++) {
			const scopeName = scopeNames[i]!;
			const scopeDef = this.registry.getScope(scopeName);

			// Look for an entity that matches this scope name (e.g., 'Account' for 'account' scope)
			// Convention: capitalize first letter of scope name
			const potentialEntityName = scopeName.charAt(0).toUpperCase() + scopeName.slice(1);

			// Skip if this is the same entity we're building the cache for
			if (potentialEntityName === this.entityName) {
				continue;
			}

			// Check if this entity exists in the registry
			if (this.registry.hasEntity(potentialEntityName)) {
				const scopeEntity = this.registry.getEntity(potentialEntityName as TEntityNames);
				if (scopeEntity.scope === scopeName) {
					// Add hierarchy dependency with scope's params
					result[potentialEntityName] = scopeDef.params as readonly (keyof TParams)[];
				}
			}
		}

		// Add additional dependencies from .dependsOn() calls
		for (const [depEntityName, depParams] of this.additionalDeps) {
			result[depEntityName] = depParams;
		}

		return result;
	}
}

// --- PUBLIC FACTORY ---

/**
 * Create a cache builder bound to an entity registry
 *
 * The builder auto-derives scope, params, and hierarchy dependencies from the registry.
 *
 * @param registry - Built entity registry with scope and entity definitions
 * @returns CacheBuilderFactory with type-safe .for() method
 *
 * @example
 * const registry = EntityRegistry.create()
 *   .scope('global')
 *   .scope('account', 'accountUuid')
 *   .scope('project', 'projectUuid')
 *   .entity('Account', 'account')
 *   .entity('Project', 'project')
 *   .entity('Product', 'project', 'productUuid')
 *   .build();
 *
 * const Cache = createCacheBuilder(registry);
 *
 * // Simple cache - everything auto-derived
 * const ProductCache = Cache.for('Product').ttl('5m').build();
 *
 * // With additional dependency
 * const ProductDetailsCache = Cache.for('ProductDetails')
 *   .ttl('5m')
 *   .dependsOn('Product')
 *   .build();
 */
export function createCacheBuilder<TEntityNames extends string>(
	registry: BuiltEntityRegistry<TEntityNames>
): CacheBuilderFactory<TEntityNames> {
	return {
		for<TParams extends object>(
			entity: EntityInput<TEntityNames>
		): CacheBuilderForEntity<TEntityNames, TParams> {
			const entityName = extractEntityName(entity);
			// Validate entity exists (will throw if not found)
			registry.getEntity(entityName);
			return new CacheBuilderInternal<TEntityNames, TParams>(registry, entityName);
		}
	};
}
