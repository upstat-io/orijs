import { expect, test } from "bun:test";
import { Workflow } from "@orijs/core";
import { Type } from "@orijs/validation";
import {
  BullMQWorkflowProvider,
  type IWorker,
} from "../../src/workflows/bullmq-workflow-provider";
import { QueueManager } from "../../src/events/queue-manager";
import { BullMQEventProvider } from "../../src/events/bullmq-event-provider";

test("should await the producer and every worker before sharing successful startup", async () => {
  const producerReady = Promise.withResolvers<void>();
  const workersReady = Promise.withResolvers<void>();
  const requestedWorkers: string[] = [];
  class RedisClient {
    on(): this {
      return this;
    }
    async exists(): Promise<number> {
      throw new Error("Unexpected Redis command");
    }
    async eval(): Promise<unknown> {
      throw new Error("Unexpected Redis command");
    }
  }
  class Producer {
    async add() {
      return { job: { id: "unused" } };
    }
    async close() {}
    async waitUntilReady() {
      await producerReady.promise;
    }
  }
  class Worker implements IWorker {
    connection = { _client: new RedisClient() };
    blockingConnection = { _client: new RedisClient() };
    constructor(private readonly name: string) {}
    on(): this {
      return this;
    }
    async close() {}
    async waitUntilReady() {
      requestedWorkers.push(this.name);
      await workersReady.promise;
    }
  }
  const definition = Workflow.define({
    name: "readiness",
    data: Type.Object({}),
    result: Type.Void(),
  }).steps((s) => s.sequential(s.step("first", Type.Void())));
  const provider = new BullMQWorkflowProvider({
    connection: { host: "unused" },
    FlowProducerClass: Producer,
    WorkerClass: Worker,
  });
  provider.registerDefinitionConsumer(
    definition.name,
    async () => undefined,
    definition.stepGroups,
    { first: { execute: async () => undefined } },
  );
  let started = false;
  const first = provider.start().then(() => {
    started = true;
  });
  const second = provider.start();
  try {
    await Promise.resolve();
    expect(started).toBe(false);
    producerReady.resolve();
    await Promise.resolve();
    expect(started).toBe(false);
  } finally {
    producerReady.resolve();
    workersReady.resolve();
    await Promise.all([first, second]);
    await provider.stop();
  }
  expect(requestedWorkers.sort()).toEqual([
    "workflow.readiness",
    "workflow.readiness.steps",
  ]);
});

test("should close an event worker whose connection fails before registration", async () => {
  const failure = new Error("Queue unavailable");
  let closed = 0;
  class RedisClient {
    on(): this {
      return this;
    }
    async exists(): Promise<number> {
      throw new Error("Unexpected Redis command");
    }
    async eval(): Promise<unknown> {
      throw new Error("Unexpected Redis command");
    }
  }
  class Worker {
    connection = { _client: new RedisClient() };
    blockingConnection = { _client: new RedisClient() };
    on(): void {}
    async waitUntilReady() {
      throw failure;
    }
    async close() {
      closed++;
    }
  }
  const manager = new QueueManager({
    connection: { host: "unused" },
    WorkerClass: Worker,
  });
  await expect(
    manager.registerWorker("unavailable", async () => undefined),
  ).rejects.toBe(failure);
  await manager.stop();
  expect(closed).toBe(1);
});

test("should clean event resources before provider startup has completed", async () => {
  let closes = 0;
  class Queues extends QueueManager {
    override async stop() {
      closes++;
      await super.stop();
    }
  }
  const provider = new BullMQEventProvider({
    connection: { host: "unused" },
    queueManager: new Queues({ connection: { host: "unused" } }),
  });
  await provider.stop();
  await provider.stop();
  expect(closes).toBe(1);
});
