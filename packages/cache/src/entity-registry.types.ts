/**
 * Entity Registry Types
 *
 * Type definitions for the EntityRegistry fluent builder.
 * Defines scope hierarchies and entity definitions with full type safety.
 *
 * Key concepts:
 * - Scopes define param hierarchies (global -> account -> project)
 * - Entities belong to a scope and add unique keys
 * - Entity params = scope params + unique keys (auto-derived)
 * - Registry is frozen after build (immutable)
 */

// --- FACTORY INPUT TYPES ---

/**
 * Input type for defining a scope via factory.
 *
 * Used with `defineScopes()` to create strongly-typed scope definitions.
 *
 * @template TName - Literal type of the scope name
 * @template TParam - Literal type of the scope's param (or undefined)
 *
 * @example
 * ```typescript
 * const Scope = defineScopes({
 *   Global: { name: 'global' },
 *   Account: { name: 'account', param: 'accountUuid' },
 *   Project: { name: 'project', param: 'projectUuid' },
 * });
 * ```
 */
export interface ScopeDef<
	TName extends string = string,
	TParam extends string | undefined = string | undefined
> {
	readonly name: TName;
	readonly param?: TParam;
}

/**
 * Input type for defining an entity via factory.
 *
 * Used with `defineEntities()` to create strongly-typed entity definitions.
 *
 * @template TName - Literal type of the entity name
 * @template TScope - The ScopeDef this entity belongs to
 * @template TParam - Literal type of the entity's unique param (or undefined)
 *
 * @example
 * ```typescript
 * const Entities = defineEntities({
 *   Product: { name: 'Product', scope: Scope.Project, param: 'productUuid' },
 *   User: { name: 'User', scope: Scope.Account, param: 'userUuid' },
 *   ProductList: { name: 'ProductList', scope: Scope.Project },
 * });
 * ```
 */
export interface EntityDef<
	TName extends string = string,
	TScope extends ScopeDef = ScopeDef,
	TParam extends string | undefined = string | undefined
> {
	readonly name: TName;
	readonly scope: TScope;
	readonly param?: TParam;
	/**
	 * Tags to emit when this entity is invalidated.
	 * Any cache with matching tags will also be invalidated.
	 *
	 * @example
	 * User: {
	 *   name: 'User',
	 *   scope: Scope.Account,
	 *   param: 'fbAuthUid',
	 *   invalidationTags: (params) => [`user:${params.fbAuthUid}`]
	 * }
	 */
	readonly invalidationTags?: (params: Record<string, unknown>) => string[];
}

/**
 * Input type for a record of scope definitions.
 */
export type ScopeDefsInput = Record<string, { name: string; param?: string }>;

/**
 * Input type for a record of entity definitions.
 */
export type EntityDefsInput<TScopes extends ScopeDef = ScopeDef> = Record<
	string,
	{
		name: string;
		scope: TScopes;
		param?: string;
		invalidationTags?: (params: Record<string, unknown>) => string[];
	}
>;

/**
 * Output type from defineScopes() - preserves literal types.
 * Uses conditional type to properly handle missing param (→ undefined, not unknown).
 */
export type ScopeDefsOutput<T extends ScopeDefsInput> = {
	readonly [K in keyof T]: ScopeDef<T[K]['name'], T[K] extends { param: string } ? T[K]['param'] : undefined>;
};

/**
 * Output type from defineEntities() - preserves literal types.
 * Uses conditional type to properly handle missing param (→ undefined, not unknown).
 */
export type EntityDefsOutput<T extends EntityDefsInput> = {
	readonly [K in keyof T]: EntityDef<
		T[K]['name'],
		T[K]['scope'],
		T[K] extends { param: string } ? T[K]['param'] : undefined
	>;
};

// --- SCOPE DEFINITION ---

/**
 * Definition of a scope in the entity registry.
 *
 * Scopes define parameter hierarchies. Each scope has a name and its
 * required parameters. Scopes are ordered - later scopes inherit params
 * from earlier scopes.
 *
 * @example
 * // Scope 'project' with params ['accountUuid', 'projectUuid']
 * { name: 'project', params: ['accountUuid', 'projectUuid'] }
 */
export interface ScopeDefinition {
	/** The unique name of this scope */
	readonly name: string;

	/**
	 * Parameters required for this scope.
	 * Includes inherited params from parent scopes.
	 */
	readonly params: readonly string[];
}

