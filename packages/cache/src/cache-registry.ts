/**
 * Cache Registry
 *
 * Central registry for cache configurations. Provides:
 * - Entity-type indexed storage of CacheConfigs
 * - Forward/reverse dependency graphs
 * - Cycle detection at registration time
 * - getDependents() for cascade invalidation lookups
 *
 * NOTE: The actual meta key → cache key associations are stored in Redis
 * via setWithMeta/delByMeta. This registry is for:
 * - Compile-time/startup validation (cycle detection)
 * - Introspection (listing registered caches)
 * - Dependency graph queries
 *
 * @example
 * // Register a cache (typically done in the builder's .build())
 * cacheRegistry.register(UserCache);
 *
 * // Get all caches that depend on a given entity
 * const dependents = cacheRegistry.getDependents('Account');
 * // => ['User', 'Product', 'Project', ...]
 *
 * // Check for cycles (throws if found)
 * cacheRegistry.validateNoCycles();
 */

import type { CacheConfig } from './types';

/**
 * Entity type for cache registry operations.
 * This is a generic string type - consumers define their own entity names.
 */
type EntityType = string;

// ════════════════════════════════════════════════════════════════════════════
// CACHE REGISTRY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cache Registry - stores cache configurations and dependency graphs
 */
class CacheRegistry {
	/**
	 * Cache configurations indexed by entity type
	 */
	private readonly configs = new Map<EntityType, CacheConfig[]>();

	/**
	 * Forward dependency graph: entity -> entities it depends on
	 * e.g., 'Product' -> ['Account', 'Project']
	 */
	private readonly dependencyGraph = new Map<EntityType, Set<EntityType>>();

	/**
	 * Reverse dependency graph: entity -> entities that depend on it
	 * e.g., 'Account' -> ['User', 'Product', 'Project', ...]
	 */
	private readonly reverseDependencyGraph = new Map<EntityType, Set<EntityType>>();

	/**
	 * Register a cache configuration
	 *
	 * @param config - The cache configuration to register
	 */
	public register<TParams extends object>(config: CacheConfig<TParams>): void {
		const entityType = config.entity;

		// Add to configs map
		if (!this.configs.has(entityType)) {
			this.configs.set(entityType, []);
		}
		this.configs.get(entityType)!.push(config as CacheConfig);

		// Build dependency graphs
		const dependencies = Object.keys(config.dependsOn) as EntityType[];

		// Forward graph: this entity depends on these entities
		if (!this.dependencyGraph.has(entityType)) {
			this.dependencyGraph.set(entityType, new Set());
		}
		for (const dep of dependencies) {
			this.dependencyGraph.get(entityType)!.add(dep);
		}

		// Reverse graph: these entities have this entity depending on them
		for (const dep of dependencies) {
			if (!this.reverseDependencyGraph.has(dep)) {
				this.reverseDependencyGraph.set(dep, new Set());
			}
			this.reverseDependencyGraph.get(dep)!.add(entityType);
		}
	}

	/**
	 * Get all cache configurations for an entity type
	 *
	 * @param entityType - The entity type to look up
	 * @returns Array of cache configurations (empty if none)
	 */
	public getByEntityType(entityType: EntityType): readonly CacheConfig[] {
		return this.configs.get(entityType) ?? [];
	}

	/**
	 * Get all entity types that have caches depending on the given entity
	 *
	 * Used for cascade invalidation: when entity X changes, which caches
	 * need to be invalidated?
	 *
	 * @param entityType - The entity that changed
	 * @returns Set of dependent entity types
	 */
	public getDependents(entityType: EntityType): Set<EntityType> {
		return this.reverseDependencyGraph.get(entityType) ?? new Set();
	}

	/**
	 * Get all entities that the given entity depends on
	 *
	 * @param entityType - The entity to check
	 * @returns Set of dependency entity types
	 */
	public getDependencies(entityType: EntityType): Set<EntityType> {
		return this.dependencyGraph.get(entityType) ?? new Set();
	}

	/**
	 * Validate that there are no circular dependencies
	 *
	 * Should be called at application startup after all caches are registered.
	 *
	 * @throws Error if a cycle is detected
	 */
	public validateNoCycles(): void {
		const visited = new Set<EntityType>();
		const recursionStack = new Set<EntityType>();

		const hasCycle = (entity: EntityType, path: EntityType[]): boolean => {
			visited.add(entity);
			recursionStack.add(entity);

			const dependencies = this.dependencyGraph.get(entity);
			if (dependencies) {
				for (const dep of dependencies) {
					if (!visited.has(dep)) {
						if (hasCycle(dep, [...path, dep])) {
							return true;
						}
					} else if (recursionStack.has(dep)) {
						// Found cycle
						const cyclePath = [...path, dep].join(' -> ');
						throw new Error(`Circular cache dependency detected: ${cyclePath}`);
					}
				}
			}

			recursionStack.delete(entity);
			return false;
		};

		// Check each entity as a potential cycle start
		for (const entity of this.dependencyGraph.keys()) {
			if (!visited.has(entity)) {
				hasCycle(entity, [entity]);
			}
		}
	}

	/**
	 * Get all registered entity types
	 */
	public getRegisteredEntityTypes(): EntityType[] {
		return Array.from(this.configs.keys());
	}

	/**
	 * Get the number of registered cache configurations
	 */
	public get size(): number {
		let count = 0;
		for (const configs of this.configs.values()) {
			count += configs.length;
		}
		return count;
	}

	/**
	 * Reset the registry (for testing)
	 */
	public reset(): void {
		this.configs.clear();
		this.dependencyGraph.clear();
		this.reverseDependencyGraph.clear();
	}

	/**
	 * Get a summary of the registry (for debugging)
	 */
	public getSummary(): {
		entityTypes: number;
		totalConfigs: number;
		dependencyEdges: number;
	} {
		let dependencyEdges = 0;
		for (const deps of this.dependencyGraph.values()) {
			dependencyEdges += deps.size;
		}

		return {
			entityTypes: this.configs.size,
			totalConfigs: this.size,
			dependencyEdges
		};
	}
}

// ════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Default global cache registry instance.
 *
 * This singleton pattern is intentional for framework-level code where:
 * 1. Cache definitions are typically module-level constants
 * 2. The registry must be available at definition time (before DI container)
 * 3. Test isolation is handled via container-level Redis separation
 *    (each test gets fresh Redis, and registry.reset() clears in-memory state)
 *
 * For custom scoped registries, instantiate CacheRegistry directly.
 */
export const cacheRegistry = new CacheRegistry();

// Export the class for custom instances if needed
export { CacheRegistry };
