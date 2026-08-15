/**
 * Direct collection invalidation (upstat BUG-11-166 investigation).
 *
 * `invalidate(entityName, params)` derives its meta key from `{entity, ...params}`
 * verbatim (cache.ts generateMetaKey), while a write derives the self meta key
 * from the config's declared `metaParams` (generateConfigMetaKey). When a caller
 * passes a params object carrying MORE fields than the config declares — the
 * common shape when a request-scoped user object is threaded straight through —
 * those two derivations can disagree and the entry survives the invalidate.
 *
 * These tests pin both shapes on the Redis meta-key path, which is the path
 * production uses.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { createRedisTestHelper, type RedisTestHelper } from "@orijs/test-utils";
import {
  EntityRegistry,
  createCacheBuilder,
  CacheService,
  cacheRegistry,
} from "../src";
import { RedisCacheProvider } from "@orijs/cache-redis";

type CollectionParams = { accountUuid: string; projectUuid: string };
type RequestScoped = CollectionParams & { fbAuthUid: string; email: string };

function createTestRegistry() {
  return EntityRegistry.create()
    .scope("global")
    .scope("account", "accountUuid")
    .scope("project", "projectUuid")
    .entity("Team", "project", "teamUuid")
    .entity("TeamsCollection", "project")
    .build();
}

const ACCT = "acct-a";
const PROJ = "proj-a";

describe("invalidate(Collection, params) — direct collection invalidation", () => {
  let redisHelper: RedisTestHelper;
  let redisCacheProvider: RedisCacheProvider;
  let cacheService: CacheService;

  beforeAll(() => {
    const packageName = process.env.TEST_PACKAGE_NAME || "orijs";
    redisHelper = createRedisTestHelper(packageName);
    if (!redisHelper.isReady()) {
      throw new Error(
        `Redis container not ready for ${packageName} — check Bun test preload`,
      );
    }
    const c = redisHelper.getConnectionConfig();
    redisCacheProvider = new RedisCacheProvider({
      connection: { host: c.host, port: c.port, db: c.db },
    });
    cacheService = new CacheService(redisCacheProvider);
  });

  beforeEach(async () => {
    await redisHelper.flushAll();
    cacheRegistry.reset();
  });

  afterAll(async () => {
    await redisCacheProvider.stop();
  });

  it("removes the entry when the invalidate params exactly match the config params", async () => {
    const Cache = createCacheBuilder(createTestRegistry());
    const TeamsCollectionCache = Cache.for<CollectionParams>("TeamsCollection")
      .ttl("1h")
      .dependsOn("Team")
      .build();

    let calls = 0;
    const factory = async () => {
      calls++;
      return [{ uuid: "t-1" }];
    };
    const params: CollectionParams = { accountUuid: ACCT, projectUuid: PROJ };

    await cacheService.getOrSet(TeamsCollectionCache, params, factory);
    await cacheService.getOrSet(TeamsCollectionCache, params, factory);
    expect(calls).toBe(1); // second read served from cache

    await cacheService.invalidate("TeamsCollection", params);

    await cacheService.getOrSet(TeamsCollectionCache, params, factory);
    expect(calls).toBe(2); // miss after invalidate
  });

  it("removes the entry when the caller threads a wider request-scoped object through both calls", async () => {
    const Cache = createCacheBuilder(createTestRegistry());
    const TeamsCollectionCache = Cache.for<CollectionParams>("TeamsCollection")
      .ttl("1h")
      .dependsOn("Team")
      .build();

    let calls = 0;
    const factory = async () => {
      calls++;
      return [{ uuid: "t-1" }];
    };
    // The extra fields are what a request-scoped user object carries.
    const wide: RequestScoped = {
      accountUuid: ACCT,
      projectUuid: PROJ,
      fbAuthUid: "uid-1",
      email: "dev@example.com",
    };

    await cacheService.getOrSet(
      TeamsCollectionCache,
      wide as unknown as CollectionParams,
      factory,
    );
    await cacheService.getOrSet(
      TeamsCollectionCache,
      wide as unknown as CollectionParams,
      factory,
    );
    expect(calls).toBe(1);

    await cacheService.invalidate("TeamsCollection", wide);

    await cacheService.getOrSet(
      TeamsCollectionCache,
      wide as unknown as CollectionParams,
      factory,
    );
    expect(calls).toBe(2);
  });
  // Reproduces the upstat BUG-11-166 shape: the config is registered on the
  // CacheService that WROTE the entry, and the invalidate is issued through a
  // DIFFERENT CacheService sharing the same provider. `configsByEntity` is
  // per-instance, so the invalidating service cannot derive the config-narrowed
  // meta key the write used and falls back to hashing `{entity, ...params}`.
  it("removes the entry when the invalidate is issued through a second CacheService on the same provider", async () => {
    const Cache = createCacheBuilder(createTestRegistry());
    const TeamsCollectionCache = Cache.for<CollectionParams>("TeamsCollection")
      .ttl("1h")
      .dependsOn("Team")
      .build();

    let calls = 0;
    const factory = async () => {
      calls++;
      return [{ uuid: "t-1" }];
    };
    const params: CollectionParams = { accountUuid: ACCT, projectUuid: PROJ };

    await cacheService.getOrSet(TeamsCollectionCache, params, factory);
    await cacheService.getOrSet(TeamsCollectionCache, params, factory);
    expect(calls).toBe(1);

    const otherService = new CacheService(redisCacheProvider);
    await otherService.invalidate("TeamsCollection", params);

    await cacheService.getOrSet(TeamsCollectionCache, params, factory);
    expect(calls).toBe(2);
  });

  // The production shape, and the intersection the two cases above miss: a
  // process that starts against an ALREADY-WARM cache serves only hits, so its
  // write path never runs and `configsByEntity` stays empty for the entity. The
  // invalidate then has no config to narrow with and falls back to hashing
  // `{entity, ...params}` — which the write never registered, because the write
  // registers the config-narrowed self meta key. Combined with a caller that
  // threads a wider request-scoped object through (the common controller shape),
  // the entry survives every invalidate until its TTL expires.
  it("removes the entry when a hit-only service invalidates with a wider params object", async () => {
    const Cache = createCacheBuilder(createTestRegistry());
    const TeamsCollectionCache = Cache.for<CollectionParams>("TeamsCollection")
      .ttl("1h")
      .dependsOn("Team")
      .build();

    let calls = 0;
    const factory = async () => {
      calls++;
      return [{ uuid: "t-1" }];
    };
    const wide: RequestScoped = {
      accountUuid: ACCT,
      projectUuid: PROJ,
      fbAuthUid: "uid-1",
      email: "dev@example.com",
    };

    // A previous process populated the cache.
    await cacheService.getOrSet(
      TeamsCollectionCache,
      wide as unknown as CollectionParams,
      factory,
    );
    expect(calls).toBe(1);

    // This process starts fresh against that warm cache: every read is a hit, so
    // nothing it does registers the config.
    const restarted = new CacheService(redisCacheProvider);
    await restarted.getOrSet(
      TeamsCollectionCache,
      wide as unknown as CollectionParams,
      factory,
    );
    expect(calls).toBe(1);

    await restarted.invalidate("TeamsCollection", wide);

    await restarted.getOrSet(
      TeamsCollectionCache,
      wide as unknown as CollectionParams,
      factory,
    );
    expect(calls).toBe(2);
  });
});
