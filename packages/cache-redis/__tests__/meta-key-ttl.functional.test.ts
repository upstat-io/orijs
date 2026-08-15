/**
 * Meta-key TTL lifetime under mixed entry TTLs.
 *
 * A meta key is the set of cache keys invalidation walks to find what to delete,
 * and one meta key is shared by every entry written against that entity. If the
 * meta key expires while an entry it tracks is still alive, that entry becomes
 * orphaned: invalidate() finds no member to delete, reports success, and the
 * stale value survives until its own TTL.
 *
 * The failure is silent and TTL-dependent — a short-lived entry looks fine
 * because it expires before anyone notices, while a long-lived one serves stale
 * data for its full lifetime.
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
import { RedisCacheProvider } from "../src/redis-cache";
import { Redis } from "ioredis";

describe("RedisCacheProvider meta-key TTL", () => {
  let redisHelper: RedisTestHelper;
  let redis: Redis;
  let redisCache: RedisCacheProvider;

  const META_KEY = "meta:Team:account-1";
  const LONG_TTL_SECONDS = 3600;
  const SHORT_TTL_SECONDS = 30;

  beforeAll(() => {
    redisHelper = createRedisTestHelper("orijs-cache-redis");
    if (!redisHelper.isReady()) {
      redisHelper = createRedisTestHelper("orijs");
    }
    if (!redisHelper.isReady()) {
      throw new Error("Redis container not ready - check Bun test preload");
    }
    const connectionConfig = redisHelper.getConnectionConfig();
    redis = new Redis({
      host: connectionConfig.host,
      port: connectionConfig.port,
      db: connectionConfig.db,
    });
    redis.on("error", () => {});
    redisCache = new RedisCacheProvider({
      connection: {
        host: connectionConfig.host,
        port: connectionConfig.port,
        db: connectionConfig.db,
      },
    });
  });

  beforeEach(async () => {
    await redisHelper.flushAll();
  });

  afterAll(async () => {
    if (redis) await redis.quit();
  });

  it("should not shorten a shared meta key TTL when a shorter-lived entry is written", async () => {
    // A long-lived collection entry, then a short-lived entry for the same
    // entity — the ordinary case when one entity backs configs with different
    // TTLs. The meta key must outlive the longest entry it tracks.
    await redisCache.setWithMeta(
      "cache:teams-collection",
      { teams: 19 },
      LONG_TTL_SECONDS,
      [META_KEY],
    );
    await redisCache.setWithMeta(
      "cache:team-detail",
      { team: 1 },
      SHORT_TTL_SECONDS,
      [META_KEY],
    );

    const metaTtl = await redis.ttl(META_KEY);

    expect(
      metaTtl,
      `the shared meta key expires in ${metaTtl}s while the entry it tracks lives ${LONG_TTL_SECONDS}s — ` +
        "that entry becomes un-invalidatable once the meta key is gone",
    ).toBeGreaterThanOrEqual(LONG_TTL_SECONDS);
  });

  it("should still extend a shared meta key TTL when a longer-lived entry is written", async () => {
    // The opposite order must still raise the ceiling, or a long entry written
    // after a short one is orphaned instead.
    await redisCache.setWithMeta(
      "cache:team-detail",
      { team: 1 },
      SHORT_TTL_SECONDS,
      [META_KEY],
    );
    await redisCache.setWithMeta(
      "cache:teams-collection",
      { teams: 19 },
      LONG_TTL_SECONDS,
      [META_KEY],
    );

    expect(await redis.ttl(META_KEY)).toBeGreaterThanOrEqual(LONG_TTL_SECONDS);
  });

  it("should keep both entries reachable through the shared meta key", async () => {
    // Negative control: the TTL fix must not cost set membership.
    await redisCache.setWithMeta(
      "cache:teams-collection",
      { teams: 19 },
      LONG_TTL_SECONDS,
      [META_KEY],
    );
    await redisCache.setWithMeta(
      "cache:team-detail",
      { team: 1 },
      SHORT_TTL_SECONDS,
      [META_KEY],
    );

    const members = await redis.smembers(META_KEY);

    expect(members.toSorted()).toEqual([
      "cache:team-detail",
      "cache:teams-collection",
    ]);
  });

  it("should leave a meta key persistent when an entry is written with no TTL", async () => {
    // A non-expiring entry must never be handed an expiring meta key.
    await redisCache.setWithMeta("cache:forever", { v: 1 }, 0, [META_KEY]);

    // -1 is Redis for "key exists, no expiry set".
    expect(await redis.ttl(META_KEY)).toBe(-1);
  });
});
