/**
 * Entity Registry
 *
 * Fluent builder for defining scope hierarchies and entity definitions.
 * Produces a frozen, type-safe registry for cache builders to consume.
 *
 * Key features:
 * - Scope hierarchy with param inheritance
 * - Entity params auto-derived from scope + unique keys
 * - Modular composition via .use() pattern
 * - Frozen (immutable) after build
 * - Full compile-time type safety for entity names
 *
 * @example
 * ```typescript
 * const registry = EntityRegistry.create()
 *   .scope('global')
 *   .scope('account', 'accountUuid')
 *   .scope('project', 'projectUuid')  // Inherits accountUuid
 *   .entity('User', 'account', 'userUuid')
 *   .entity('Product', 'project', 'productUuid')
 *   .use(addCustomEntities)
 *   .build();
 *
 * const product = registry.getEntity('Product');
 * // product.params = ['accountUuid', 'projectUuid', 'productUuid']
 * ```
 */

import type {
	ScopeDefinition,
	EntityDefinition,
	EntityRegistryBuilder,
	BuiltEntityRegistry,
	ScopeDefsInput,
	ScopeDefsOutput,
	EntityDefsInput,
	EntityDefsOutput
} from './entity-registry.types';

// --- BUILDER IMPLEMENTATION ---

/**
 * Internal builder implementation.
 * Accumulates scopes and entities, then builds the final registry.
 */
class EntityRegistryBuilderInternal<
	TEntityNames extends string = never,
	TScopeNames extends string = never
