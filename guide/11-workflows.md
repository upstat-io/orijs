# Chapter 11: Workflows

While events handle fire-and-forget processing, some operations require coordinated multi-step execution with rollback capabilities. OriJS's workflow system implements the **Saga pattern** for orchestrating these complex processes.

## Events vs Workflows

Before diving into workflows, it's important to understand when to use each:

| Use Events when... | Use Workflows when... |
|---------------------|----------------------|
| Producer doesn't need the result | You need to track overall progress |
| Steps are independent | Steps must execute in a specific order |
| Failure of one step shouldn't affect others | Failure of one step should trigger rollback |
| No coordination needed | Need to wait for all steps to complete |
| Example: Send welcome email | Example: Process payment + create order + reserve inventory |

Events are simpler and more resilient. Workflows add coordination at the cost of complexity. Use workflows only when you genuinely need multi-step orchestration.

## Defining Workflows

Workflows are defined using a fluent builder API:

```typescript
import { Workflow } from '@orijs/workflows';
import { Type } from '@orijs/validation';

const ProcessOrderWorkflow = Workflow.define({
  name: 'order.process',
  input: Type.Object({
    orderId: Type.String({ format: 'uuid' }),
    customerId: Type.String({ format: 'uuid' }),
    amount: Type.Number({ minimum: 0 }),
    items: Type.Array(Type.Object({
      productId: Type.String(),
      quantity: Type.Integer({ minimum: 1 }),
    })),
  }),
})
  .step('validateOrder', {
    schema: Type.Object({
      isValid: Type.Boolean(),
      validatedAt: Type.String({ format: 'date-time' }),
    }),
  })
  .step('reserveInventory', {
    schema: Type.Object({
      reservationId: Type.String(),
      reservedItems: Type.Array(Type.Object({
        productId: Type.String(),
        quantity: Type.Integer(),
      })),
    }),
  })
  .step('chargePayment', {
    schema: Type.Object({
      paymentId: Type.String(),
      chargedAmount: Type.Number(),
      chargedAt: Type.String({ format: 'date-time' }),
    }),
  })
  .step('createShipment', {
    schema: Type.Object({
      shipmentId: Type.String(),
      estimatedDelivery: Type.String({ format: 'date-time' }),
    }),
  })
  .build();
```

Each `.step()` defines a step in the workflow with:
- A **name** that identifies the step
- A **schema** defining the output data produced by that step

The workflow definition, like event definitions, is a **type carrier** — it carries the TypeScript types for the input and each step's output.

## Implementing Steps

Step implementations are consumers that handle individual workflow steps:

```typescript
import type { WorkflowStepConsumer, WorkflowContext } from '@orijs/workflows';

class ValidateOrderStep implements WorkflowStepConsumer<typeof ProcessOrderWorkflow, 'validateOrder'> {
  workflow = ProcessOrderWorkflow;
  step = 'validateOrder';

  constructor(private orderService: OrderService) {}

  async handle(ctx: WorkflowContext<typeof ProcessOrderWorkflow, 'validateOrder'>) {
    const { orderId, items } = ctx.input;

    ctx.log.info('Validating order', { orderId });

    const isValid = await this.orderService.validate(orderId, items);
    if (!isValid) {
      throw new Error(`Order validation failed: ${orderId}`);
    }

    // Return the step's output (must match the step schema)
    return {
      isValid: true,
      validatedAt: new Date().toISOString(),
    };
  }
}

class ReserveInventoryStep implements WorkflowStepConsumer<typeof ProcessOrderWorkflow, 'reserveInventory'> {
  workflow = ProcessOrderWorkflow;
  step = 'reserveInventory';

  constructor(private inventoryService: InventoryService) {}

  async handle(ctx: WorkflowContext<typeof ProcessOrderWorkflow, 'reserveInventory'>) {
    const { items } = ctx.input;

    const reservation = await this.inventoryService.reserve(items);
    return {
      reservationId: reservation.id,
      reservedItems: reservation.items,
    };
  }
}

class ChargePaymentStep implements WorkflowStepConsumer<typeof ProcessOrderWorkflow, 'chargePayment'> {
  workflow = ProcessOrderWorkflow;
  step = 'chargePayment';

  constructor(private paymentService: PaymentService) {}

  async handle(ctx: WorkflowContext<typeof ProcessOrderWorkflow, 'chargePayment'>) {
    const { customerId, amount } = ctx.input;

    const payment = await this.paymentService.charge(customerId, amount);
    return {
      paymentId: payment.id,
      chargedAmount: payment.amount,
      chargedAt: new Date().toISOString(),
    };
  }
}
```

