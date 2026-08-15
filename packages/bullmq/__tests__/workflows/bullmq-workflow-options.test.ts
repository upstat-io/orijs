/**
 * Tests for BullMQWorkflowProvider Options Support
 *
 * Verifies the provider options architecture:
 * - Provider-owned policy is shared by emitters and consumers
 * - Worker and job options preserve Ori transport invariants
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Workflow } from "@orijs/core";
import { Type } from "@orijs/validation";
import {
  BullMQWorkflowProvider,
  type BullMQWorkflowOptions,
  type BullMQWorkflowProviderOptions,
} from "../../src/workflows/index.ts";
import type { FlowJobDefinition } from "../../src/workflows/flow-builder.ts";

const HighVolumeWorkflow = Workflow.define({
  name: "high-volume-workflow",
  data: Type.Object({ id: Type.String() }),
  result: Type.Void(),
}).steps((s) => s.sequential(s.step("process", Type.Object({}))));
const SimpleWorkflow = Workflow.define({
  name: "simple-workflow",
  data: Type.Object({ id: Type.String() }),
  result: Type.Void(),
});
const ParallelWorkflow = Workflow.define({
  name: "parallel-workflow",
  data: Type.Object({ id: Type.String() }),
  result: Type.Void(),
});

// Mock factories
type MockFlowProducer = {
  add: Mock<(flow: FlowJobDefinition) => Promise<{ job: { id: string } }>>;
  close: Mock<() => Promise<void>>;
};

type MockWorker = {
  on: Mock<(event: string, handler: () => void) => void>;
  close: Mock<() => Promise<void>>;
  concurrency?: number;
};

type MockQueueEvents = {
  on: Mock<(event: string, handler: () => void) => void>;
  waitUntilReady: Mock<() => Promise<void>>;
  close: Mock<() => Promise<void>>;
};

// Capture worker options from constructor
let capturedWorkerOptions: Record<string, unknown>[] = [];

// Simple step groups for all workflows
const simpleStepGroups = [
  {
    type: "sequential" as const,
    definitions: [{ name: "process" }],
  },
];
const parallelStepGroups = [
  {
    type: "parallel" as const,
    definitions: [{ name: "first" }, { name: "second" }],
  },
];

// Simple step handlers
const createSimpleStepHandlers = () => ({
  process: {
    execute: async () => ({}),
  },
});

describe("BullMQWorkflowProvider Options", () => {
  let mockFlowProducer: MockFlowProducer;
  let mockWorker: MockWorker;
  let mockQueueEvents: MockQueueEvents;
  let provider: BullMQWorkflowProvider;
  let createProvider: (
    workflowOptions?: Readonly<Record<string, BullMQWorkflowOptions>>,
  ) => BullMQWorkflowProvider;

  beforeEach(() => {
    capturedWorkerOptions = [];

    mockFlowProducer = {
      add: mock((_flow: FlowJobDefinition) =>
        Promise.resolve({ job: { id: "flow-123" } }),
      ),
      close: mock(() => Promise.resolve()),
    };

    mockWorker = {
      on: mock(() => {}),
      close: mock(() => Promise.resolve()),
    };

    mockQueueEvents = {
      on: mock(() => {}),
      waitUntilReady: mock(() => Promise.resolve()),
      close: mock(() => Promise.resolve()),
    };

    createProvider = (workflowOptions) =>
      new BullMQWorkflowProvider({
        connection: { host: "localhost", port: 6379 },
        workflowOptions,
        FlowProducerClass: class {
          add = mockFlowProducer.add;
          close = mockFlowProducer.close;
        } as unknown as BullMQWorkflowProviderOptions["FlowProducerClass"],
        WorkerClass: class {
          on = mockWorker.on;
          close = mockWorker.close;
          concurrency: number;
          constructor(
            _queueName: string,
            _processor: unknown,
            opts?: Record<string, unknown>,
          ) {
            this.concurrency =
              typeof opts?.concurrency === "number" ? opts.concurrency : 1;
            capturedWorkerOptions.push({
              ...opts,
              concurrency: this.concurrency,
            });
          }
        } as unknown as BullMQWorkflowProviderOptions["WorkerClass"],
        QueueEventsClass: class {
          on = mockQueueEvents.on;
          waitUntilReady = mockQueueEvents.waitUntilReady;
          close = mockQueueEvents.close;
        } as unknown as BullMQWorkflowProviderOptions["QueueEventsClass"],
      });

    provider = createProvider();
  });

  describe("worker concurrency configuration", () => {
    it("forwards supported worker options while preserving provider-owned lease settings", async () => {
      provider = createProvider({
        "high-volume-workflow": {
          concurrency: 10,
          limiter: { max: 25, duration: 1000 },
        },
      });
      provider.registerDefinitionConsumer(
        "high-volume-workflow",
        async () => {},
        simpleStepGroups,
        createSimpleStepHandlers(),
      );
      await provider.start();

      expect(capturedWorkerOptions).toHaveLength(2);
      for (const workerOptions of capturedWorkerOptions) {
        expect(workerOptions).toEqual(
          expect.objectContaining({
            concurrency: 10,
            limiter: { max: 25, duration: 1000 },
            lockDuration: 5_000,
            stalledInterval: 5_000,
          }),
        );
      }
    });

    it("should default to concurrency 1 when no options provided", async () => {
      provider.registerDefinitionConsumer(
        "default-workflow",
        async () => {},
        simpleStepGroups,
        createSimpleStepHandlers(),
      );
      await provider.start();

      expect(capturedWorkerOptions.length).toBeGreaterThanOrEqual(1);

      // Default concurrency should be 1
      const workflowWorker = capturedWorkerOptions[0]!;
      expect(workflowWorker.concurrency).toBe(1);
    });

    it("should configure different concurrency per workflow", async () => {
      provider = createProvider({
        "high-volume-workflow": { concurrency: 10 },
        "low-priority-workflow": { concurrency: 2 },
      });
      provider.registerDefinitionConsumer(
        "high-volume-workflow",
        async () => {},
        simpleStepGroups,
        createSimpleStepHandlers(),
      );
      provider.registerDefinitionConsumer(
        "low-priority-workflow",
        async () => {},
        simpleStepGroups,
        createSimpleStepHandlers(),
      );
      await provider.start();

      // Should have workers for both workflows
      expect(capturedWorkerOptions.length).toBeGreaterThanOrEqual(2);

      // Find concurrency values (order may vary)
      const concurrencyValues = capturedWorkerOptions.map((o) => o.concurrency);
      expect(concurrencyValues).toContain(10);
      expect(concurrencyValues).toContain(2);
    });
  });

  describe("job option configuration", () => {
    it("applies producer-owned job policy in an emitter-only distributed topology", async () => {
      provider = createProvider({
        "high-volume-workflow": {
          attempts: 4,
          backoff: { type: "fixed", delay: 250 },
          priority: 7,
        },
      });
      provider.registerEmitterWorkflow("high-volume-workflow");
      await provider.start();
      await provider.execute(HighVolumeWorkflow, { id: "distributed-order" });

      const flow = mockFlowProducer.add.mock.calls[0]?.[0];
      if (!flow) throw new Error("FlowProducer.add was not called");
      expect(flow.opts).toEqual(expect.objectContaining({ priority: 7 }));
      expect(flow.children?.[0]?.opts).toEqual(
        expect.objectContaining({
          attempts: 4,
          backoff: { type: "fixed", delay: 250 },
          priority: 7,
        }),
      );
    });

    it("forwards supported job options across job shapes while preserving safety options", async () => {
      provider = createProvider({
        "high-volume-workflow": {
          attempts: 4,
          backoff: { type: "fixed", delay: 250 },
          priority: 7,
        },
        "simple-workflow": { priority: 7 },
        "parallel-workflow": { priority: 7 },
      });
      provider.registerDefinitionConsumer(
        "high-volume-workflow",
        async () => {},
        simpleStepGroups,
        createSimpleStepHandlers(),
      );
      provider.registerDefinitionConsumer(
        "simple-workflow",
        async () => {},
        [],
        {},
      );
      provider.registerDefinitionConsumer(
        "parallel-workflow",
        async () => {},
        parallelStepGroups,
        {
          first: { execute: async () => ({}) },
          second: { execute: async () => ({}) },
        },
      );
      await provider.start();
      await provider.execute(HighVolumeWorkflow, { id: "order-1" });
      await provider.execute(SimpleWorkflow, { id: "order-2" });
      await provider.execute(ParallelWorkflow, { id: "order-3" });

      const flows = mockFlowProducer.add.mock.calls.map(([flow]) => flow);
      const sequentialFlow = flows.find(
        (flow) => flow.name === "high-volume-workflow",
      );
      const simpleFlow = flows.find((flow) => flow.name === "simple-workflow");
      const parallelFlow = flows.find(
        (flow) => flow.name === "parallel-workflow",
      );
      if (!sequentialFlow || !simpleFlow || !parallelFlow) {
        throw new Error("Expected simple, sequential, and parallel flows");
      }
      expect(sequentialFlow.opts).toEqual(
        expect.objectContaining({
          priority: 7,
          removeOnComplete: { age: 604_800, count: 10_000 },
          removeOnFail: { age: 2_592_000, count: 10_000 },
        }),
      );
      expect(sequentialFlow.children?.[0]?.opts).toEqual(
        expect.objectContaining({
          attempts: 4,
          backoff: { type: "fixed", delay: 250 },
          priority: 7,
          failParentOnFailure: true,
          removeOnComplete: { age: 604_800, count: 10_000 },
          removeOnFail: { age: 2_592_000, count: 10_000 },
        }),
      );
      expect(simpleFlow.opts).toEqual(
        expect.objectContaining({
          priority: 7,
          removeOnComplete: { age: 604_800, count: 10_000 },
          removeOnFail: { age: 2_592_000, count: 10_000 },
        }),
      );
      expect(parallelFlow.children?.[0]?.opts).toEqual(
        expect.objectContaining({
          priority: 7,
          failParentOnFailure: true,
          removeOnComplete: { age: 604_800, count: 10_000 },
          removeOnFail: { age: 2_592_000, count: 10_000 },
        }),
      );
    });

    it("applies step retry defaults when no overrides are registered", async () => {
      provider.registerDefinitionConsumer(
        "high-volume-workflow",
        async () => {},
        simpleStepGroups,
        createSimpleStepHandlers(),
      );
      await provider.start();
      await provider.execute(HighVolumeWorkflow, { id: "order-defaults" });

      const flow = mockFlowProducer.add.mock.calls[0]?.[0];
      if (!flow) throw new Error("FlowProducer.add was not called");
      expect(flow.children?.[0]?.opts).toEqual(
        expect.objectContaining({
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
        }),
      );
    });
  });
});