> implements EntityRegistryBuilder<TEntityNames, TScopeNames> {
	/** Accumulated scope definitions */
	private readonly scopeDefinitions: Map<string, ScopeDefinition> = new Map();

	/** Accumulated entity definitions */
	private readonly entityDefinitions: Map<string, EntityDefinition> = new Map();

	/** Ordered list of scope names for param inheritance */
	private readonly scopeOrder: string[] = [];

	/**
	 * Define a new scope with its parameters.
	 */
	public scope<S extends string>(
		name: S,
		...params: string[]
	): EntityRegistryBuilder<TEntityNames, TScopeNames | S> {
		// Check for duplicate scope
		if (this.scopeDefinitions.has(name)) {
			throw new Error(`Scope '${name}' already defined`);
		}

		// Compute inherited params from previous scopes
		const inheritedParams = this.getInheritedParams();
		const allParams = [...inheritedParams, ...params];

		// Create and store scope definition
		const scopeDef: ScopeDefinition = Object.freeze({
			name,
			params: Object.freeze(allParams)
		});

		this.scopeDefinitions.set(name, scopeDef);
		this.scopeOrder.push(name);

		// Type assertion is safe: same builder instance returned with expanded type params.
		// Standard TypeScript pattern for fluent builders with accumulating generics.
		return this as unknown as EntityRegistryBuilder<TEntityNames, TScopeNames | S>;
	}

	/**
	 * Define a new entity within a scope.
	 */
	public entity<N extends string>(
		name: N,
		scope: TScopeNames,
		...uniqueKeys: string[]
	): EntityRegistryBuilder<TEntityNames | N, TScopeNames> {
		// Check for duplicate entity
		if (this.entityDefinitions.has(name)) {
			throw new Error(`Entity '${name}' already defined`);
		}

		// Validate scope exists
		const scopeDef = this.scopeDefinitions.get(scope as string);
		if (!scopeDef) {
			throw new Error(`Scope '${scope}' not defined`);
		}

		// Compute full params: scope params + unique keys
		const fullParams = [...scopeDef.params, ...uniqueKeys];

		// Create and store entity definition
		const entityDef: EntityDefinition = Object.freeze({
			name,
			scope: scope as string,
			uniqueKeys: Object.freeze(uniqueKeys),
			params: Object.freeze(fullParams)
		});

		this.entityDefinitions.set(name, entityDef);

		// Type assertion is safe: same builder instance returned with expanded type params.
		return this as unknown as EntityRegistryBuilder<TEntityNames | N, TScopeNames>;
	}

	/**
	 * Apply a composition function to add multiple entities.
	 */
	public use<TNewEntities extends string, TNewScopes extends string>(
		fn: (
			builder: EntityRegistryBuilder<TEntityNames, TScopeNames>
		) => EntityRegistryBuilder<TNewEntities, TNewScopes>
	): EntityRegistryBuilder<TNewEntities, TNewScopes> {
		return fn(this);
	}

	/**
	 * Register all scopes from a scopes object.
	 */
	public scopes<T extends Record<string, { name: string; param?: string }>>(
		scopesObj: T
	): EntityRegistryBuilder<TEntityNames, TScopeNames | T[keyof T]['name']> {
		// Register each scope in object key order
		for (const key of Object.keys(scopesObj)) {
			const scopeDef = scopesObj[key]!;
			this.scope(scopeDef.name, ...(scopeDef.param ? [scopeDef.param] : []));
		}
		return this as unknown as EntityRegistryBuilder<TEntityNames, TScopeNames | T[keyof T]['name']>;
	}

	/**
	 * Register all entities from an entities object.
	 */
	public entities<
		T extends Record<
			string,
			{
				name: string;
				scope: { name: string };
				param?: string;
				invalidationTags?: (params: Record<string, unknown>) => string[];
			}
		>
	>(entitiesObj: T): EntityRegistryBuilder<TEntityNames | T[keyof T]['name'], TScopeNames> {
		// Register each entity
		for (const key of Object.keys(entitiesObj)) {
			const entityDef = entitiesObj[key]!;
			this.entity(
				entityDef.name,
				entityDef.scope.name as TScopeNames,
				...(entityDef.param ? [entityDef.param] : [])
			);

			// Register invalidation tags if defined
			if (entityDef.invalidationTags) {
				registerEntityInvalidation(entityDef.name, {
					invalidationTags: entityDef.invalidationTags
				});
			}
		}
		return this as unknown as EntityRegistryBuilder<TEntityNames | T[keyof T]['name'], TScopeNames>;
	}

	/**
	 * Build the final immutable entity registry.
	 */
	public build(): BuiltEntityRegistry<TEntityNames, TScopeNames> {
		// Copy maps for immutability (original builder can continue to be used)
		const entityMap = new Map(this.entityDefinitions);
		const scopeMap = new Map(this.scopeDefinitions);

		// Freeze the entity names and scope names arrays
		const entityNames = Object.freeze(Array.from(entityMap.keys())) as readonly TEntityNames[];
		const scopeNames = Object.freeze(Array.from(scopeMap.keys())) as readonly TScopeNames[];

		// Create the registry object with closure over the maps
		// Maps use string keys for iteration, but getter methods provide type safety via TEntityNames/TScopeNames
		const registry: BuiltEntityRegistry<TEntityNames, TScopeNames> = {
			get entities(): ReadonlyMap<string, EntityDefinition> {
				return entityMap;
			},

			get scopes(): ReadonlyMap<string, ScopeDefinition> {
				return scopeMap;
			},

			getEntity(name: TEntityNames): EntityDefinition {
				const entity = entityMap.get(name);
				if (!entity) {
					throw new Error(`Entity '${name}' not found in registry`);
				}
				return entity;
			},

			hasEntity(name: string): boolean {
				return entityMap.has(name);
			},

			getScope(name: TScopeNames): ScopeDefinition {
				const scope = scopeMap.get(name);
				if (!scope) {
					throw new Error(`Scope '${name}' not found in registry`);
				}
				return scope;
			},

			getEntityNames(): readonly TEntityNames[] {
				return entityNames;
			},

			getScopeNames(): readonly TScopeNames[] {
				return scopeNames;
			}
		};

		return Object.freeze(registry);
	}

	/**
	 * Get inherited params from all previously defined scopes.
	 */
	private getInheritedParams(): string[] {
		if (this.scopeOrder.length === 0) {
			return [];
		}

		// Get params from the last (most recent) scope.
		// Scope existence is guaranteed by the scopeOrder invariant.
		const lastScopeName = this.scopeOrder[this.scopeOrder.length - 1]!;
		const lastScope = this.scopeDefinitions.get(lastScopeName)!;

		return [...lastScope.params];
	}
}