### What's in WorkflowContext?

| Property | Description |
|----------|-------------|
| `ctx.input` | The workflow's input data (typed from the definition) |
| `ctx.log` | Structured logger with workflow context |
| `ctx.traceId` | Trace ID linking all steps |
| `ctx.stepResults` | Results from previous steps (if sequential) |

## Registering Workflows

```typescript
import { createBullMQWorkflowProvider } from '@orijs/bullmq';

const workflowProvider = createBullMQWorkflowProvider({
  connection: { host: 'localhost', port: 6379 },
});

Ori.create()
  .workflows({ provider: workflowProvider })
  .workflowConsumer(ValidateOrderStep, [OrderService])
  .workflowConsumer(ReserveInventoryStep, [InventoryService])
  .workflowConsumer(ChargePaymentStep, [PaymentService])
  .workflowConsumer(CreateShipmentStep, [ShipmentService])
  .listen(3000);
```

## Executing Workflows

Start a workflow through `AppContext`:

```typescript
class OrderController implements OriController {
  constructor(private ctx: AppContext) {}

  configure(r: RouteBuilder) {
    r.post('/orders').handle(this.placeOrder);
  }

  private placeOrder = async (ctx: RequestContext) => {
    const input = ctx.body;

    // Start the workflow
    const handle = await this.ctx.workflows.execute(ProcessOrderWorkflow, {
      orderId: input.orderId,
      customerId: ctx.state.user.id,
      amount: input.amount,
      items: input.items,
    });

    // Return immediately — the workflow runs asynchronously
    return ctx.response.accepted({
      workflowId: handle.id,
      message: 'Order is being processed',
    });
  };
}
```

The `execute()` method:
1. Validates the input against the workflow's input schema
2. Creates a BullMQ flow (a tree of dependent jobs)
3. Returns a `FlowHandle` for tracking

### FlowHandle

The `FlowHandle` lets you track workflow progress:

```typescript
const handle = await ctx.workflows.execute(ProcessOrderWorkflow, input);

// Get the workflow ID (for storing or returning to the client)
const workflowId = handle.id;

// Check status (if needed)
const status = await handle.getState();
// 'waiting' | 'active' | 'completed' | 'failed'
```

## Sequential vs Parallel Execution

By default, workflow steps execute **sequentially** in the order they're defined. Under the hood, OriJS uses BullMQ's `FlowProducer` to create a dependency tree:

```
validateOrder → reserveInventory → chargePayment → createShipment
```

Each step waits for the previous one to complete before starting. This is important for our order workflow because:
- You must validate before reserving inventory
- You must reserve inventory before charging payment
- You must charge payment before creating a shipment

### Parallel Steps

Some steps can run concurrently. Use `.parallel()` to group them:

```typescript
const UserOnboardingWorkflow = Workflow.define({
  name: 'user.onboarding',
  input: Type.Object({
    userId: Type.String(),
    email: Type.String(),
    plan: Type.String(),
  }),
})
  .step('createAccount', { schema: AccountSchema })
  .parallel([
    { name: 'setupBilling', schema: BillingSchema },
    { name: 'sendWelcomeEmail', schema: EmailSchema },
    { name: 'provisionResources', schema: ResourceSchema },
  ])
  .step('activateAccount', { schema: ActivationSchema })
  .build();
```

Execution:
```
createAccount → [setupBilling, sendWelcomeEmail, provisionResources] → activateAccount
                         (run in parallel)
```

