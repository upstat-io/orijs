import { describe, expect, it } from "bun:test";
import type { ConnectionOptions } from "bullmq";
import {
  CompletionTracker,
  type CompletionCallback,
  type IQueueEventsLike,
} from "../../src/events/completion-tracker.ts";

class StubRedisClient {
  public on(_event: string, _handler: (...args: unknown[]) => void): this {
    return this;
  }
}

class StubQueueEvents implements IQueueEventsLike {
  public readonly connection = { _client: new StubRedisClient() };

  public constructor(
    _name: string,
    _options: { connection: ConnectionOptions },
  ) {}

  public on(_event: string, _callback: (...args: unknown[]) => void): void {}

  public waitUntilReady(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("CompletionTracker exact optional storage", () => {
  it("omits absent error and timeout callbacks from a pending registration", async () => {
    const tracker = new CompletionTracker({
      connection: { host: "localhost", port: 6379 },
      defaultTimeout: 0,
      QueueEventsClass: StubQueueEvents,
    });
    const onSuccess: CompletionCallback = () => {};

    tracker.register("event.test", "corr-no-optionals", onSuccess);

    const pending = Reflect.get(tracker, "pending") as Map<
      string,
      Map<string, Record<string, unknown>>
    >;
    const registration = pending.get("event.test")?.get("corr-no-optionals");
    expect(registration).toBeDefined();
    expect(Object.hasOwn(registration ?? {}, "onError")).toBeFalse();
    expect(Object.hasOwn(registration ?? {}, "timeoutHandle")).toBeFalse();

    await tracker.stop();
  });
});
