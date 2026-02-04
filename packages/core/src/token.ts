/**
 * Token - Type-safe named injection tokens
 *
 * Creates strongly-typed symbols for use as injection tokens.
 * Use when you need multiple instances of the same type.
 *
 * @example
 * ```ts
 * // Define tokens for different cache instances
 * const HotCache = createToken<CacheService>('HotCache');
 * const ColdCache = createToken<CacheService>('ColdCache');
 *
 * // Register different instances
 * Ori.create()
 *   .providerInstance(HotCache, new CacheService(memoryProvider))
 *   .providerInstance(ColdCache, new CacheService(redisProvider))
 *   .provider(HotDataService, [HotCache])
 *   .provider(ColdDataService, [ColdCache])
 *   .listen(3000);
 *
 * // In service constructors
 * class HotDataService {
 *   constructor(private cache: CacheService) {}
 * }
 * ```
 *
 * @module
 */

/**
 * A typed injection token (symbol with type information).
 *
 * Token<T> is a symbol that carries type information about what it resolves to.
 * This enables type-safe dependency injection with named providers.
 *
 * @template T - The type of the value this token resolves to
 */
export type Token<T> = symbol & { readonly __type?: T };

/**
 * Creates a typed injection token.
 *
 * Use this to create named tokens for dependency injection when you need
 * multiple instances of the same type (e.g., multiple cache providers,
 * multiple database connections).
 *
 * @template T - The type of the value this token will resolve to
 * @param name - A descriptive name for the token (used in error messages)
 * @returns A typed symbol that can be used as an injection token
 *
 * @example
 * ```ts
 * // Create tokens for different configurations
 * const PrimaryDB = createToken<DatabaseService>('PrimaryDB');
 * const ReplicaDB = createToken<DatabaseService>('ReplicaDB');
 *
 * // Register with different instances
 * app.providerInstance(PrimaryDB, new DatabaseService(primaryConfig));
 * app.providerInstance(ReplicaDB, new DatabaseService(replicaConfig));
 *
 * // Inject specific instance
 * class UserRepository {
 *   constructor(
 *     @inject(PrimaryDB) private writeDb: DatabaseService,
 *     @inject(ReplicaDB) private readDb: DatabaseService,
 *   ) {}
 * }
 * ```
 */
export function createToken<T>(name: string): Token<T> {
	return Symbol(name) as Token<T>;
}

/**
 * Type guard to check if a value is a Token.
 *
 * @param value - The value to check
 * @returns True if the value is a symbol (Token)
 */
export function isToken(value: unknown): value is Token<unknown> {
	return typeof value === 'symbol';
}
