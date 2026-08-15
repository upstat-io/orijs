import { describe, expect, it, mock } from "bun:test";
import type { EventMessage } from "@orijs/events";
import { BullMQEventProvider } from "../../src/events/bullmq-event-provider.ts";

function createProviderHarness() {
  let workerHandler:
    ((job: { data: EventMessage }) => Promise<unknown>) | undefined;
  const addJob = mock((_eventName: string, _data: EventMessage) =>
    Promise.resolve({ id: "job-1" }),
  );
  const queueManager = {
    getQueueName: (eventName: string) => `event.${eventName}`,
    addJob,
    registerWorker: mock(
      (
        _eventName: string,
        handler: (job: { data: EventMessage }) => Promise<unknown>,
      ) => {
        workerHandler = handler;
        return Promise.resolve();
      },
    ),
    stop: () => Promise.resolve(),
  };
  const completionTracker = {
    register: () => {},
    mapJobId: () => {},
    completeJob: () => {},
    stop: () => Promise.resolve(),
  };
  const scheduledEventManager = {
    schedule: () => Promise.resolve(),
    unschedule: () => Promise.resolve(),
    getSchedules: () => [],
    stop: () => Promise.resolve(),
  };
  const provider = new BullMQEventProvider({
    connection: { host: "localhost", port: 6379 },
    queueManager: queueManager as any,
    completionTracker: completionTracker as any,
    scheduledEventManager: scheduledEventManager as any,
  });

  return {
    provider,
    addJob,
    getWorkerHandler: () => {
      if (!workerHandler) {
        throw new Error("worker handler was not registered");
      }
      return workerHandler;
    },
  };
}

describe("BullMQ event message optional shape", () => {
  it("omits causationId when an event has no causation identifier", async () => {
    const harness = createProviderHarness();
    await harness.provider
      .emit("shape.absent", {}, {}, { expectsResult: false })
      .toPromise();

    const emittedMessage = harness.addJob.mock.calls[0]?.[1];
    expect(emittedMessage).toBeDefined();
    expect(Object.hasOwn(emittedMessage!, "causationId")).toBeFalse();

    let receivedMessage: EventMessage | undefined;
    await harness.provider.subscribe("shape.absent", async (message) => {
      receivedMessage = message;
    });
    await harness.getWorkerHandler()({
      data: emittedMessage!,
    });

    expect(receivedMessage).toBeDefined();
    expect(Object.hasOwn(receivedMessage!, "causationId")).toBeFalse();
  });

  it("preserves causationId when an event supplies one", async () => {
    const harness = createProviderHarness();
    await harness.provider
      .emit(
        "shape.present",
        {},
        {},
        { expectsResult: false, causationId: "cause-1" },
      )
      .toPromise();

    const emittedMessage = harness.addJob.mock.calls[0]?.[1];
    expect(emittedMessage?.causationId).toBe("cause-1");

    let receivedMessage: EventMessage | undefined;
    await harness.provider.subscribe("shape.present", async (message) => {
      receivedMessage = message;
    });
    await harness.getWorkerHandler()({
      data: emittedMessage!,
    });

    expect(receivedMessage?.causationId).toBe("cause-1");
  });
});
