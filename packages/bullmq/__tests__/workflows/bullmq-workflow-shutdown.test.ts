import { describe, expect, it, mock } from "bun:test";
import type { Job } from "bullmq";
import { Workflow } from "@orijs/core";
import { Type } from "@orijs/validation";
import type { StepGroup } from "@orijs/workflows";
import {
  BullMQWorkflowProvider,
  type IFlowProducer,
  type IQueueEvents,
  type IWorker,
} from "../../src/workflows/bullmq-workflow-provider.ts";
import type { FlowJobDefinition } from "../../src/workflows/flow-builder.ts";

function createCloseGate(): { readonly wait: Promise<void>; release(): void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

class TestRedisClient {
  public on(): this {
    return this;
  }

  public async set(): Promise<"OK"> {
    return "OK";
  }

  public async get(): Promise<null> {
    return null;
  }
}

class TestFlowProducer implements IFlowProducer {
  public readonly connection = { _client: new TestRedisClient() };

  public async add(flow: FlowJobDefinition): Promise<{ job: { id: string } }> {
    return { job: { id: flow.opts?.jobId ?? flow.name } };
  }

  public async close(): Promise<void> {}
}

describe("BullMQWorkflowProvider shutdown", () => {
  it("should initiate independent worker closes together when stopping", async () => {
    const workerCloseStarts: string[] = [];
    const closeGate = createCloseGate();

    class GatedWorker implements IWorker {
      public readonly connection = { _client: new TestRedisClient() };
      public readonly blockingConnection = { _client: new TestRedisClient() };

      constructor(
        private readonly queueName: string,
        _processor: (job: Job) => Promise<unknown>,
        _options: unknown,
      ) {}

      public on(): this {
        return this;
      }

      public async close(): Promise<void> {
        workerCloseStarts.push(this.queueName);
        await closeGate.wait;
      }
    }

    const provider = new BullMQWorkflowProvider({
      connection: { host: "localhost", port: 6379 },
      queuePrefix: "shutdown-workers",
      defaultTimeout: 0,
      FlowProducerClass: TestFlowProducer,
      WorkerClass: GatedWorker,
    });
    const stepGroups: StepGroup[] = [
      { type: "sequential", definitions: [{ name: "step" }] },
    ];
    const stepHandlers = { step: { execute: async () => undefined } };
    provider.registerDefinitionConsumer(
      "alpha",
      async () => undefined,
      stepGroups,
      stepHandlers,
    );
    provider.registerDefinitionConsumer(
      "beta",
      async () => undefined,
      stepGroups,
      stepHandlers,
    );
    await provider.start();

    const stopping = provider.stop();
    try {
      await Promise.resolve();
      expect(workerCloseStarts).toEqual([
        "shutdown-workers.alpha.steps",
        "shutdown-workers.beta.steps",
        "shutdown-workers.alpha",
        "shutdown-workers.beta",
      ]);
    } finally {
      closeGate.release();
      await stopping;
    }
  });

  it("should initiate independent QueueEvents closes together before closing the producer", async () => {
    const queueEventCloseStarts: string[] = [];
    const closeGate = createCloseGate();
    const firstCloseStarted = createCloseGate();
    const producerClose = mock(async () => undefined);

    class GatedFlowProducer extends TestFlowProducer {
      public override close = producerClose;
    }

    class GatedQueueEvents implements IQueueEvents {
      public readonly connection = { _client: new TestRedisClient() };

      constructor(
        private readonly queueName: string,
        _options: unknown,
      ) {}

      public on(): this {
        return this;
      }

      public off(): this {
        return this;
      }

      public async waitUntilReady(): Promise<void> {}

      public async close(): Promise<void> {
        queueEventCloseStarts.push(this.queueName);
        firstCloseStarted.release();
        await closeGate.wait;
      }
    }

    class IdleWorker implements IWorker {
      public readonly connection = { _client: new TestRedisClient() };
      public readonly blockingConnection = { _client: new TestRedisClient() };

      public on(): this {
        return this;
      }

      public async close(): Promise<void> {}
    }

    const provider = new BullMQWorkflowProvider({
      connection: { host: "localhost", port: 6379 },
      queuePrefix: "shutdown-events",
      defaultTimeout: 0,
      FlowProducerClass: GatedFlowProducer,
      WorkerClass: IdleWorker,
      QueueEventsClass: GatedQueueEvents,
    });
    const alpha = Workflow.define({
      name: "alpha",
      data: Type.Object({}),
      result: Type.Void(),
    });
    const beta = Workflow.define({
      name: "beta",
      data: Type.Object({}),
      result: Type.Void(),
    });
    provider.registerEmitterWorkflow(alpha.name);
    provider.registerEmitterWorkflow(beta.name);
    await provider.start();
    await provider.execute(alpha, {});
    await provider.execute(beta, {});

    const stopping = provider.stop();
    try {
      await firstCloseStarted.wait;
      expect(queueEventCloseStarts).toEqual([
        "shutdown-events.alpha",
        "shutdown-events.beta",
      ]);
      expect(producerClose).not.toHaveBeenCalled();
    } finally {
      closeGate.release();
      await stopping;
    }
    expect(producerClose).toHaveBeenCalledTimes(1);
  });
});
