# Chapter 12: Workflows

[Previous: Events ←](./11-events.md) | [Next: WebSockets →](./13-websockets.md)

---

Events handle fire-and-forget work. But some processes aren't fire-and-forget -- they're multi-step operations where each step depends on the previous one, failures need to undo completed work, and the caller needs to know when everything is done.

Provisioning a new account. Processing an order. Onboarding a monitor. These are **workflows**: coordinated sequences of steps with error handling, rollback, and result aggregation. OriJS provides a workflow system built on the same provider pattern as events. **BullMQ FlowProducer is the default workflow provider**, giving you distributed, persistent, multi-step execution with automatic dependency management. And like events, you can swap the provider.

## Events vs. Workflows

| Aspect | Events | Workflows |
|---|---|---|
| **Pattern** | Fire-and-forget | Coordinated multi-step |
| **Caller awareness** | Doesn't wait for result | Tracks status, gets result |
| **Steps** | Single handler | Multiple ordered steps |
| **Dependencies** | None between handlers | Steps depend on previous results |
| **Failure handling** | Retry individual handler | Rollback completed steps (Saga) |
| **Use case** | "Something happened, react" | "Do these things in order" |
| **Default provider** | BullMQ Queue + Worker | BullMQ FlowProducer |
| **Example** | Send welcome email | Process an order (validate -> charge -> fulfill -> notify) |

### When to Use Which

Use **events** when:
- The work is independent -- no step ordering
- The caller doesn't need the result
- Failure of one handler shouldn't affect others
- You want maximum decoupling

Use **workflows** when:
- Steps must execute in a specific order
- Later steps depend on earlier step results
- Failure requires undoing completed work (compensation)
- The caller needs to track progress and get a final result
- The process spans multiple services or external APIs

## Workflow.define() -- Type-Safe Workflow Definitions

Workflows are defined with `Workflow.define()` from `@orijs/core`, using TypeBox schemas for input data and result:

```typescript
import { Workflow } from '@orijs/core';
import { Type } from '@orijs/validation';

// Simple workflow -- no steps (handler does all the work)
const SendEmail = Workflow.define({
  name: 'send-email',
  data: Type.Object({
    to: Type.String(),
    subject: Type.String(),
    body: Type.String(),
  }),
  result: Type.Object({
    messageId: Type.String(),
    sentAt: Type.String(),
  }),
});
```

For workflows with steps, chain `.steps()` to define the step structure:

```typescript
const ProcessOrder = Workflow.define({
  name: 'process-order',
  data: Type.Object({
    orderId: Type.String(),
    customerId: Type.String(),
    items: Type.Array(Type.Object({
      productId: Type.String(),
      quantity: Type.Number(),
    })),
    totalAmount: Type.Number(),
  }),
  result: Type.Object({
    processedAt: Type.Number(),
    chargeId: Type.String(),
    trackingNumber: Type.String(),
  }),
}).steps(s => s
  .sequential(s.step('validate', Type.Object({
    valid: Type.Boolean(),
    inventory: Type.Array(Type.Object({
      productId: Type.String(),
      available: Type.Number(),
    })),
  })))
  .sequential(s.step('charge', Type.Object({
    chargeId: Type.String(),
    receiptUrl: Type.String(),
  })))
  .sequential(s.step('fulfill', Type.Object({
    trackingNumber: Type.String(),
    estimatedDelivery: Type.String(),
  })))
  .sequential(s.step('notify', Type.Object({
    emailSent: Type.Boolean(),
    smsSent: Type.Boolean(),
  })))
);
```

### Why Steps Are in the Definition, Not the Consumer

This is a deliberate architectural choice. The step **structure** (names, order, parallelism) lives in the definition because:

1. **The emitter needs to know the structure.** When using BullMQ FlowProducer, the emitter creates a flow with child jobs for each step. Without knowing the step structure, it can't create the right job tree.

2. **Distributed deployment.** In a multi-instance deployment, Instance A might emit the workflow while Instance B processes the steps. The definition is shared code that both instances import. The consumer (with step handlers) only needs to exist on the instance that processes.

3. **Separation of concerns.** The definition says **what** needs to happen. The consumer says **how** to do it.

### Step Builder API

The step builder provides two methods:

