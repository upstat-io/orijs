/**
 * OriJS Cache System
 *
 * A fluent, type-safe caching system with dependency tracking and cascade invalidation.
 *
 * @example
 * // 1. Define scopes and entities using factory functions
 * const Scope = defineScopes({
 *   Global: { name: 'global' },
 *   Account: { name: 'account', param: 'accountUuid' },
 * });
 *
 * const Entities = defineEntities({
 *   User: { name: 'User', scope: Scope.Account, param: 'userUuid' },
 * });
 *
 * // 2. Build registry and cache builder
 * const registry = EntityRegistry.create()
 *   .scopes(Scope)
 *   .entities(Entities)
 *   .build();
 *
 * const Cache = createCacheBuilder(registry);
 *
 * // 3. Define caches (scope, params, dependencies auto-derived)
 * const UserCache = Cache.for(Entities.User).ttl('1h').grace('5m').build();
 *
 * // 4. Use cache service
 * const cacheService = new CacheService(new RedisCache(redis));
 * const user = await cacheService.getOrSet(UserCache, params, async (ctx) => {
 *   const data = await db.findById(params);
 *   if (!data) return ctx.skip();
 *   return data;
 * });
 *
 * @module @orijs/cache
 */

// Builder - Entry point for defining cache configurations
export { createCacheBuilder } from './cache-builder';
export type {
	EntityInput,
	CacheBuilderFactory,
	CacheBuilderForEntity,
	CacheBuilderWithTtl
} from './cache-builder';

// Entity Registry - Define scope hierarchies and entity definitions
export {
	EntityRegistry,
	defineScopes,
	defineEntities,
	registerEntityInvalidation,
	getEntityInvalidationTags,
	clearEntityInvalidationRegistry
} from './entity-registry';
export type {
	ScopeDefinition,
	EntityDefinition,
	EntityRegistryBuilder,
	BuiltEntityRegistry,
	ScopeDef,
	EntityDef,
	ScopeDefsInput,
	ScopeDefsOutput,
	EntityDefsInput,
	EntityDefsOutput
} from './entity-registry.types';

// Cache Registry - Stores configurations and dependency graph
export { cacheRegistry, CacheRegistry } from './cache-registry';

// Services
export { CacheService, CacheTimeoutError, type InvalidateOptions } from './cache';

// Providers - InMemory included, Redis is in @orijs/cache-redis
export { InMemoryCacheProvider } from './in-memory-cache-provider';

// Types - All type definitions
export {
	hasMetaSupport,
	type Duration,
	type DefaultTTL,
	type CacheConfig,
	type CacheProvider,
	type CacheProviderWithMeta,
	type FactoryContext,
	type CacheEntry,
	type CacheServiceOptions
} from './types';

// Constants
export { CACHE_KEY_PREFIX, META_KEY_PREFIX, TAG_META_KEY_PREFIX } from './types';

// Utilities - Duration parsing
export { parseDuration, formatDuration } from './duration';

// Utilities - Key generation
export {
	generateCacheKey,
	generateMetaKey,
	generateConfigMetaKey,
	generateTagMetaKey,
	isCacheKey,
	isMetaKey,
	isTagMetaKey
} from './key-generator';

// Utilities - Singleflight for thundering herd prevention
export { Singleflight, globalSingleflight, type SingleflightOptions } from './singleflight';