The parallel steps all start when `createAccount` completes, and `activateAccount` waits for all three parallel steps to finish.

## Compensation (Rollback)

When a later step fails, you often need to undo earlier steps. This is the **Saga pattern**:

```typescript
class ReserveInventoryStep implements WorkflowStepConsumer<typeof ProcessOrderWorkflow, 'reserveInventory'> {
  workflow = ProcessOrderWorkflow;
  step = 'reserveInventory';

  constructor(private inventoryService: InventoryService) {}

  async handle(ctx: WorkflowContext<typeof ProcessOrderWorkflow, 'reserveInventory'>) {
    const reservation = await this.inventoryService.reserve(ctx.input.items);
    return {
      reservationId: reservation.id,
      reservedItems: reservation.items,
    };
  }

  // Compensation handler — called if a LATER step fails
  async compensate(ctx: WorkflowContext<typeof ProcessOrderWorkflow, 'reserveInventory'>) {
    const { reservationId } = ctx.stepResult;  // Result from the successful handle()
    ctx.log.info('Rolling back inventory reservation', { reservationId });
    await this.inventoryService.releaseReservation(reservationId);
  }
}
```

If `chargePayment` fails after `reserveInventory` succeeds, the workflow engine calls `compensate()` on `ReserveInventoryStep` to release the reserved inventory.

Compensation runs in **reverse order** — if steps A, B, C ran and C fails, compensation runs for B then A (not A then B). This mirrors the LIFO pattern of OriJS's shutdown hooks, and for the same reason: you undo actions in the reverse order they were performed.

## BullMQ FlowProducer

Under the hood, OriJS uses BullMQ's `FlowProducer` to create workflow dependency trees. Understanding this helps with debugging and monitoring.

A workflow definition like:

```
step1 → step2 → [step3a, step3b] → step4
```

Becomes a BullMQ flow:

```
Flow: workflow.order.process
├── Job: step1 (no dependencies)
├── Job: step2 (depends on: step1)
├── Job: step3a (depends on: step2)
├── Job: step3b (depends on: step2)
└── Job: step4 (depends on: step3a, step3b)
```

Each step is a BullMQ job on its own queue. The `FlowProducer` ensures jobs execute in dependency order. This means:

- Steps run on separate workers (can be on different machines)
- Step results are passed through Redis (serialized as JSON)
- If a worker crashes, BullMQ retries the failed step
- The entire flow is visible in BullMQ monitoring tools (BullBoard, Bull Monitor)

## Real-World Example: Monitor Setup

Here's a complete workflow for setting up a new monitor in a monitoring application:

```typescript
const SetupMonitorWorkflow = Workflow.define({
  name: 'monitor.setup',
  input: Type.Object({
    monitorId: Type.String({ format: 'uuid' }),
    accountId: Type.String({ format: 'uuid' }),
    projectId: Type.String({ format: 'uuid' }),
    url: Type.String({ format: 'uri' }),
    checkInterval: Type.Integer({ minimum: 30 }),
  }),
})
  .step('validateUrl', {
    schema: Type.Object({
      isReachable: Type.Boolean(),
      responseTime: Type.Integer(),
      statusCode: Type.Integer(),
    }),
  })
  .step('configureChecker', {
    schema: Type.Object({
      checkerId: Type.String(),
      region: Type.String(),
    }),
  })
  .step('runInitialCheck', {
    schema: Type.Object({
      isUp: Type.Boolean(),
      responseTimeMs: Type.Integer(),
      certificateExpiry: Type.Optional(Type.String({ format: 'date-time' })),
    }),
  })
  .build();

// Step implementations
class ValidateUrlStep implements WorkflowStepConsumer<typeof SetupMonitorWorkflow, 'validateUrl'> {
  workflow = SetupMonitorWorkflow;
  step = 'validateUrl';

  constructor(private httpChecker: HttpCheckerService) {}

  async handle(ctx: WorkflowContext<typeof SetupMonitorWorkflow, 'validateUrl'>) {
    const { url } = ctx.input;
    ctx.log.info('Validating monitor URL', { url });

    const result = await this.httpChecker.probe(url);
    if (!result.isReachable) {
      throw new Error(`URL is not reachable: ${url}`);
    }

    return {
      isReachable: true,
      responseTime: result.responseTimeMs,
      statusCode: result.statusCode,
    };
  }
}

// Execute the workflow from a controller
class MonitorController implements OriController {
  constructor(
    private monitorService: MonitorService,
    private ctx: AppContext,
  ) {}

  configure(r: RouteBuilder) {
    r.post('/monitors').handle(this.createMonitor);
  }

  private createMonitor = async (ctx: RequestContext<AuthState>) => {
    const monitor = await this.monitorService.create(ctx.body);

    // Start setup workflow
    await this.ctx.workflows.execute(SetupMonitorWorkflow, {
      monitorId: monitor.uuid,
      accountId: ctx.state.user.accountId,
      projectId: ctx.body.projectId,
      url: ctx.body.url,
      checkInterval: ctx.body.checkInterval,
    });

    return ctx.response.created(monitor);
  };
}
```

