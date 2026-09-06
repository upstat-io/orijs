import { expect, test } from "bun:test";
import { TestEventProvider } from "@orijs/events";
import { InProcessWorkflowProvider } from "@orijs/workflows";
import { Ori } from "../src/application";
import type { OriController, RouteBuilder } from "../src/types";

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}

class GatedEvents extends TestEventProvider {
  readonly stopping = gate();
  readonly drain = gate();
  readonly drained = gate();
  stopCalls = 0;
  override async stop(): Promise<void> {
    this.stopCalls++;
    this.stopping.release();
    await this.drain.promise;
    await super.stop();
    this.drained.release();
  }
}

test("should share pending shutdown and drain events before workflows", async () => {
  const events = new GatedEvents();
  const order: string[] = [];
  class Workflows extends InProcessWorkflowProvider {
    override async stop(): Promise<void> {
      order.push("workflows");
      await super.stop();
    }
  }
  const app = Ori.create()
    .logger({ level: "error" })
    .disableSignalHandling()
    .eventProvider(events)
    .workflowProvider(new Workflows());
  app.context.onShutdown(() => {
    order.push("hook");
  });
  await app.listen(0);
  let firstFinished = false;
  let secondFinished = false;
  const first = app.stop().then(() => {
    firstFinished = true;
  });
  await events.stopping.promise;
  const second = app.stop().then(() => {
    secondFinished = true;
  });
  try {
    await Promise.resolve();
    expect(firstFinished).toBe(false);
    expect(secondFinished).toBe(false);
    expect(app.context.phase).toBe("stopping");
    expect(order).toEqual(["hook"]);
  } finally {
    events.drain.release();
    await Promise.all([first, second]);
  }
  await app.stop();
  expect(events.stopCalls).toBe(1);
  expect(order).toEqual(["hook", "workflows"]);
  expect(app.context.phase).toBe("stopped");
});

test("should retain a rejected shutdown outcome after provider failure", async () => {
  const failure = new Error("Event drain failed");
  class Events extends TestEventProvider {
    stopCalls = 0;
    override async stop(): Promise<void> {
      this.stopCalls++;
      throw failure;
    }
  }
  const events = new Events();
  const app = Ori.create()
    .logger({ level: "error" })
    .disableSignalHandling()
    .eventProvider(events);
  await app.listen(0);
  await expect(app.stop()).rejects.toBe(failure);
  await expect(app.stop()).rejects.toBe(failure);
  expect(events.stopCalls).toBe(1);
  expect(app.context.phase).toBe("stopping");
});

test("should reject every shutdown waiter on timeout without claiming consumer drain", async () => {
  const events = new GatedEvents();
  const app = Ori.create()
    .logger({ level: "error" })
    .disableSignalHandling()
    .setShutdownTimeout(30)
    .eventProvider(events);
  await app.listen(0);
  const stopped = app.stop();
  try {
    await expect(stopped).rejects.toThrow("Shutdown timeout exceeded");
    await expect(app.stop()).rejects.toThrow("Shutdown timeout exceeded");
    expect(app.context.phase).toBe("stopping");
    expect(events.stopCalls).toBe(1);
  } finally {
    events.drain.release();
    await events.drained.promise;
  }
});

test("should clean partially started providers before rejecting listen", async () => {
  const order: string[] = [];
  class Events extends TestEventProvider {
    override async start(): Promise<void> {
      order.push("events-start");
      await super.start();
    }
    override async stop(): Promise<void> {
      order.push("events-stop");
      await super.stop();
    }
  }
  class Workflows extends InProcessWorkflowProvider {
    override async start(): Promise<void> {
      order.push("workflows-start");
      throw new Error("Workflow startup failed");
    }
    override async stop(): Promise<void> {
      order.push("workflows-stop");
      await super.stop();
    }
  }
  const app = Ori.create()
    .logger({ level: "error" })
    .disableSignalHandling()
    .eventProvider(new Events())
    .workflowProvider(new Workflows());
  app.context.onShutdown(() => {
    order.push("hook");
  });
  await expect(app.listen(0)).rejects.toThrow("Workflow startup failed");
  await app.stop();
  expect(order).toEqual([
    "events-start",
    "workflows-start",
    "hook",
    "events-stop",
    "workflows-stop",
  ]);
  expect(app.context.phase).toBe("stopped");
});