```typescript
.steps(s => s
  // Sequential step -- executes alone, in order
  .sequential(s.step('validate', outputSchema))

  // Parallel steps -- execute concurrently, all must complete before next group
  .parallel(
    s.step('sendEmail', emailOutputSchema),
    s.step('sendSms', smsOutputSchema),
  )

  // Another sequential step -- waits for parallel group to complete
  .sequential(s.step('finalize', finalizeOutputSchema))
)
```

Steps within a `.sequential()` call execute one at a time, in order. Steps within a `.parallel()` call execute concurrently. Parallel groups must complete before subsequent sequential steps begin.

## Implementing Workflow Consumers

Workflow consumers provide the step handlers and completion callback:

```typescript
import type { IWorkflowConsumer, WorkflowContext, StepContext, Data, Result } from '@orijs/core';

type OrderData = Data<typeof ProcessOrder>;
type OrderResult = Result<typeof ProcessOrder>;
type OrderSteps = typeof ProcessOrder['_steps'];

class ProcessOrderWorkflow implements IWorkflowConsumer<OrderData, OrderResult, OrderSteps> {

  constructor(
    private inventoryService: InventoryService,
    private paymentService: PaymentService,
    private fulfillmentService: FulfillmentService,
    private notificationService: NotificationService,
  ) {}

  // Step handlers -- keyed by step name
  steps = {
    validate: {
      execute: async (ctx: StepContext<OrderData, OrderSteps>) => {
        const { items } = ctx.data;
        ctx.log.info('Validating order', { itemCount: items.length });

        const inventory = await this.inventoryService.checkAvailability(items);
        const allAvailable = inventory.every(i => i.available >= items.find(
          item => item.productId === i.productId
        )!.quantity);

        if (!allAvailable) {
          throw new Error('Insufficient inventory for one or more items');
        }

        return { valid: true, inventory };
      },
      // No rollback needed -- validation doesn't change state
    },

    charge: {
      execute: async (ctx: StepContext<OrderData, OrderSteps>) => {
        const { customerId, totalAmount } = ctx.data;
        ctx.log.info('Charging customer', { customerId, amount: totalAmount });

        const charge = await this.paymentService.charge({
          customerId,
          amount: totalAmount,
          idempotencyKey: `order-${ctx.data.orderId}-charge`,
        });

        return { chargeId: charge.id, receiptUrl: charge.receiptUrl };
      },
      rollback: async (ctx: StepContext<OrderData, OrderSteps>) => {
        // Access the typed result from the charge step
        const chargeResult = ctx.results.charge;
        ctx.log.info('Refunding charge', { chargeId: chargeResult.chargeId });

        // Refund API must be idempotent!
        await this.paymentService.refund(chargeResult.chargeId);
      },
    },

    fulfill: {
      execute: async (ctx: StepContext<OrderData, OrderSteps>) => {
        const { orderId, items } = ctx.data;
        ctx.log.info('Fulfilling order', { orderId });

        const shipment = await this.fulfillmentService.createShipment({
          orderId,
          items,
        });

        return {
          trackingNumber: shipment.trackingNumber,
          estimatedDelivery: shipment.estimatedDelivery,
        };
      },
      rollback: async (ctx: StepContext<OrderData, OrderSteps>) => {
        const fulfillResult = ctx.results.fulfill;
        ctx.log.info('Cancelling shipment', { tracking: fulfillResult.trackingNumber });

        await this.fulfillmentService.cancelShipment(fulfillResult.trackingNumber);
      },
    },

    notify: {
      execute: async (ctx: StepContext<OrderData, OrderSteps>) => {
        const { customerId } = ctx.data;
        const fulfillResult = ctx.results.fulfill;

        ctx.log.info('Sending notifications', { customerId });

        const [emailSent, smsSent] = await Promise.all([
          this.notificationService.sendOrderConfirmation(customerId, fulfillResult.trackingNumber),
          this.notificationService.sendSms(customerId, `Your order shipped! Tracking: ${fulfillResult.trackingNumber}`),
        ]);

        return { emailSent, smsSent };
      },
      // No rollback -- notifications can't be unsent
    },
  };

  // Called after ALL steps complete successfully
  onComplete = async (ctx: WorkflowContext<OrderData, OrderSteps>): Promise<OrderResult> => {
    const chargeResult = ctx.results.charge;
    const fulfillResult = ctx.results.fulfill;

    ctx.log.info('Order processing complete', {
      orderId: ctx.data.orderId,
      chargeId: chargeResult.chargeId,
      tracking: fulfillResult.trackingNumber,
    });

    return {
      processedAt: Date.now(),
      chargeId: chargeResult.chargeId,
      trackingNumber: fulfillResult.trackingNumber,
    };
  };

  // Called when any step fails (after rollbacks execute)
  onError = async (ctx: WorkflowContext<OrderData, OrderSteps>, error: Error) => {
    ctx.log.error('Order processing failed', {
      orderId: ctx.data.orderId,
      error: error.message,
    });

    // Notify the customer about the failure
    await this.notificationService.sendOrderFailed(ctx.data.customerId, ctx.data.orderId);
  };
}
```