## Testing Workflows

### Unit Testing Steps

Test each step independently:

```typescript
import { createMockWorkflowContext } from '@orijs/test-utils';

describe('ValidateUrlStep', () => {
  it('should validate a reachable URL', async () => {
    const httpChecker = {
      probe: async () => ({ isReachable: true, responseTimeMs: 150, statusCode: 200 }),
    };
    const step = new ValidateUrlStep(httpChecker as HttpCheckerService);

    const ctx = createMockWorkflowContext(SetupMonitorWorkflow, 'validateUrl', {
      monitorId: 'mon-123',
      accountId: 'acc-456',
      projectId: 'proj-789',
      url: 'https://example.com',
      checkInterval: 60,
    });

    const result = await step.handle(ctx);

    expect(result.isReachable).toBe(true);
    expect(result.responseTime).toBe(150);
  });

  it('should throw for unreachable URL', async () => {
    const httpChecker = {
      probe: async () => ({ isReachable: false, responseTimeMs: 0, statusCode: 0 }),
    };
    const step = new ValidateUrlStep(httpChecker as HttpCheckerService);

    const ctx = createMockWorkflowContext(SetupMonitorWorkflow, 'validateUrl', {
      monitorId: 'mon-123',
      accountId: 'acc-456',
      projectId: 'proj-789',
      url: 'https://unreachable.invalid',
      checkInterval: 60,
    });

    await expect(step.handle(ctx)).rejects.toThrow('URL is not reachable');
  });
});
```

### Integration Testing

For testing the complete workflow flow, use BullMQ in test mode with a real Redis instance:

```typescript
describe('ProcessOrder Workflow', () => {
  it('should complete all steps', async () => {
    const app = createTestApp();
    // ... register providers and workflow consumers

    const handle = await app.context.workflows.execute(ProcessOrderWorkflow, {
      orderId: 'order-123',
      customerId: 'cust-456',
      amount: 99.99,
      items: [{ productId: 'prod-1', quantity: 2 }],
    });

    // Wait for workflow to complete
    await waitForWorkflow(handle, { timeout: 10000 });

    // Verify side effects
    const order = await orderRepo.findById('order-123');
    expect(order.status).toBe('completed');
  });
});
```

## Summary

OriJS workflows provide:

1. **Saga pattern** for coordinated multi-step processes
2. **Type-safe definitions** with TypeBox schemas for input and step outputs
3. **Sequential and parallel** step execution
4. **Compensation handlers** for rollback when later steps fail
5. **BullMQ FlowProducer** for distributed, persistent step execution
6. **Trace context propagation** through all steps
7. **Independent step testing** with mock contexts

Use workflows when you need coordinated multi-step processes with rollback. For simpler fire-and-forget scenarios, events (Chapter 10) are the better choice.

[Previous: Events ←](./10-events.md) | [Next: WebSockets →](./12-websockets.md)
