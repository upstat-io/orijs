/**
 * Cache Key Generator
 *
 * Generates deterministic cache keys and meta keys for the cache system.
 * Uses Bun's native hash function (wyhash) for fast, deterministic hashing.
 *
 * Key Formats:
 * - Cache key: cache:{hash}
 * - Meta key:  cache:meta:{hash}
 */

import stringify from 'fast-json-stable-stringify';
import type { CacheConfig } from './types';
import { CACHE_KEY_PREFIX, META_KEY_PREFIX, TAG_META_KEY_PREFIX } from './types';

/**
 * Hash a string using Bun's native hash function.
 * Returns a base36-encoded string for compact representation.
 */
function hash(material: string): string {
	return Bun.hash(material).toString(36);
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE KEY GENERATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a cache key from CacheConfig and parameters
 *
 * Key format:
 * - Material: stringify({ name: entityName, params: extractedParams })
 * - Hash: Bun.hash (wyhash), base36 encoded
 * - Output: cache:{hash}
 *
 * @param config - Cache configuration from builder
 * @param params - Parameters object (only keys in config.params are used)
 * @returns Deterministic cache key string
 *
 * @example
 * const UserCache = Cache.define<UserParams>('User')
 *   .scope('account')
 *   .ttl('1h')
 *   .params('accountUuid', 'userUuid')
 *   .build();
 *
 * generateCacheKey(UserCache, { accountUuid: 'abc', userUuid: 'def' })
 * // => 'cache:7h5g8k2m4n1p'
 */
export function generateCacheKey<TParams extends object>(
	config: CacheConfig<TParams>,
	params: TParams
): string {
	if (!config) {
		throw new Error('CacheConfig is required');
	}
	if (!config.entity) {
		throw new Error('CacheConfig.entity is required');
	}
	if (params === null || params === undefined) {
		throw new Error('Params must be an object');
	}

	// Extract only the parameters specified in config.params
	const extractedParams = extractCacheParams(config.params, params, config.entity);

	// Create deterministic material string
	const material = stringify({ name: config.entity, params: extractedParams });

	// Hash with Bun's native hash function
	const keyHash = hash(material);

	return `${CACHE_KEY_PREFIX}${keyHash}`;
}

/**
 * Extract cache parameters using the config's parameter list
 *
 * - Only includes parameters specified in the config
 * - VALIDATES all declared params are present (not undefined)
 * - Throws if any required param is missing to prevent cache collisions
 */
function extractCacheParams<TParams extends object>(
	paramKeys: readonly (keyof TParams)[],
	params: TParams,
	entityName: string
): Record<string, unknown> {
	const extractedParams: Record<string, unknown> = {};
	const missingParams: string[] = [];

	for (const paramName of paramKeys) {
		const value = params[paramName];
		if (value === undefined) {
			missingParams.push(String(paramName));
		} else {
			extractedParams[paramName as string] = value;
		}
	}

	// Validate all declared params are present to prevent cache key collisions
	if (missingParams.length > 0) {
		throw new Error(
			`Missing required cache params for '${entityName}': ${missingParams.join(', ')}. ` +
				`All params declared in CacheConfig must be provided to ensure cache isolation.`
		);
	}

	return extractedParams;
}

// ════════════════════════════════════════════════════════════════════════════
// META KEY GENERATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a meta key for dependency tracking
 *
 * Key format:
 * - Material: stringify({ entity, ...params })
 * - Removes undefined values before stringifying
 * - Hash: Bun.hash (wyhash), base36 encoded
 * - Output: cache:meta:{hash}
 *
 * Meta keys are used to track which cache entries depend on which entities.
 * When an entity changes, we look up its meta key to find dependent caches.
 *
 * @template TEntityName - The entity type string (consumer-defined)
 * @template TParams - The parameters object type
 * @param entityType - The entity type (e.g., 'User', 'Product', 'Account')
 * @param params - Parameters for meta key (any scope params, e.g., { accountUuid, projectUuid })
 * @returns Meta key string
 *
 * @example
 * generateMetaKey('User', { accountUuid: 'abc' })
 * // => 'cache:meta:xyz789ghi'
 *
 * generateMetaKey('Product', { accountUuid: 'abc', projectUuid: 'def' })
 * // => 'cache:meta:abc123xyz'
 *
 * // Generic usage with any scope params
 * generateMetaKey('Tenant', { tenantId: 'xyz' })
 * // => 'cache:meta:tenant123'
 */
export function generateMetaKey<TEntityName extends string, TParams extends object>(
	entityType: TEntityName,
	params: TParams
): string {
	if (!entityType) {
		throw new Error('Entity type is required');
	}
	if (params === null || params === undefined) {
		throw new Error('Params must be an object');
	}

	// Build meta key data - entity + all provided params
	const metaKeyData: Record<string, unknown> = {
		entity: entityType,
		...params
	};

	// Remove undefined values for clean hashing
	Object.keys(metaKeyData).forEach((key) => {
		if (metaKeyData[key] === undefined) {
			delete metaKeyData[key];
		}
	});

	const material = stringify(metaKeyData);
	const metaHash = hash(material);

	return `${META_KEY_PREFIX}${metaHash}`;
}

/**
 * Generate a meta key using CacheConfig's metaParams
 *
 * Extracts only the parameters specified in config.metaParams from the full
 * params object, then generates the meta key. This ensures consistent meta
 * keys based on the cache configuration's invalidation granularity.
 *
 * @param config - Cache configuration with metaParams defined
 * @param params - Full parameters object
 * @returns Meta key string
 * @throws Error if any declared metaParam is undefined
 */
export function generateConfigMetaKey<TParams extends object>(
	config: CacheConfig<TParams>,
	params: TParams
): string {
	// Extract only the meta params specified in config
	const metaParams: Record<string, unknown> = {};
	const missingParams: string[] = [];

	for (const key of config.metaParams) {
		const value = params[key];
		if (value === undefined) {
			missingParams.push(String(key));
		} else {
			metaParams[key as string] = value;
		}
	}

	// Validate all declared meta params are present for correct invalidation
	if (missingParams.length > 0) {
		throw new Error(
			`Missing required meta params for '${config.entity}': ${missingParams.join(', ')}. ` +
				`All metaParams declared in CacheConfig must be provided for cascade invalidation.`
		);
	}

	return generateMetaKey(config.entity, metaParams);
}

// ════════════════════════════════════════════════════════════════════════════
// KEY UTILITIES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if a key is a cache key
 */
export function isCacheKey(key: string): boolean {
	return key.startsWith(CACHE_KEY_PREFIX) && !key.startsWith(META_KEY_PREFIX);
}

/**
 * Check if a key is a meta key
 */
export function isMetaKey(key: string): boolean {
	return key.startsWith(META_KEY_PREFIX);
}

/**
 * Convert a cache key to its corresponding meta key
 */
export function cacheKeyToMetaKey(cacheKey: string): string {
	if (!isCacheKey(cacheKey)) {
		throw new Error(`Not a cache key: ${cacheKey}`);
	}
	return cacheKey.replace(CACHE_KEY_PREFIX, META_KEY_PREFIX);
}

/**
 * Extract hash from any key type
 */
export function extractHash(key: string): string {
	if (isCacheKey(key)) {
		return key.substring(CACHE_KEY_PREFIX.length);
	}
	if (isMetaKey(key)) {
		return key.substring(META_KEY_PREFIX.length);
	}
	if (isTagMetaKey(key)) {
		return key.substring(TAG_META_KEY_PREFIX.length);
	}
	throw new Error(`Invalid key format: ${key}`);
}

// ════════════════════════════════════════════════════════════════════════════
// TAG META KEY GENERATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a tag meta key for cross-scope invalidation
 *
 * Tag meta keys enable invalidation across different scopes. When an entity
 * is invalidated and has invalidationTags, all caches tagged with matching
 * tags will also be invalidated.
 *
 * Key format:
 * - Material: tag string
 * - Hash: Bun.hash (wyhash), base36 encoded
 * - Output: cache:tag:{hash}
 *
 * @param tag - The tag string (e.g., 'user:abc123')
 * @returns Tag meta key string
 * @throws Error if tag is empty
 *
 * @example
 * generateTagMetaKey('user:abc123')
 * // => 'cache:tag:xyz789ghi'
 */
export function generateTagMetaKey(tag: string): string {
	if (!tag) {
		throw new Error('Tag is required');
	}
	return `${TAG_META_KEY_PREFIX}${hash(tag)}`;
}

/**
 * Check if a key is a tag meta key
 */
export function isTagMetaKey(key: string): boolean {
	return key.startsWith(TAG_META_KEY_PREFIX);
}