### StepContext and WorkflowContext

Step handlers receive a `StepContext<TData, TSteps>`:

| Property | Type | Description |
|---|---|---|
| `flowId` | `string` | Unique workflow execution ID |
| `data` | `TData` | The workflow input data |
| `results` | `TSteps` | Accumulated results from completed steps (typed per step definitions) |
| `log` | `Logger` | Logger with workflow context (flowId, step name, correlationId) |
| `meta` | `Record<string, unknown>` | Metadata for distributed tracing |
| `stepName` | `string` | Current step name being executed |
| `providerId` | `string?` | Which provider instance is executing (for distributed tracing) |

The `onComplete` and `onError` callbacks receive `WorkflowContext<TData, TSteps>`, which has the same properties as `StepContext` except it replaces `stepName` with `correlationId` (a string linking to the originating request).

The `results` property accumulates as steps complete. When `charge` executes, `results` contains `{ validate: { valid: true, inventory: [...] } }`. When `fulfill` executes, `results` contains both `validate` and `charge` results.

## Registering and Executing Workflows

### Registration

```typescript
const app = Ori.create()
  .workflow(ProcessOrder).consumer(ProcessOrderWorkflow, [
    InventoryService,
    PaymentService,
    FulfillmentService,
    NotificationService,
  ])
  .listen(8001);
```

### Execution

Workflows are executed from controllers or event handlers:

```typescript
class OrderController {
  configure(r: RouteBuilder) {
    r.post('/orders', this.placeOrder);
  }

  private placeOrder = async (ctx: RequestContext) => {
    const orderData = ctx.body<CreateOrderInput>();

    // Execute workflow -- returns a FlowHandle
    const handle = await ctx.workflows.execute(ProcessOrder, {
      orderId: crypto.randomUUID(),
      customerId: orderData.customerId,
      items: orderData.items,
      totalAmount: orderData.totalAmount,
    });

    // Option 1: Return immediately with the flow ID (for async processing)
    return ctx.json({ orderId: orderData.orderId, flowId: handle.id }, 202);

    // Option 2: Wait for completion (for synchronous flows)
    // const result = await handle.result();
    // return ctx.json(result, 200);
  };
}
```

### FlowHandle

The `FlowHandle` returned by `execute()` provides status tracking and result retrieval:

```typescript
interface FlowHandle<TResult> {
  /** Unique flow ID */
  readonly id: string;

  /** Get current status */
  status(): Promise<FlowStatus>;  // 'pending' | 'running' | 'completed' | 'failed'

  /** Wait for completion and get result */
  result(): Promise<TResult>;
}
```

For long-running workflows, you typically return the `id` to the client and provide a status endpoint:

```typescript
class OrderController {
  configure(r: RouteBuilder) {
    r.post('/orders', this.placeOrder);
    r.get('/orders/:orderId/status', this.getOrderStatus);
  }

  private getOrderStatus = async (ctx: RequestContext) => {
    const { orderId } = ctx.params;
    const status = await ctx.workflows.getStatus(orderId);
    return ctx.json({ orderId, status });
  };
}
```

## Sequential vs. Parallel Execution

### Sequential Steps

Each step waits for the previous step to complete:

```
validate -> charge -> fulfill -> notify -> onComplete
```

If `charge` fails, `validate` is already complete, so its rollback runs (if defined). `fulfill` and `notify` never execute.

### Parallel Steps

Steps in a parallel group execute concurrently:

