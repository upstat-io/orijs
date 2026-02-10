# Cache System Technical Reference

Technical specification for `@orijs/cache` and `@orijs/cache-redis`. Covers the entity registry, cache builder, cache service, singleflight, key generation, provider interfaces, and Redis-specific implementation details.

Source packages:
- `packages/cache/src/` -- core cache system
- `packages/cache-redis/src/` -- Redis provider

---

## 1. EntityRegistry -- Hierarchical Scope and Entity Model

**Source**: `packages/cache/src/entity-registry.ts`, `packages/cache/src/entity-registry.types.ts`

The EntityRegistry defines a hierarchical model of scopes and entities. Scopes form a chain where each scope inherits parameters from all preceding scopes. Entities belong to a scope and optionally add unique keys. The full parameter set for an entity is auto-computed as scope params + unique keys.

### Factory

```typescript
EntityRegistry.create(): EntityRegistryBuilder<never, never>
```

Returns a new builder instance with empty type accumulators. The two generic parameters (`TEntityNames`, `TScopeNames`) are union types that accumulate as scopes and entities are registered.

### Builder Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `scope` | `scope<S>(name: S, ...params: string[]): EntityRegistryBuilder<TEntityNames, TScopeNames \| S>` | Defines a scope. Inherits all params from the most recently defined scope. Throws on duplicate name. |
| `entity` | `entity<N>(name: N, scope: TScopeNames, ...uniqueKeys: string[]): EntityRegistryBuilder<TEntityNames \| N, TScopeNames>` | Defines an entity in a scope. Full params = scope.params + uniqueKeys. Throws on duplicate name or undefined scope. |
| `use` | `use<TNew, TNewS>(fn: (builder) => EntityRegistryBuilder<TNew, TNewS>): EntityRegistryBuilder<TNew, TNewS>` | Applies a composition function for modular entity registration. |
| `scopes` | `scopes<T>(scopesObj: T): EntityRegistryBuilder<TEntityNames, TScopeNames \| T[keyof T]['name']>` | Bulk-registers scopes from a `defineScopes()` output. Registers in object key order. |
| `entities` | `entities<T>(entitiesObj: T): EntityRegistryBuilder<TEntityNames \| T[keyof T]['name'], TScopeNames>` | Bulk-registers entities from a `defineEntities()` output. Also registers `invalidationTags` if present. |
| `build` | `build(): BuiltEntityRegistry<TEntityNames, TScopeNames>` | Produces a frozen, immutable registry. Copies internal maps before freezing. |

### defineScopes()

```typescript
function defineScopes<T extends ScopeDefsInput>(scopes: T): ScopeDefsOutput<T>
```

Identity function that preserves literal types for scope definitions. Input shape:

```typescript
{ name: string; param?: string }
```

Output preserves the literal `name` and `param` types via `ScopeDef<TName, TParam>`.

### defineEntities()

```typescript
function defineEntities<T extends EntityDefsInput>(entities: T): EntityDefsOutput<T>
```

Identity function that preserves literal types for entity definitions. Input shape:

```typescript
{ name: string; scope: ScopeDef; param?: string; invalidationTags?: (params: Record<string, unknown>) => string[] }
```

When `invalidationTags` is present, the function is auto-registered in a global `entityInvalidationRegistry` (module-level `Map<string, { invalidationTags }>`) via `registerEntityInvalidation()`.

### Param Inheritance

Scopes are ordered. Each new scope inherits all params from the last scope's full param list:

```
scope('global')           -> params: []
scope('account', 'aUuid') -> params: ['aUuid']
scope('project', 'pUuid') -> params: ['aUuid', 'pUuid']
```

Entity params = scope params + unique keys:

```
entity('Product', 'project', 'productUuid')
-> params: ['aUuid', 'pUuid', 'productUuid']
```

### BuiltEntityRegistry Interface

```typescript
interface BuiltEntityRegistry<TEntityNames, TScopeNames> {
    readonly entities: ReadonlyMap<string, EntityDefinition>;
    readonly scopes: ReadonlyMap<string, ScopeDefinition>;
    getEntity(name: TEntityNames): EntityDefinition;
    hasEntity(name: string): boolean;
    getScope(name: TScopeNames): ScopeDefinition;
    getEntityNames(): readonly TEntityNames[];
    getScopeNames(): readonly TScopeNames[];
}
```