// --- PUBLIC FACTORY ---

/**
 * Factory for creating entity registries.
 *
 * Use `EntityRegistry.create()` to start building a new registry.
 *
 * @example
 * ```typescript
 * const registry = EntityRegistry.create()
 *   .scope('global')
 *   .scope('account', 'accountUuid')
 *   .scope('project', 'projectUuid')
 *   .entity('User', 'account', 'userUuid')
 *   .entity('Product', 'project', 'productUuid')
 *   .build();
 * ```
 */
export const EntityRegistry = {
	/**
	 * Create a new entity registry builder.
	 *
	 * @returns A new builder instance
	 */
	create(): EntityRegistryBuilder<never, never> {
		return new EntityRegistryBuilderInternal();
	}
};

// --- FACTORY FUNCTIONS ---

/**
 * Define scopes with type inference.
 *
 * Creates a strongly-typed scopes object for use with EntityRegistry.
 * Pass the result to `.scopes()` on the builder.
 *
 * @param scopes - Object of scope definitions
 * @returns The same object with inferred literal types
 *
 * @example
 * ```typescript
 * const Scope = defineScopes({
 *   Global: { name: 'global' },
 *   Account: { name: 'account', param: 'accountUuid' },
 *   Project: { name: 'project', param: 'projectUuid' },
 * });
 *
 * // Scope.Project is typed as ScopeDef<'project', 'projectUuid'>
 * ```
 */
export function defineScopes<T extends ScopeDefsInput>(scopes: T): ScopeDefsOutput<T> {
	return scopes as ScopeDefsOutput<T>;
}

/**
 * Define entities with type inference.
 *
 * Creates a strongly-typed entities object for use with EntityRegistry.
 * Pass the result to `.entities()` on the builder.
 *
 * @param entities - Object of entity definitions (referencing scope objects)
 * @returns The same object with inferred literal types
 *
 * @example
 * ```typescript
 * const Entities = defineEntities({
 *   Product: { name: 'Product', scope: Scope.Project, param: 'productUuid' },
 *   User: { name: 'User', scope: Scope.Account, param: 'userUuid' },
 *   ProductList: { name: 'ProductList', scope: Scope.Project },
 * });
 *
 * // Entities.Product is typed as EntityDef<'Product', typeof Scope.Project, 'productUuid'>
 * ```
 */
export function defineEntities<T extends EntityDefsInput>(entities: T): EntityDefsOutput<T> {
	return entities as EntityDefsOutput<T>;
}

// --- ENTITY INVALIDATION REGISTRY ---

/**
 * Global registry for entity invalidation tags.
 * Maps entity names to their invalidationTags functions.
 */
const entityInvalidationRegistry = new Map<
	string,
	{
		invalidationTags?: (params: Record<string, unknown>) => string[];
	}
>();

/**
 * Register an entity's invalidation configuration.
 * Called automatically when entities are registered via defineEntities().
 *
 * @param entityName - The entity name
 * @param config - The invalidation configuration
 */
export function registerEntityInvalidation(
	entityName: string,
	config: {
		invalidationTags?: (params: Record<string, unknown>) => string[];
	}
): void {
	entityInvalidationRegistry.set(entityName, config);
}

/**
 * Get invalidation tags for an entity.
 * Returns empty array if entity has no invalidation tags or is not registered.
 *
 * @param entityName - The entity name
 * @param params - Parameters to pass to the invalidationTags function
 * @returns Array of tag strings
 */
export function getEntityInvalidationTags(entityName: string, params: Record<string, unknown>): string[] {
	const config = entityInvalidationRegistry.get(entityName);
	if (!config?.invalidationTags) {
		return [];
	}
	return config.invalidationTags(params);
}

/**
 * Clear the entity invalidation registry (for testing).
 */
export function clearEntityInvalidationRegistry(): void {
	entityInvalidationRegistry.clear();
}