```typescript
.steps(s => s
  .sequential(s.step('validate', validateSchema))
  .sequential(s.step('charge', chargeSchema))
  .parallel(
    s.step('sendEmail', emailSchema),
    s.step('sendSms', smsSchema),
    s.step('updateCrm', crmSchema),
  )
  .sequential(s.step('finalize', finalizeSchema))
)
```

Execution order:

```
validate -> charge -> [sendEmail, sendSms, updateCrm] -> finalize -> onComplete
                          (all three run concurrently)
```

All three parallel steps must complete before `finalize` begins. If any parallel step fails, rollbacks run for all completed steps (including the other parallel steps that succeeded).

## Compensation and Rollback (Saga Pattern)

The workflow system implements the **Saga pattern** for distributed transactions. Instead of database transactions that span multiple services, Sagas use compensation: if step N fails, undo steps N-1, N-2, ... 1 in reverse order.

### Rollback Order

Rollbacks execute in **reverse completion order**:

```
Steps: validate -> charge -> fulfill -> notify
                              ^
                              |  FAILURE

Rollbacks:                  fulfill.rollback -> charge.rollback
                            (reverse order)
```

`validate` has no rollback (validation is read-only), so it's skipped. `charge.rollback` refunds the payment. `fulfill.rollback` cancels the shipment.

### Rollback Requirements

**Rollbacks must be idempotent.** In distributed systems with retries, a rollback handler may execute multiple times for the same workflow:

```typescript
// GOOD: Idempotent -- refunding the same chargeId twice is safe
rollback: async (ctx) => {
  const { chargeId } = ctx.results.charge;
  await paymentService.refund(chargeId);  // Stripe refund API is idempotent by chargeId
}

// BAD: Not idempotent -- creates a new refund each time
rollback: async (ctx) => {
  await paymentService.createRefund(ctx.data.totalAmount);  // Duplicate refund!
}
```

### Parallel Step Rollbacks

When a parallel step fails, rollbacks run for:

1. All completed parallel steps in the same group (the ones that succeeded)
2. All previously completed sequential steps (in reverse order)

```
validate -> charge -> [sendEmail(ok), sendSms(FAIL), updateCrm(ok)]

Rollbacks: updateCrm.rollback -> sendEmail.rollback -> charge.rollback
```

## BullMQ FlowProducer Under the Hood

The default workflow provider uses BullMQ's FlowProducer, which creates job trees with parent-child dependencies:

```
                    [process-order (parent)]
                            |
                    waits for children
                            |
        +-----------+-------+-------+-----------+
        |           |               |           |
   [validate]  [charge]        [fulfill]   [notify]
    (child 1)  (child 2)      (child 3)   (child 4)
```

BullMQ guarantees that children execute before their parent. The provider uses this to enforce step ordering:

- Sequential steps are chained as a dependency tree (step 2 is a child of step 1)
- Parallel steps are siblings with a shared parent
- The workflow parent job runs last, after all step children complete

### Per-Workflow Queues

Like events, each workflow gets its own queue:

```
Queue: workflow.process-order        -> Parent job worker
Queue: workflow.process-order.steps  -> Step job worker
```

This provides isolation between workflow types. A slow `generate-report` workflow doesn't block `process-order` steps.

### Distributed Execution

In a multi-instance deployment, workflows are truly distributed:

```
Instance A: Starts workflow (creates flow in Redis)
Instance B: Picks up and executes validate step
Instance C: Picks up and executes charge step
Instance B: Picks up and executes fulfill step
Instance A: Receives completion notification via QueueEvents
```

No instance holds the full workflow state. All state lives in Redis via BullMQ. Any instance can execute any step. If Instance B crashes mid-step, BullMQ's stall detection reassigns the job to another instance.

### Configuration

```typescript
import { BullMQWorkflowProvider } from '@orijs/bullmq';

const workflowProvider = new BullMQWorkflowProvider({
  connection: {
    host: config.secrets.SECRET_REDIS_HOST,
    port: 6379,
  },
  defaultTimeout: 60000,       // 60 second timeout per workflow
  stallInterval: 5000,          // 5 second stall detection (for I/O-bound workflows)
  stepTimeout: 30000,           // 30 second timeout per individual step
  providerId: 'instance-1',    // For distributed tracing
});

// Per-workflow options
app.workflow(ProcessOrder).consumer(ProcessOrderWorkflow, deps, {
  concurrency: 5,              // Process 5 order workflows in parallel
  attempts: 3,                 // Retry failed steps up to 3 times
  backoff: { type: 'exponential', delay: 1000 }, // Exponential retry backoff
});
```