// --- ENTITY DEFINITION ---

/**
 * Definition of an entity in the entity registry.
 *
 * Entities belong to a scope and optionally add unique keys.
 * The entity's full params are automatically derived as:
 * scope params + unique keys.
 *
 * @example
 * // Entity 'Product' in 'project' scope with unique key 'productUuid'
 * {
 *   name: 'Product',
 *   scope: 'project',
 *   uniqueKeys: ['productUuid'],
 *   params: ['accountUuid', 'projectUuid', 'productUuid']
 * }
 */
export interface EntityDefinition {
	/** The unique name of this entity */
	readonly name: string;

	/** The scope this entity belongs to */
	readonly scope: string;

	/** Unique keys that identify this entity within its scope */
	readonly uniqueKeys: readonly string[];

	/**
	 * Full parameters for this entity.
	 * Computed as: scope params + unique keys
	 */
	readonly params: readonly string[];
}

// --- BUILDER INTERFACE ---

/**
 * Fluent builder interface for constructing an entity registry.
 *
 * Use `EntityRegistry.create()` to start building, then chain
 * `.scope()`, `.entity()`, and `.use()` calls before `.build()`.
 *
 * @template TEntityNames - Union of registered entity names (accumulates)
 * @template TScopeNames - Union of registered scope names (accumulates)
 *
 * @example
 * ```typescript
 * const registry = EntityRegistry.create()
 *   .scope('global')
 *   .scope('account', 'accountUuid')
 *   .entity('User', 'account', 'userUuid')
 *   .use(addProductEntities)
 *   .build();
 * ```
 */
export interface EntityRegistryBuilder<
	TEntityNames extends string = never,
	TScopeNames extends string = never
> {
	/**
	 * Define a new scope with its parameters.
	 *
	 * Scopes are hierarchical - each scope inherits all params from
	 * previously defined scopes. Define scopes in order from root to leaf.
	 *
	 * @param name - Unique name for this scope
	 * @param params - Additional params for this scope (beyond inherited)
	 * @returns Builder with scope added
	 * @throws Error if scope name already exists
	 *
	 * @example
	 * .scope('global')                    // No params
	 * .scope('account', 'accountUuid')    // Adds accountUuid
	 * .scope('project', 'projectUuid')    // Inherits accountUuid, adds projectUuid
	 */
	scope<S extends string>(name: S, ...params: string[]): EntityRegistryBuilder<TEntityNames, TScopeNames | S>;

	/**
	 * Define a new entity within a scope.
	 *
	 * The entity's full params are automatically computed as:
	 * scope params + unique keys.
	 *
	 * @param name - Unique name for this entity
	 * @param scope - Scope this entity belongs to (must be previously defined)
	 * @param uniqueKeys - Keys that uniquely identify this entity within scope
	 * @returns Builder with entity added
	 * @throws Error if entity name already exists
	 * @throws Error if scope is not defined
	 *
	 * @example
	 * .entity('Product', 'project', 'productUuid')
	 * // Product.params = ['accountUuid', 'projectUuid', 'productUuid']
	 *
	 * .entity('ProductList', 'project')
	 * // ProductList.params = ['accountUuid', 'projectUuid']
	 */
	entity<N extends string>(
		name: N,
		scope: TScopeNames,
		...uniqueKeys: string[]
	): EntityRegistryBuilder<TEntityNames | N, TScopeNames>;

	/**
	 * Apply a composition function to add multiple entities.
	 *
	 * Enables modular organization of entity definitions.
	 * The function receives the current builder and returns a new builder.
	 *
	 * @param fn - Function that adds entities and returns the builder
	 * @returns Builder with entities added by the function
	 *
	 * @example
	 * function addUserEntities<T extends string, S extends string>(
	 *   reg: EntityRegistryBuilder<T, S>
	 * ): EntityRegistryBuilder<T | 'User' | 'UserProfile', S> {
	 *   return reg
	 *     .entity('User', 'account', 'userUuid')
	 *     .entity('UserProfile', 'account', 'userUuid');
	 * }
	 *
	 * EntityRegistry.create()
	 *   .scope('account', 'accountUuid')
	 *   .use(addUserEntities)
	 *   .build();
	 */
	use<TNewEntities extends string, TNewScopes extends string>(
		fn: (
			builder: EntityRegistryBuilder<TEntityNames, TScopeNames>
		) => EntityRegistryBuilder<TNewEntities, TNewScopes>
	): EntityRegistryBuilder<TNewEntities, TNewScopes>;

	/**
	 * Register all scopes from a scopes object.
	 *
	 * Use with `defineScopes()` for type-safe bulk scope registration.
	 * Scopes are registered in object key order (define in hierarchy order).
	 *
	 * @param scopes - Object of scope definitions from defineScopes()
	 * @returns Builder with all scopes added
	 *
	 * @example
	 * ```typescript
	 * const Scope = defineScopes({
	 *   Global: { name: 'global' },
	 *   Account: { name: 'account', param: 'accountUuid' },
	 *   Project: { name: 'project', param: 'projectUuid' },
	 * });
	 *
	 * EntityRegistry.create()
	 *   .scopes(Scope)
	 *   .entities(Entities)
	 *   .build();
	 * ```
	 */
	scopes<T extends Record<string, { name: string; param?: string }>>(
		scopes: T
	): EntityRegistryBuilder<TEntityNames, TScopeNames | T[keyof T]['name']>;

	/**
	 * Register all entities from an entities object.
	 *
	 * Use with `defineEntities()` for type-safe bulk entity registration.
	 *
	 * @param entities - Object of entity definitions from defineEntities()
	 * @returns Builder with all entities added
	 *
	 * @example
	 * ```typescript
	 * const Entities = defineEntities({
	 *   Product: { name: 'Product', scope: Scope.Project, param: 'productUuid' },
	 *   User: { name: 'User', scope: Scope.Account, param: 'userUuid' },
	 * });
	 *
	 * EntityRegistry.create()
	 *   .scopes(Scope)
	 *   .entities(Entities)
	 *   .build();
	 * ```
	 */
	entities<
		T extends Record<
			string,
			{
				name: string;
				scope: { name: string };
				param?: string;
				invalidationTags?: (params: Record<string, unknown>) => string[];
			}
		>
	>(
		entities: T
	): EntityRegistryBuilder<TEntityNames | T[keyof T]['name'], TScopeNames>;

	/**
	 * Build the final immutable entity registry.
	 *
	 * @returns Frozen registry with lookup methods
	 */
	build(): BuiltEntityRegistry<TEntityNames, TScopeNames>;
}

