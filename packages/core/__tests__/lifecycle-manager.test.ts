import { expect, test } from "bun:test";
import { Logger } from "@orijs/logging";
import { LifecycleManager } from "../src/lifecycle-manager";

test("should retain a synchronous shutdown failure and refuse restart", async () => {
  const lifecycle = new LifecycleManager({
    logger: new Logger("test", { level: "error" }),
    enableSignalHandling: false,
  });
  const failure = new Error("Synchronous shutdown failed");
  let calls = 0;
  const shutdown = lifecycle.executeGracefulShutdown(() => {
    calls++;
    throw failure;
  });
  await expect(shutdown).rejects.toBe(failure);
  expect(
    lifecycle.executeGracefulShutdown(async () => {
      calls++;
    }),
  ).toBe(shutdown);
  expect(() => lifecycle.resetForStartup()).toThrow(
    "Previous application shutdown did not succeed",
  );
  expect(calls).toBe(1);
});

test("should forbid restart after timeout even when the background work later finishes", async () => {
  const lifecycle = new LifecycleManager({
    logger: new Logger("test", { level: "error" }),
    enableSignalHandling: false,
    shutdownTimeoutMs: 10,
  });
  const work = Promise.withResolvers<void>();
  const stopped = lifecycle.executeGracefulShutdown(() => work.promise);
  try {
    await expect(stopped).rejects.toThrow("Shutdown timeout exceeded");
  } finally {
    work.resolve();
    await work.promise;
  }
  expect(() => lifecycle.resetForStartup()).toThrow(
    "Previous application shutdown did not succeed",
  );
  expect(lifecycle.executeGracefulShutdown(async () => {})).toBe(stopped);
});