## Real-World Example: Monitor Setup Workflow

Here's a complete example of a workflow that sets up a new monitor in a monitoring application:

```typescript
import { Workflow } from '@orijs/core';
import type { IWorkflowConsumer, WorkflowContext, StepContext, Data, Result } from '@orijs/core';
import { Type } from '@orijs/validation';

// Define the workflow with steps
const SetupMonitor = Workflow.define({
  name: 'setup-monitor',
  data: Type.Object({
    accountUuid: Type.String(),
    projectUuid: Type.String(),
    name: Type.String(),
    url: Type.String(),
    interval: Type.Number(),
    regions: Type.Array(Type.String()),
  }),
  result: Type.Object({
    monitorUuid: Type.String(),
    firstCheckAt: Type.Number(),
  }),
}).steps(s => s
  // Step 1: Validate the URL is reachable
  .sequential(s.step('validateUrl', Type.Object({
    reachable: Type.Boolean(),
    responseTime: Type.Number(),
    statusCode: Type.Number(),
  })))
  // Step 2: Create the monitor record in the database
  .sequential(s.step('createRecord', Type.Object({
    monitorUuid: Type.String(),
  })))
  // Step 3: Set up check schedules in all regions (parallel)
  .sequential(s.step('scheduleChecks', Type.Object({
    scheduledRegions: Type.Array(Type.String()),
    nextCheckAt: Type.Number(),
  })))
  // Step 4: Run the first check immediately
  .sequential(s.step('firstCheck', Type.Object({
    status: Type.String(),
    responseTime: Type.Number(),
  })))
);

// Type aliases for readability
type MonitorData = Data<typeof SetupMonitor>;
type MonitorResult = Result<typeof SetupMonitor>;
type MonitorSteps = typeof SetupMonitor['_steps'];

// Implement the consumer
class SetupMonitorWorkflow implements IWorkflowConsumer<MonitorData, MonitorResult, MonitorSteps> {
  constructor(
    private httpClient: HttpClient,
    private monitorRepository: MonitorRepository,
    private schedulerService: SchedulerService,
    private checkService: CheckService,
  ) {}

  steps = {
    validateUrl: {
      execute: async (ctx: StepContext<MonitorData, MonitorSteps>) => {
        ctx.log.info('Validating URL', { url: ctx.data.url });

        const response = await this.httpClient.get(ctx.data.url, { timeout: 10000 });

        if (response.status >= 500) {
          throw new Error(`URL returned ${response.status}: server error`);
        }

        return {
          reachable: true,
          responseTime: response.duration,
          statusCode: response.status,
        };
      },
    },

    createRecord: {
      execute: async (ctx: StepContext<MonitorData, MonitorSteps>) => {
        ctx.log.info('Creating monitor record');

        const monitor = await this.monitorRepository.create({
          accountUuid: ctx.data.accountUuid,
          projectUuid: ctx.data.projectUuid,
          name: ctx.data.name,
          url: ctx.data.url,
          interval: ctx.data.interval,
        });

        return { monitorUuid: monitor.uuid };
      },
      rollback: async (ctx: StepContext<MonitorData, MonitorSteps>) => {
        const { monitorUuid } = ctx.results.createRecord;
        ctx.log.info('Rolling back: deleting monitor record', { monitorUuid });
        await this.monitorRepository.delete(monitorUuid);
      },
    },

    scheduleChecks: {
      execute: async (ctx: StepContext<MonitorData, MonitorSteps>) => {
        const { monitorUuid } = ctx.results.createRecord;
        ctx.log.info('Scheduling checks', { regions: ctx.data.regions });

        const scheduled = await this.schedulerService.scheduleMonitor({
          monitorUuid,
          interval: ctx.data.interval,
          regions: ctx.data.regions,
        });

        return {
          scheduledRegions: scheduled.regions,
          nextCheckAt: scheduled.nextCheckAt,
        };
      },
      rollback: async (ctx: StepContext<MonitorData, MonitorSteps>) => {
        const { monitorUuid } = ctx.results.createRecord;
        ctx.log.info('Rolling back: removing check schedules', { monitorUuid });
        await this.schedulerService.unscheduleMonitor(monitorUuid);
      },
    },

    firstCheck: {
      execute: async (ctx: StepContext<MonitorData, MonitorSteps>) => {
        const { monitorUuid } = ctx.results.createRecord;
        ctx.log.info('Running first check', { monitorUuid });

        const result = await this.checkService.runCheck(monitorUuid);

        return {
          status: result.status,
          responseTime: result.responseTime,
        };
      },
      // No rollback -- the check result is informational
    },
  };

  onComplete = async (ctx: WorkflowContext<MonitorData, MonitorSteps>) => {
    const { monitorUuid } = ctx.results.createRecord;
    const { status, responseTime } = ctx.results.firstCheck;

    ctx.log.info('Monitor setup complete', {
      monitorUuid,
      initialStatus: status,
      initialResponseTime: responseTime,
    });

    return {
      monitorUuid,
      firstCheckAt: Date.now(),
    };
  };

  onError = async (ctx: WorkflowContext<MonitorData, MonitorSteps>, error: Error) => {
    ctx.log.error('Monitor setup failed', {
      url: ctx.data.url,
      error: error.message,
    });
  };
}
```