The registry is `Object.freeze()`-d after build. The `entities` and `scopes` maps use `string` keys for iteration; the getter methods enforce type-safe lookups via `TEntityNames`/`TScopeNames`.

### Core Types

```typescript
interface ScopeDefinition {
    readonly name: string;
    readonly params: readonly string[];
}

interface EntityDefinition {
    readonly name: string;
    readonly scope: string;
    readonly uniqueKeys: readonly string[];
    readonly params: readonly string[];  // scope.params + uniqueKeys
}
```

### Entity Invalidation Registry

A module-level global `Map<string, { invalidationTags? }>` that stores tag generation functions. Registered automatically when `defineEntities()` encounters entities with `invalidationTags`. Accessed at invalidation time via `getEntityInvalidationTags(entityName, params)`.

```typescript
function registerEntityInvalidation(entityName: string, config: { invalidationTags?: (params) => string[] }): void
function getEntityInvalidationTags(entityName: string, params: Record<string, unknown>): string[]
function clearEntityInvalidationRegistry(): void  // for testing
```

---

## 2. Cache Builder -- Fluent Configuration API

**Source**: `packages/cache/src/cache-builder.ts`

### Factory

```typescript
function createCacheBuilder<TEntityNames extends string>(
    registry: BuiltEntityRegistry<TEntityNames>
): CacheBuilderFactory<TEntityNames>
```

Returns a factory bound to a specific entity registry. The `.for()` call validates that the entity exists in the registry (throws if not found).

### Builder Chain

```
Cache.for(entity) -> .ttl(duration) -> [.grace() | .dependsOn() | .cacheNull() | .timeout() | .tags()] -> .build()
```

The `.ttl()` call is required before `.build()`. All other methods after `.ttl()` are optional.

### EntityInput

```typescript
type EntityInput<TEntityNames> = TEntityNames | EntityDef<TEntityNames>
```

Both string entity names and `EntityDef` objects (from `defineEntities()`) are accepted.

### Method Signatures

| Method | Signature | Description |
|--------|-----------|-------------|
| `for` | `for<TParams>(entity: EntityInput<TEntityNames>): CacheBuilderForEntity` | Start building a cache for an entity. |
| `ttl` | `ttl<T = DefaultTTL>(duration: T \| number): CacheBuilderWithTtl` | Set time-to-live. Type-constrained to `DefaultTTL` by default; custom types allowed via generic. |
| `grace` | `grace(duration: Duration): CacheBuilderWithTtl` | Set stale-while-revalidate grace period. |
| `dependsOn` | `dependsOn(entity, params?): CacheBuilderWithTtl` | Add dependency. Without `params`, auto-looks up entity params from registry. With `params`, uses explicit override. |
| `cacheNull` | `cacheNull(value?: boolean): CacheBuilderWithTtl` | Cache null/undefined results. Defaults to `true` when called without args. |
| `timeout` | `timeout(duration: Duration): CacheBuilderWithTtl` | Set data-fetch timeout. Parsed to seconds, stored as milliseconds (`* 1000`). Default if not set: 1000ms. |
| `tags` | `tags(tagsFn: (params: TParams) => string[]): CacheBuilderWithTtl` | Set tag function for cross-scope invalidation. |
| `build` | `build(): Readonly<CacheConfig<TParams>>` | Produces a frozen `CacheConfig`. |

### DefaultTTL

```typescript
type DefaultTTL = '30s' | '1m' | '5m' | '15m' | '30m' | '1h' | '6h' | '12h' | '1d' | '7d';
```

### params vs metaParams

The `build()` method auto-derives two distinct parameter sets:

- **params**: All parameters for cache key generation. Entity's full param list (scope params + unique keys).
- **metaParams**: Parameters for the meta key (invalidation granularity). Derived from the entity's scope params only (not the unique keys).

Example: `Product` at `project` scope with `productUuid` unique key:
- `params` = `['accountUuid', 'projectUuid', 'productUuid']`
- `metaParams` = `['accountUuid', 'projectUuid']`

### Auto-Derived Hierarchy Dependencies

The `buildDependsOn()` method automatically adds dependencies on scope-level entities by convention. For each scope up to (and including) the entity's scope, it capitalizes the scope name and checks if that entity exists in the registry. Self-references are excluded.