test("should retain startup and cleanup errors when both fail", async () => {
  const startupError = new Error("Startup failed");
  const cleanupError = new Error("Cleanup failed");
  class Events extends TestEventProvider {
    override async start(): Promise<void> {
      throw startupError;
    }
    override async stop(): Promise<void> {
      throw cleanupError;
    }
  }
  const app = Ori.create()
    .logger({ level: "error" })
    .disableSignalHandling()
    .eventProvider(new Events());
  let caught: unknown;
  try {
    await app.listen(0);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  if (!(caught instanceof AggregateError))
    throw new Error("Expected combined startup and cleanup failure");
  expect(caught.errors).toEqual([startupError, cleanupError]);
  await expect(app.stop()).rejects.toBe(cleanupError);
});

test("should await startup before cleaning resources when stop overlaps listen", async () => {
  const starting = gate();
  const releaseStart = gate();
  class Events extends TestEventProvider {
    stopCalls = 0;
    override async start(): Promise<void> {
      starting.release();
      await releaseStart.promise;
      await super.start();
    }
    override async stop(): Promise<void> {
      this.stopCalls++;
      await super.stop();
    }
  }
  const events = new Events();
  const app = Ori.create()
    .logger({ level: "error" })
    .disableSignalHandling()
    .eventProvider(events);
  const listening = app.listen(0);
  await starting.promise;
  let finished = false;
  const stopped = app.stop().then(() => {
    finished = true;
  });
  try {
    await Promise.resolve();
    expect(finished).toBe(false);
  } finally {
    releaseStart.release();
    await listening;
    await stopped;
  }
  expect(events.stopCalls).toBe(1);
  expect(app.context.phase).toBe("stopped");
});

test("should drain an actual HTTP request before shutting down its dependencies", async () => {
  const entered = gate();
  const finish = gate();
  let dependenciesClosed = false;
  class Controller implements OriController {
    configure(routes: RouteBuilder) {
      routes.get("/", async () => {
        entered.release();
        await finish.promise;
        return Response.json({ dependenciesClosed });
      });
    }
  }
  const app = Ori.create()
    .logger({ level: "error" })
    .disableSignalHandling()
    .controller("/", Controller);
  app.context.onShutdown(() => {
    dependenciesClosed = true;
  });
  const server = await app.listen(0);
  const response = fetch(`http://127.0.0.1:${server.port}/`);
  await entered.promise;
  const stopped = app.stop();
  try {
    await Promise.resolve();
    expect(dependenciesClosed).toBe(false);
  } finally {
    finish.release();
  }
  expect(await (await response).json()).toEqual({ dependenciesClosed: false });
  await stopped;
  expect(dependenciesClosed).toBe(true);
});

test("should reject repeated listen without opening another server", async () => {
  const app = Ori.create().logger({ level: "error" }).disableSignalHandling();
  await app.listen(0);
  try {
    await expect(app.listen(0)).rejects.toThrow("already started");
  } finally {
    await app.stop();
  }
});

test("should release the application's rejection listener after shutdown and failed startup", async () => {
  const before = process.listenerCount("unhandledRejection");
  const app = Ori.create().logger({ level: "error" }).disableSignalHandling();
  await app.listen(0);
  try {
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
  } finally {
    await app.stop();
  }
  expect(process.listenerCount("unhandledRejection")).toBe(before);

  const failed = Ori.create()
    .logger({ level: "error" })
    .disableSignalHandling();
  failed.context.onStartup(() => {
    throw new Error("Startup unavailable");
  });
  await expect(failed.listen(0)).rejects.toThrow("Startup unavailable");
  expect(process.listenerCount("unhandledRejection")).toBe(before);
});