## Testing Workflows

### Unit Testing Steps

Test each step handler in isolation:

```typescript
import { describe, test, expect, mock } from 'bun:test';

describe('SetupMonitorWorkflow', () => {
  describe('validateUrl step', () => {
    test('should validate reachable URL', async () => {
      const mockHttp = {
        get: mock(() => Promise.resolve({ status: 200, duration: 150 })),
      };

      const workflow = new SetupMonitorWorkflow(
        mockHttp as HttpClient,
        {} as MonitorRepository,
        {} as SchedulerService,
        {} as CheckService,
      );

      const ctx = createMockStepContext({
        data: { url: 'https://example.com', regions: ['us-east-1'] },
        results: {},
      });

      const result = await workflow.steps.validateUrl.execute(ctx);

      expect(result).toEqual({
        reachable: true,
        responseTime: 150,
        statusCode: 200,
      });
    });

    test('should reject server errors', async () => {
      const mockHttp = {
        get: mock(() => Promise.resolve({ status: 503, duration: 0 })),
      };

      const workflow = new SetupMonitorWorkflow(
        mockHttp as HttpClient,
        {} as MonitorRepository,
        {} as SchedulerService,
        {} as CheckService,
      );

      const ctx = createMockStepContext({
        data: { url: 'https://broken.com', regions: [] },
        results: {},
      });

      await expect(workflow.steps.validateUrl.execute(ctx)).rejects.toThrow('server error');
    });
  });

  describe('createRecord step', () => {
    test('should create monitor and return UUID', async () => {
      const mockRepo = {
        create: mock(() => Promise.resolve({ uuid: 'mon-123' })),
      };

      const workflow = new SetupMonitorWorkflow(
        {} as HttpClient,
        mockRepo as MonitorRepository,
        {} as SchedulerService,
        {} as CheckService,
      );

      const ctx = createMockStepContext({
        data: {
          accountUuid: 'acc-1',
          projectUuid: 'proj-1',
          name: 'My Monitor',
          url: 'https://example.com',
          interval: 60,
        },
        results: {
          validateUrl: { reachable: true, responseTime: 150, statusCode: 200 },
        },
      });

      const result = await workflow.steps.createRecord.execute(ctx);
      expect(result).toEqual({ monitorUuid: 'mon-123' });
    });

    test('rollback should delete the created monitor', async () => {
      const mockRepo = {
        delete: mock(() => Promise.resolve()),
      };

      const workflow = new SetupMonitorWorkflow(
        {} as HttpClient,
        mockRepo as MonitorRepository,
        {} as SchedulerService,
        {} as CheckService,
      );

      const ctx = createMockStepContext({
        data: {},
        results: {
          createRecord: { monitorUuid: 'mon-123' },
        },
      });

      await workflow.steps.createRecord.rollback!(ctx);
      expect(mockRepo.delete).toHaveBeenCalledWith('mon-123');
    });
  });
});
```

### Integration Testing with InProcessWorkflowProvider

For tests that verify the full workflow flow:

