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
  it("should own and close one QueueEvents initialization shared by concurrent executions", async () => {
    const readyGate = createCloseGate();
    const close = mock(async () => undefined);
    let constructionCount = 0;

    class InitializingQueueEvents implements IQueueEvents {
      public readonly connection = { _client: new TestRedisClient() };

      constructor(_queueName: string, _options: unknown) {
        constructionCount += 1;
      }

      public on(): this {
        return this;
      }

      public off(): this {
        return this;
      }

      public async waitUntilReady(): Promise<void> {
        await readyGate.wait;
      }

      public close = close;
    }

    const provider = new BullMQWorkflowProvider({
      connection: { host: "localhost", port: 6379 },
      queuePrefix: "shutdown-initializing-events",
      defaultTimeout: 0,
      FlowProducerClass: TestFlowProducer,
      QueueEventsClass: InitializingQueueEvents,
    });
    const workflow = Workflow.define({
      name: "shared",
      data: Type.Object({}),
      result: Type.Void(),
    });
    provider.registerEmitterWorkflow(workflow.name);
    await provider.start();

    const firstExecution = provider.execute(workflow, {});
    const secondExecution = provider.execute(workflow, {});
    const executionFailure = Promise.all([
      firstExecution,
      secondExecution,
    ]).then(
      () => new Error("Concurrent executions unexpectedly resolved"),
      (error: Error) => error,
    );

    expect(constructionCount).toBe(1);

    const stopping = provider.stop();
    readyGate.release();

    await expect(stopping).resolves.toBeUndefined();
    expect((await executionFailure).message).toContain(
      "Workflow provider stopped",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("should initiate independent worker closes together when stopping", async () => {
    const workerCloseStarts: string[] = [];
    const closeGate = createCloseGate();
    const firstCloseStarted = createCloseGate();

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
        firstCloseStarted.release();
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
      await firstCloseStarted.wait;
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

  it("should pause worker intake before closing any worker", async () => {
    const lifecycle: string[] = [];
    const pauseGate = createCloseGate();

    class PauseGatedWorker implements IWorker {
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

      public async pause(doNotWaitActive?: boolean): Promise<void> {
        lifecycle.push(`pause:${this.queueName}:${doNotWaitActive}`);
        await pauseGate.wait;
      }

      public async close(force?: boolean): Promise<void> {
        lifecycle.push(`close:${this.queueName}:${force}`);
      }
    }

    const provider = new BullMQWorkflowProvider({
      connection: { host: "localhost", port: 6379 },
      queuePrefix: "pause-before-close",
      defaultTimeout: 0,
      FlowProducerClass: TestFlowProducer,
      WorkerClass: PauseGatedWorker,
    });
    provider.registerDefinitionConsumer(
      "alpha",
      async () => undefined,
      [{ type: "sequential", definitions: [{ name: "step" }] }],
      { step: { execute: async () => undefined } },
    );
    await provider.start();

    const stopping = provider.stop();
    try {
      await Promise.resolve();
      expect(lifecycle).toEqual([
        "pause:pause-before-close.alpha.steps:undefined",
        "pause:pause-before-close.alpha:undefined",
      ]);
    } finally {
      pauseGate.release();
      await stopping;
    }
    expect(lifecycle).toEqual([
      "pause:pause-before-close.alpha.steps:undefined",
      "pause:pause-before-close.alpha:undefined",
      "close:pause-before-close.alpha.steps:true",
      "close:pause-before-close.alpha:true",
    ]);
  });

  it("should drain active jobs through BullMQ finalization before forcing idle connections closed", async () => {
    const lifecycle: string[] = [];
    const handlerStarted = createCloseGate();
    const handlerGate = createCloseGate();
    const finalizationStarted = createCloseGate();
    const finalizationGate = createCloseGate();
    const workers = new Map<string, ActiveJobWorker>();

    class ActiveJobWorker implements IWorker {
      public readonly connection = { _client: new TestRedisClient() };
      public readonly blockingConnection = { _client: new TestRedisClient() };
      private readonly listeners = new Map<
        string,
        Array<(...args: unknown[]) => void>
      >();

      constructor(
        private readonly queueName: string,
        private readonly processor: (job: Job) => Promise<unknown>,
        _options: unknown,
      ) {
        workers.set(queueName, this);
      }

      public on(event: string, handler: (...args: unknown[]) => void): this {
        const listeners = this.listeners.get(event) ?? [];
        listeners.push(handler);
        this.listeners.set(event, listeners);
        return this;
      }

      public async process(job: Job): Promise<void> {
        const result = await this.processor(job);
        lifecycle.push("bullmq:finalizing");
        finalizationStarted.release();
        await finalizationGate.wait;
        for (const listener of this.listeners.get("completed") ?? []) {
          listener(job, result);
        }
        lifecycle.push("bullmq:completed");
      }

      public async pause(doNotWaitActive?: boolean): Promise<void> {
        lifecycle.push(`pause:${this.queueName}:${doNotWaitActive}`);
      }

      public async close(force?: boolean): Promise<void> {
        lifecycle.push(`close:${this.queueName}:${force}`);
      }
    }

    const provider = new BullMQWorkflowProvider({
      connection: { host: "localhost", port: 6379 },
      queuePrefix: "active-drain",
      defaultTimeout: 0,
      FlowProducerClass: TestFlowProducer,
      WorkerClass: ActiveJobWorker,
    });
    provider.registerDefinitionConsumer(
      "alpha",
      async () => {
        lifecycle.push("handler:start");
        handlerStarted.release();
        await handlerGate.wait;
        lifecycle.push("handler:end");
      },
      [],
    );
    await provider.start();

    const worker = workers.get("active-drain.alpha");
    if (!worker) throw new Error("Workflow worker was not captured");
    const processing = worker.process({
      data: { flowId: "active-flow", workflowData: {} },
    } as Job);
    await handlerStarted.wait;

    const stopping = provider.stop();
    await Promise.resolve();
    expect(lifecycle).toEqual([
      "handler:start",
      "pause:active-drain.alpha:undefined",
    ]);

    handlerGate.release();
    await finalizationStarted.wait;
    expect(lifecycle).toEqual([
      "handler:start",
      "pause:active-drain.alpha:undefined",
      "handler:end",
      "bullmq:finalizing",
    ]);

    finalizationGate.release();
    await processing;
    await stopping;
    expect(lifecycle).toEqual([
      "handler:start",
      "pause:active-drain.alpha:undefined",
      "handler:end",
      "bullmq:finalizing",
      "bullmq:completed",
      "close:active-drain.alpha:true",
    ]);
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