// --- BUILT REGISTRY INTERFACE ---

/**
 * A built, immutable entity registry.
 *
 * Provides type-safe lookups for entities and scopes.
 * All data is frozen after build - cannot be modified.
 *
 * @template TEntityNames - Union of valid entity names
 * @template TScopeNames - Union of valid scope names
 *
 * @example
 * ```typescript
 * const registry = EntityRegistry.create()
 *   .scope('account', 'accountUuid')
 *   .entity('User', 'account', 'userUuid')
 *   .build();
 *
 * const user = registry.getEntity('User');
 * // user.params = ['accountUuid', 'userUuid']
 *
 * registry.getEntity('Invalid'); // Type error!
 * ```
 */
export interface BuiltEntityRegistry<
	TEntityNames extends string = string,
	TScopeNames extends string = string
> {
	/** Map of all entity definitions indexed by name (string keys for iteration) */
	readonly entities: ReadonlyMap<string, EntityDefinition>;

	/** Map of all scope definitions indexed by name (string keys for iteration) */
	readonly scopes: ReadonlyMap<string, ScopeDefinition>;

	/**
	 * Get an entity definition by name.
	 *
	 * @param name - Entity name (type-checked against registered entities)
	 * @returns The entity definition
	 * @throws Error if entity is not found
	 */
	getEntity(name: TEntityNames): EntityDefinition;

	/**
	 * Check if an entity exists in the registry.
	 *
	 * @param name - Entity name to check
	 * @returns True if the entity exists, false otherwise
	 */
	hasEntity(name: string): boolean;

	/**
	 * Get a scope definition by name.
	 *
	 * @param name - Scope name (type-checked against registered scopes)
	 * @returns The scope definition
	 * @throws Error if scope is not found
	 */
	getScope(name: TScopeNames): ScopeDefinition;

	/**
	 * Get all registered entity names.
	 *
	 * @returns Array of entity names
	 */
	getEntityNames(): readonly TEntityNames[];

	/**
	 * Get all registered scope names.
	 *
	 * @returns Array of scope names
	 */
	getScopeNames(): readonly TScopeNames[];
}