```typescript
import { InProcessWorkflowProvider } from '@orijs/workflows';

test('should execute complete setup workflow', async () => {
  const provider = new InProcessWorkflowProvider();

  // Register the workflow
  provider.registerDefinitionConsumer(
    SetupMonitor.name,
    async (data, meta, stepResults) => {
      // onComplete callback
      return {
        monitorUuid: stepResults!.createRecord.monitorUuid,
        firstCheckAt: Date.now(),
      };
    },
    SetupMonitor.stepGroups,
    {
      validateUrl: { execute: async () => ({ reachable: true, responseTime: 100, statusCode: 200 }) },
      createRecord: { execute: async () => ({ monitorUuid: 'mon-test' }) },
      scheduleChecks: { execute: async () => ({ scheduledRegions: ['us-east-1'], nextCheckAt: Date.now() }) },
      firstCheck: { execute: async () => ({ status: 'up', responseTime: 95 }) },
    },
  );

  await provider.start();

  const handle = await provider.execute(SetupMonitor, {
    accountUuid: 'acc-1',
    projectUuid: 'proj-1',
    name: 'Test Monitor',
    url: 'https://example.com',
    interval: 60,
    regions: ['us-east-1'],
  });

  const result = await handle.result();
  expect(result.monitorUuid).toBe('mon-test');

  const status = await handle.status();
  expect(status).toBe('completed');

  await provider.stop();
});
```

The `InProcessWorkflowProvider` executes everything in the same process synchronously, making tests fast and deterministic. For E2E tests that verify distributed behavior, use the real `BullMQWorkflowProvider` with a test Redis instance.

## Writing a Custom Workflow Provider

The `WorkflowProvider` interface extends two focused interfaces:

```typescript
// What services see (execute + getStatus)
interface WorkflowExecutor {
  execute<TData, TResult>(
    workflow: WorkflowDefinitionLike<TData, TResult>,
    data: TData,
  ): Promise<FlowHandle<TResult>>;

  getStatus(flowId: string): Promise<FlowStatus>;
}

// What the framework manages (registration + lifecycle)
interface WorkflowLifecycle {
  registerDefinitionConsumer?(
    workflowName: string,
    handler: (data: unknown, meta?: unknown, stepResults?: Record<string, unknown>) => Promise<unknown>,
    stepGroups?: readonly StepGroup[],
    stepHandlers?: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>,
    onError?: (data: unknown, meta?: unknown, error?: Error, stepResults?: Record<string, unknown>) => Promise<void>,
    options?: unknown,
  ): void;

  start(): Promise<void>;
  stop(): Promise<void>;
}

// Full provider (combines both)
interface WorkflowProvider extends WorkflowExecutor, WorkflowLifecycle {}
```

To write a custom provider -- say, one backed by a PostgreSQL advisory lock and a simple job table instead of Redis -- you implement this interface. Your business code (step handlers, consumers, workflow definitions) stays unchanged.

### Provider Responsibilities

A workflow provider must:

1. **Register workflow consumers** with their step handlers and completion callbacks
2. **Execute workflows** by creating the appropriate jobs/tasks for each step
3. **Enforce step ordering** (sequential steps in order, parallel steps concurrently)
4. **Accumulate step results** so later steps can access earlier results
5. **Handle failures** by running rollbacks in reverse order and calling onError
6. **Track status** (pending -> running -> completed/failed)
7. **Return results** to the caller via FlowHandle
8. **Manage lifecycle** (start/stop, resource cleanup)

## Summary

OriJS workflows provide coordinated multi-step processing with Saga-pattern compensation:

- **Workflow.define()** creates type-safe workflow definitions with TypeBox schemas and step structure
- **IWorkflowConsumer** separates step handlers from step structure, enabling distributed execution
- **StepContext** and **WorkflowContext** carry input data, typed step results, and distributed tracing metadata
- **FlowHandle** provides async status tracking and result retrieval
- **Sequential and parallel** step groups with automatic dependency enforcement
- **Rollback handlers** execute in reverse order when steps fail (Saga pattern)
- **BullMQ FlowProducer** is the default provider for production-grade distributed execution
- **WorkflowProvider interface** lets you swap BullMQ for any orchestration engine

Like events, the workflow system is built on the provider pattern. The definitions and consumers are portable. The provider handles the execution mechanics -- whether that's BullMQ FlowProducer creating Redis job trees, an in-process provider for testing, or a custom PostgreSQL-based executor for your specific needs.

---

[Previous: Events ←](./11-events.md) | [Next: WebSockets →](./13-websockets.md)