Example: For `Product` at `project` scope with scopes `[global, account, project]`:
- Checks `Global`, `Account`, `Project` (skips `Product` itself since that's the entity being built)
- If `Account` and `Project` exist in registry at their respective scopes, adds them to `dependsOn`

Additional dependencies from `.dependsOn()` calls are merged after hierarchy deps.

### CacheConfig Output

```typescript
interface CacheConfig<TParams extends object = object> {
    readonly entity: string;
    readonly scope: string;
    readonly ttl: number;              // seconds
    readonly grace: number;            // seconds (0 = disabled)
    readonly params: readonly (keyof TParams)[];
    readonly metaParams: readonly (keyof TParams)[];
    readonly dependsOn: Readonly<Partial<Record<string, readonly (keyof TParams)[]>>>;
    readonly cacheNull: boolean;
    readonly timeout?: number;         // milliseconds
    readonly tags?: (params: TParams) => string[];
}
```

---

## 3. CacheService -- High-Level Cache Operations

**Source**: `packages/cache/src/cache.ts`

### Constructor

```typescript
class CacheService {
    constructor(provider: CacheProvider, options?: CacheServiceOptions)
}

interface CacheServiceOptions {
    defaultGrace?: Duration;
    keyPrefix?: string;
}
```

Internally creates a `Singleflight` instance with `errorTtlMs: 0` (error caching disabled -- CacheService has its own error handling and factories may return different results on retry).

### getOrSet()

```typescript
async getOrSet<T, TParams extends object>(
    config: CacheConfig<TParams>,
    params: TParams,
    factory: (ctx: FactoryContext<T>) => Promise<T>
): Promise<T | undefined>
```

The primary cache-aside method. Behavior timeline:

```
|-------- TTL --------|-------- Grace --------|--- Expired ---|
^                     ^                       ^
createdAt             expiresAt               graceExpiresAt
```

1. **Fresh** (`now < expiresAt`): Return cached value immediately. No factory call.
2. **Stale** (`expiresAt <= now < graceExpiresAt`): Call factory with stale context. On factory success, cache new value. On factory failure/timeout, return stale value as fallback.
3. **Expired/Miss**: Call factory. No stale fallback. Factory errors propagate to caller.

The entire operation is wrapped in `singleflight.do(cacheKey, ...)` to prevent thundering herd.

### Factory Context

```typescript
interface FactoryContext<T> {
    skip(): never;                    // Don't cache, return undefined
    fail(message: string): never;     // Signal error, use stale if available
    readonly staleValue: T | undefined;
    readonly staleAge: number | undefined;  // seconds (with decimal precision)
}
```

- `skip()` throws a `SKIP_SENTINEL` symbol. Caught by `getOrSet`, returns `undefined`.
- `fail(msg)` throws a `CacheFailError`. If stale value exists, returns it. Otherwise, re-throws.

### Timeout

Default: 1000ms (1 second). Configurable per cache via `config.timeout` (in milliseconds).

```typescript
class CacheTimeoutError extends Error {
    constructor(timeoutMs: number)
}
```

The factory promise is raced against a timeout promise via `withTimeout()`. Uses `Promise.race()` with a `.finally()` cleanup to clear the timeout handle.

If timeout fires during stale window, the stale value is returned as fallback.

### CacheEntry Structure

```typescript
interface CacheEntry<T> {
    value: T;
    createdAt: number;       // ms since epoch
    expiresAt: number;       // ms since epoch (createdAt + ttl * 1000)
    graceExpiresAt?: number; // ms since epoch (createdAt + (ttl + grace) * 1000)
}
```

Stored TTL (passed to provider) includes the grace period: `totalTtl = ttl + grace`.

### Direct Operations

| Method | Signature | Description |
|--------|-----------|-------------|
| `get` | `get<T, TParams>(config, params): Promise<T \| undefined>` | Direct cache read. Returns value if fresh or within grace. |
| `set` | `set<T, TParams>(config, params, value): Promise<void>` | Direct cache write. |
| `delete` | `delete<TParams>(config, params): Promise<boolean>` | Delete a single cache entry. |
| `invalidate` | `invalidate<TEntityName, TParams>(entityType, params, options?): Promise<number>` | Cascade invalidation. |
| `invalidateMany` | `invalidateMany(invalidations[], options?): Promise<number>` | Batch cascade invalidation. |

### Invalidation

```typescript
interface InvalidateOptions {
    cascade?: boolean;  // default: true
}
```

When `cascade: true` and the provider supports meta operations (`hasMetaSupport()` type guard):
1. Generates the entity's meta key via `generateMetaKey(entityType, params)`
2. Retrieves entity's `invalidationTags` from the global registry
3. Generates tag meta keys for each tag
4. Calls `provider.delByMetaMany([metaKey, ...tagMetaKeys])` for atomic deletion

When `cascade: false` or provider lacks meta support: direct `provider.del(metaKey)`.

### Meta Key Generation During setEntry()

When the provider supports meta (`hasMetaSupport()`), `setEntry()` generates meta keys:
1. Self meta key: `generateConfigMetaKey(config, params)` using `config.metaParams`
2. Dependency meta keys: For each entry in `config.dependsOn`, extracts the relevant param subset and generates `generateMetaKey(entityType, depParams)`
3. Tag meta keys: If `config.tags` is defined, calls `config.tags(params)` and generates `generateTagMetaKey(tag)` for each

These meta keys are passed to `provider.setWithMeta()` for association tracking.

---

## 4. Singleflight -- Thundering Herd Prevention

**Source**: `packages/cache/src/singleflight.ts`

Prevents duplicate concurrent executions for the same key. First caller executes; subsequent callers receive the same promise.

### Constructor

```typescript
class Singleflight {
    constructor(options?: SingleflightOptions)
}

interface SingleflightOptions {
    errorTtlMs?: number;  // default: 5000 (5 seconds)
}
```

### Internal State

- `flights: Map<string, { promise: Promise<unknown> }>` -- in-flight operations
- `errors: Map<string, { error: Error; until: number }>` -- cached errors with expiry timestamp

### do()

```typescript
async do<T>(key: string, fn: () => Promise<T>): Promise<T>
```

Execution flow:
1. Check `errors` map for cached error. If found and not expired, re-throw immediately.
2. Check `flights` map for in-flight request. If found, return the existing promise.
3. Create new flight: execute `fn()`. On success, clear error cache. On failure, cache error with `Date.now() + errorTtlMs`. In `finally`, delete from `flights`.
4. Store flight and return promise.

### Additional Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `forget(key)` | `void` | Delete both in-flight and cached error for key. |
| `forgetError(key)` | `void` | Delete only the cached error. |
| `isInflight(key)` | `boolean` | Check if a key has an active flight. |
| `hasError(key)` | `boolean` | Check if a key has a non-expired cached error. |
| `getInflightCount()` | `number` | Number of active flights. |
| `getErrorCount()` | `number` | Number of cached errors (including expired). |
| `clear()` | `void` | Clear all state. For testing only. |

### Global Instance

```typescript
export const globalSingleflight = new Singleflight();
```

---

## 5. Key Generation -- Deterministic Cache Keys

**Source**: `packages/cache/src/key-generator.ts`

All key generation uses `fast-json-stable-stringify` for deterministic serialization and `Bun.hash()` (wyhash algorithm) for hashing, with base36 encoding for compact representation.

### Key Prefixes

```typescript
const CACHE_KEY_PREFIX = 'cache:';
const META_KEY_PREFIX = 'cache:meta:';
const TAG_META_KEY_PREFIX = 'cache:tag:';
```

### generateCacheKey()

```typescript
function generateCacheKey<TParams>(config: CacheConfig<TParams>, params: TParams): string
```

1. Extracts only the params listed in `config.params` from the `params` object.
2. Validates all declared params are present (not `undefined`). Throws on missing params to prevent cache key collisions.
3. Material: `stringify({ name: config.entity, params: extractedParams })`
4. Output: `cache:{base36(wyhash(material))}`

### generateMetaKey()

```typescript
function generateMetaKey<TEntityName, TParams>(entityType: TEntityName, params: TParams): string
```

1. Builds object: `{ entity: entityType, ...params }`
2. Removes `undefined` values.
3. Material: `stringify(metaKeyData)`
4. Output: `cache:meta:{base36(wyhash(material))}`

### generateConfigMetaKey()

```typescript
function generateConfigMetaKey<TParams>(config: CacheConfig<TParams>, params: TParams): string
```

Extracts only `config.metaParams` from `params`, validates all are present, then delegates to `generateMetaKey(config.entity, metaParams)`.

### generateTagMetaKey()

```typescript
function generateTagMetaKey(tag: string): string
```

Material: the tag string directly. Output: `cache:tag:{base36(wyhash(tag))}`. Throws on empty tag.

### Key Utility Functions

| Function | Description |
|----------|-------------|
| `isCacheKey(key)` | Starts with `cache:` but not `cache:meta:` |
| `isMetaKey(key)` | Starts with `cache:meta:` |
| `isTagMetaKey(key)` | Starts with `cache:tag:` |
| `cacheKeyToMetaKey(key)` | Replaces `cache:` prefix with `cache:meta:` |
| `extractHash(key)` | Returns the hash portion after the prefix |

---

## 6. Provider Interfaces

**Source**: `packages/cache/src/types.ts`

### CacheProvider (Base)

```typescript
interface CacheProvider {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
    del(key: string): Promise<number>;
    delMany(keys: string[]): Promise<number>;
    exists(key: string): Promise<boolean>;
    ttl(key: string): Promise<number>;   // -1 = no expiry, -2 = not found
}
```

### CacheProviderWithMeta (Extended)

```typescript
interface CacheProviderWithMeta extends CacheProvider {
    setWithMeta(key: string, value: unknown, ttlSeconds: number, metaKeys: string[]): Promise<void>;
    delByMeta(metaKey: string): Promise<number>;
    delByMetaMany(metaKeys: string[]): Promise<number>;
}
```

### Type Guard

```typescript
function hasMetaSupport(provider: CacheProvider): provider is CacheProviderWithMeta
```

Checks for the existence and function-type of `setWithMeta`, `delByMeta`, and `delByMetaMany`.

---

## 7. InMemoryCacheProvider -- Testing Implementation

**Source**: `packages/cache/src/in-memory-cache-provider.ts`

Implements `CacheProvider` only (no meta support). Backed by `Map<string, { value: unknown; expiresAt: number | null }>`.

- TTL enforcement is lazy (checked on `get`, `exists`, `ttl`). Expired entries are deleted on read.
- `ttlSeconds = 0` means no expiration (`expiresAt = null`).
- Does NOT support cascade invalidation. When used with `CacheService`, `invalidate()` falls back to direct `del()`.
- Additional methods: `clear()` (reset all state), `size` getter (total entries including expired).

---

## 8. Duration Parsing

**Source**: `packages/cache/src/duration.ts`

### Type

```typescript
type Duration = `${number}${'s' | 'm' | 'h' | 'd'}` | number | '0';
```

### parseDuration()

```typescript
function parseDuration(duration: Duration): number  // returns seconds
```

| Input | Output |
|-------|--------|
| `number` | Passthrough (validated: finite, non-negative, <= 365 days) |
| `'0'` | `0` |
| `'30s'` | `30` |
| `'5m'` | `300` |
| `'1h'` | `3600` |
| `'1d'` | `86400` |

Maximum: `MAX_DURATION_SECONDS = 31,536,000` (365 days). Throws on invalid format, negative, non-finite, or overflow.

Unit multipliers: `s=1`, `m=60`, `h=3600`, `d=86400`. Case-insensitive matching via regex `/^(\d+)([smhd])$/`.

### formatDuration()

```typescript
function formatDuration(seconds: number): string
```

Inverse of parse. Prefers largest evenly-divisible unit.

---

## 9. CacheRegistry -- Configuration Storage and Dependency Graphs

**Source**: `packages/cache/src/cache-registry.ts`

Stores `CacheConfig` objects and maintains forward/reverse dependency graphs for introspection. This is a module-level registry for compile-time/startup validation -- the actual key-to-key associations live in Redis.

### Internal State

- `configs: Map<EntityType, CacheConfig[]>` -- multiple configs per entity type
- `dependencyGraph: Map<EntityType, Set<EntityType>>` -- forward: entity -> what it depends on
- `reverseDependencyGraph: Map<EntityType, Set<EntityType>>` -- reverse: entity -> what depends on it

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `register<TParams>(config: CacheConfig<TParams>): void` | Register a config. Updates both graphs from `config.dependsOn`. |
| `getByEntityType` | `getByEntityType(entityType): readonly CacheConfig[]` | Get all configs for an entity type. |
| `getDependents` | `getDependents(entityType): Set<EntityType>` | Reverse lookup: what depends on this entity. |
| `getDependencies` | `getDependencies(entityType): Set<EntityType>` | Forward lookup: what this entity depends on. |
| `validateNoCycles` | `validateNoCycles(): void` | DFS cycle detection. Throws with cycle path on detection. |
| `getRegisteredEntityTypes` | `getRegisteredEntityTypes(): EntityType[]` | List all registered entity types. |
| `size` | `number` (getter) | Total number of registered configs. |
| `reset` | `reset(): void` | Clear all state (for testing). |
| `getSummary` | `getSummary(): { entityTypes, totalConfigs, dependencyEdges }` | Debug summary. |

### Singleton

```typescript
export const cacheRegistry = new CacheRegistry();
```

Global singleton. Intended for framework-level module constants that are defined before the DI container initializes. Test isolation uses container-level Redis separation plus `cacheRegistry.reset()`.

---

## 10. RedisCacheProvider -- Production Implementation

**Source**: `packages/cache-redis/src/redis-cache.ts`

### Constructor

```typescript
class RedisCacheProvider implements CacheProvider {
    constructor(options: RedisCacheProviderOptions)
}

interface RedisCacheProviderOptions {
    readonly connection: { host: string; port: number };
    readonly logger?: Logger;
    readonly connectTimeout?: number;  // default: 2000ms
}
```

Creates its own `ioredis` Redis instance with:
- `connectTimeout`: 2000ms default
- `maxRetriesPerRequest: 1` (fail fast)
- Error handler on connection to prevent unhandled `'error'` events

### get()

Uses `Json.parse()` (from `@orijs/validation`) for prototype pollution protection during deserialization. On parse failure, returns `null` (treats corrupted entries as cache miss).

### set()

Uses `PSETEX` (millisecond precision) when `ttlSeconds > 0`:
```
ttlMs = Math.ceil(ttlSeconds * 1000)
```

This provides sub-second TTL precision since the cache system works with integer seconds but PSETEX accepts milliseconds.

### setWithMeta()

Uses a Redis pipeline (single round-trip) to:
1. `PSETEX key ttlMs value` (or `SET` if no TTL)
2. For each meta key: `SADD metaKey cacheKey` + `EXPIRE metaKey (ceil(ttlSeconds) + 60)`

Meta key TTL buffer: `META_KEY_TTL_BUFFER_SECONDS = 60`. This ensures meta keys outlive their associated cache entries, preventing orphaned meta references.

Pipeline errors are logged but not thrown (cache operations should be resilient).

### Cascade Invalidation Lua Script

`delByMeta()` delegates to `delByMetaMany()` with a single-element array.

`delByMetaMany()` executes an atomic Lua script:

```lua
local cacheKeys = {}
local seen = {}

-- Gather all cache keys from all meta sets (deduplication via seen table)
for i, metaKey in ipairs(KEYS) do
    local members = redis.call('SMEMBERS', metaKey)
    for j, member in ipairs(members) do
        if not seen[member] then
            seen[member] = true
            table.insert(cacheKeys, member)
        end
    end
end

-- Delete all cache keys
local deleted = 0
for i, cacheKey in ipairs(cacheKeys) do
    deleted = deleted + redis.call('DEL', cacheKey)
end

-- Delete all meta keys
for i, metaKey in ipairs(KEYS) do
    redis.call('DEL', metaKey)
end

return deleted
```

The Lua script ensures atomicity: no new keys can be added to meta sets between the `SMEMBERS` lookup and `DEL` operations. This prevents race conditions where a new cache entry associates itself with a meta key that is about to be deleted.

The script is benchmarked at 50-65% faster than the alternative `SMEMBERS` + pipeline `DEL` approach.

On Lua script failure: logs warning, returns `0` (non-blocking -- does not throw).

### Error Handling Strategy

| Operation | Failure Behavior |
|-----------|-----------------|
| `get()` parse failure | Return `null` (cache miss) |
| `set()` / `PSETEX` | Throws (propagates to caller) |
| `setWithMeta()` pipeline | Logs warning, does not throw |
| `delByMetaMany()` Lua script | Logs warning, returns `0` |
| Connection error | Logged via `redis.on('error')`, does not crash |

### stop()

Gracefully closes the Redis connection. Attempts `redis.quit()` first; falls back to `redis.disconnect()` if quit fails. Only acts if `redis.status === 'ready'`.

### Factory

```typescript
function createRedisCacheProvider(options: RedisCacheProviderOptions): RedisCacheProvider
```
