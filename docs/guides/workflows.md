# Workflows

OriJS provides a type-safe workflow system for implementing the Saga pattern - long-running, multi-step business processes with compensation (rollback) support.

---

## Overview

Workflows are ideal for:

- **Multi-step transactions** - Orders, payments, registrations
- **Distributed operations** - Coordinating across services
- **Long-running processes** - Operations that take time to complete
- **Operations requiring rollback** - When failures need compensation
- **Parallel execution** - Steps that can run concurrently

---

## Defining Workflows

Use `Workflow.define()` to create type-safe workflow definitions with TypeBox schemas:

```typescript
import { Workflow } from '@orijs/core';
import { Type } from '@orijs/validation';

// Simple workflow (no steps)
export const SendEmail = Workflow.define({
	name: 'send-email',
	data: Type.Object({
		to: Type.String(),
		subject: Type.String(),
		body: Type.String()
	}),
	result: Type.Object({
		messageId: Type.String(),
		sentAt: Type.String()
	})
});

// Workflow with steps (distributed execution)
export const ProcessOrder = Workflow.define({
	name: 'process-order',
	data: Type.Object({
		orderId: Type.String(),
		items: Type.Array(
			Type.Object({
				productId: Type.String(),
				quantity: Type.Number()
			})
		),
		paymentMethod: Type.String(),
		userId: Type.String()
	}),
	result: Type.Object({
		orderId: Type.String(),
		status: Type.Literal('completed'),
		chargeId: Type.String()
	})
}).steps((s) =>
	s
		.sequential(s.step('reserve-inventory', Type.Object({ reservationId: Type.String() })))
		.sequential(s.step('charge-payment', Type.Object({ chargeId: Type.String() })))
		.parallel(
			s.step('send-confirmation', Type.Object({ sent: Type.Boolean() })),
			s.step('update-analytics', Type.Object({ tracked: Type.Boolean() }))
		)
);
```

**Naming Convention**: Use `action-noun` format in kebab-case (e.g., `send-email`, `process-order`).

---

## Understanding the Type System

### The Type Carrier Pattern

Workflow definitions include special fields (`_data`, `_result`, and `_steps`) that enable TypeScript's type system to work with TypeBox schemas. These fields are a design pattern called "type carriers."

**The Problem**: TypeBox schemas like `Type.Object({ orderId: Type.String() })` are runtime objects with complex generic types. TypeScript cannot easily extract the corresponding TypeScript type from a runtime value.

**The Solution**: Type carrier fields that are:

- **Always `undefined` at runtime** (zero memory/performance cost)
- **Typed as `TData` / `TResult` / `TSteps` at compile time**
- **Extractable via `typeof MyWorkflow['_data']`** or utility types

```typescript
// What Workflow.define() creates internally:
const ProcessOrder = Object.freeze({
	name: 'process-order',
	dataSchema: Type.Object({ orderId: Type.String() }),     // For runtime validation
	resultSchema: Type.Object({ status: Type.Literal('completed') }),
	stepGroups: [...],                                       // Step structure for BullMQ
	_data: undefined as unknown as { orderId: string },      // Type carrier
	_result: undefined as unknown as { status: 'completed' }, // Type carrier
	_steps: undefined as unknown as {                        // Type carrier for step results
		'reserve-inventory': { reservationId: string };
		'charge-payment': { chargeId: string };
	}
});

// At runtime: ProcessOrder._data === undefined
// At compile time: typeof ProcessOrder['_data'] = { orderId: string }
```

### Step Type Carriers

When you add steps via `.steps()`, the builder tracks step output types:

```typescript
const MyWorkflow = Workflow.define({
	name: 'my-workflow',
	data: Type.Object({ input: Type.String() }),
	result: Type.Object({ done: Type.Boolean() })
}).steps((s) =>
	s
		.sequential(s.step('validate', Type.Object({ valid: Type.Boolean() })))
		.sequential(s.step('process', Type.Object({ id: Type.String() })))
);

// Type carriers now include step types:
// typeof MyWorkflow['_steps'] = {
//   validate: { valid: boolean };
//   process: { id: string };
// }
```

### Using Utility Types (Recommended)

Always prefer utility types over direct property access:

```typescript
import { type WorkflowConsumer, type Data, type Result, type WorkflowCtx } from '@orijs/core';

// ✅ RECOMMENDED: Utility types
type OrderData = Data<typeof ProcessOrder>; // { orderId: string; items: ...; ... }
type OrderResult = Result<typeof ProcessOrder>; // { orderId: string; status: 'completed'; ... }
type OrderContext = WorkflowCtx<typeof ProcessOrder>; // WorkflowContext<OrderData>

// ✅ GOOD: Consumer utility type (infers from definition)
class MyConsumer implements WorkflowConsumer<typeof ProcessOrder> {
	onComplete = async (ctx) => {
		// ctx.data is fully typed as OrderData
		// ctx.results is typed based on step definitions
	};
}

// ❌ AVOID: Direct property access (works but verbose)
type DataDirect = (typeof ProcessOrder)['_data'];

// ❌ NEVER: Runtime access (always undefined!)
const data = ProcessOrder._data; // undefined - don't do this!
```

### Accessing Step Results

Step results are typed based on the workflow definition:

```typescript
class ProcessOrderConsumer implements WorkflowConsumer<typeof ProcessOrder> {
	steps = {
		'charge-payment': {
			execute: async (ctx) => {
				// ctx.results has type-safe access to previous step results
				const { reservationId } = ctx.results['reserve-inventory'];
				// TypeScript knows reservationId is string

				const chargeId = await this.paymentService.charge(reservationId);
				return { chargeId };
			}
		}
	};
}
```

---

## Step Definition API

The `.steps()` builder provides a fluent API for defining workflow structure.

### Sequential Steps

Steps run one after another, each waiting for the previous to complete:

```typescript
.steps(s => s
	.sequential(s.step('step1', Type.Object({ result1: Type.String() })))
	.sequential(s.step('step2', Type.Object({ result2: Type.String() })))
	.sequential(s.step('step3', Type.Object({ result3: Type.String() })))
)
```

### Parallel Steps

Steps run concurrently using `Promise.all`:

```typescript
.steps(s => s
	.parallel(
		s.step('notify-email', Type.Object({ sent: Type.Boolean() })),
		s.step('notify-sms', Type.Object({ sent: Type.Boolean() })),
		s.step('notify-push', Type.Object({ sent: Type.Boolean() }))
	)
)
```

### Mixed Execution

Chain sequential and parallel groups:

```typescript
.steps(s => s
	.sequential(s.step('validate', Type.Object({ valid: Type.Boolean() })))
	.sequential(s.step('process', Type.Object({ processId: Type.String() })))
	.parallel(
		s.step('notify-a', Type.Object({ sent: Type.Boolean() })),
		s.step('notify-b', Type.Object({ sent: Type.Boolean() }))
	)
	.sequential(s.step('finalize', Type.Object({ done: Type.Boolean() })))
)
```

**Execution order:**

1. `validate` runs
2. `process` runs
3. `notify-a` and `notify-b` run **concurrently**
4. `finalize` runs (after both notifications complete)

---

## Workflow Consumers

Consumers handle workflows when they're executed. The consumer provides step handlers and lifecycle callbacks:

```typescript
import { type WorkflowConsumer, type StepContext, type WorkflowContext } from '@orijs/core';

class ProcessOrderConsumer implements WorkflowConsumer<typeof ProcessOrder> {
	constructor(
		private inventoryService: InventoryService,
		private paymentService: PaymentService,
		private notificationService: NotificationService
	) {}

	// Step handlers (required for workflows with steps)
	steps = {
		'reserve-inventory': {
			execute: async (ctx: StepContext<(typeof ProcessOrder)['_data']>) => {
				const { items } = ctx.data;
				ctx.log.info('Reserving inventory', { items });
				const reservationId = await this.inventoryService.reserve(items);
				return { reservationId };
			},
			rollback: async (ctx: StepContext<(typeof ProcessOrder)['_data']>) => {
				const { reservationId } = ctx.results['reserve-inventory'];
				ctx.log.info('Releasing inventory reservation', { reservationId });
				await this.inventoryService.release(reservationId);
			}
		},
		'charge-payment': {
			execute: async (ctx: StepContext<(typeof ProcessOrder)['_data']>) => {
				const { orderId, paymentMethod } = ctx.data;
				ctx.log.info('Charging payment', { orderId, paymentMethod });
				const chargeId = await this.paymentService.charge(orderId, paymentMethod);
				return { chargeId };
			},
			rollback: async (ctx: StepContext<(typeof ProcessOrder)['_data']>) => {
				const { chargeId } = ctx.results['charge-payment'];
				ctx.log.info('Refunding payment', { chargeId });
				await this.paymentService.refund(chargeId);
			}
		},
		'send-confirmation': {
			execute: async (ctx: StepContext<(typeof ProcessOrder)['_data']>) => {
				const { orderId, userId } = ctx.data;
				await this.notificationService.sendOrderConfirmation(userId, orderId);
				return { sent: true };
			}
		},
		'update-analytics': {
			execute: async (ctx: StepContext<(typeof ProcessOrder)['_data']>) => {
				await this.analyticsService.trackOrder(ctx.data.orderId);
				return { tracked: true };
			}
		}
	};

	// Called when all steps complete (required)
	onComplete = async (ctx: WorkflowContext<(typeof ProcessOrder)['_data']>) => {
		const chargeResult = ctx.results['charge-payment'] as { chargeId: string };
		return {
			orderId: ctx.data.orderId,
			status: 'completed' as const,
			chargeId: chargeResult.chargeId
		};
	};

	// Called when any step fails (optional)
	onError = async (ctx: WorkflowContext<(typeof ProcessOrder)['_data']>, error: Error) => {
		ctx.log.error('Order processing failed', {
			orderId: ctx.data.orderId,
			error: error.message
		});
	};
}
```

### Why Arrow Functions?

Arrow function properties capture `this` at definition time. When the framework calls `consumer.onComplete(ctx)`, regular methods would have `this` as undefined because the method reference is detached from the instance.

```typescript
class MyConsumer implements WorkflowConsumer<typeof MyWorkflow> {
	constructor(private service: MyService) {}

	// Arrow function - this.service works correctly
	onComplete = async (ctx) => {
		await this.service.process(ctx.data);
		return { done: true };
	};

	// Regular method - this would be undefined when called
	// async onComplete(ctx) { ... }
}
```

---

## Application Registration

Register workflows and consumers with the fluent API:

```typescript
import { Ori } from '@orijs/core';
import { BullMQWorkflowProvider } from '@orijs/bullmq';

Ori.create()
	// Set the workflow provider (BullMQ for production)
	.workflowProvider(new BullMQWorkflowProvider({ connection: { host: 'redis', port: 6379 } }))

	// Register workflow with consumer and dependencies
	.workflow(ProcessOrder)
	.consumer(ProcessOrderConsumer, [InventoryService, PaymentService, NotificationService])

	// Emitter-only: register workflow without consumer (for cross-service workflows)
	.workflow(SendEmail)

	.listen(3000);
```

### Extension Pattern

For cleaner setup, use extension functions:

```typescript
// workflows.ts
export function addWorkflows(app: Application, redis: Redis): Application {
	return app
		.workflowProvider(new BullMQWorkflowProvider({ connection: redis }))
		.workflow(ProcessOrder)
		.consumer(ProcessOrderConsumer, [InventoryService, PaymentService])
		.workflow(SendEmail)
		.consumer(SendEmailConsumer, [SmtpClient]);
}

// app.ts
Ori.create()
	.use((app) => addWorkflows(app, redis))
	.listen(3000);
```

---

## Executing Workflows

Workflows are executed using the definition object, not string names. This provides compile-time type safety.

### From Controllers

```typescript
import { ProcessOrder } from './workflow-definitions';

class OrderController implements OriController {
	configure(r: RouteBuilder) {
		r.post('/orders/:id/process', this.processOrder);
	}

	private processOrder = async (ctx: RequestContext) => {
		const { id } = ctx.params;
		const order = await this.orderService.find(id);

		// Type-safe execute - data validated against TypeBox schema
		// handle is typed based on workflow definition
		const handle = await ctx.workflows.execute(ProcessOrder, {
			orderId: order.id,
			items: order.items,
			paymentMethod: order.paymentMethod,
			userId: ctx.state.user.id
		});

		// Return 202 Accepted - processing happens async
		return ctx.json(
			{
				message: 'Order processing started',
				workflowId: handle.id
			},
			202
		);
	};
}
```

### Wait for Result

```typescript
private processOrderSync = async (ctx: RequestContext) => {
	const handle = await ctx.workflows.execute(ProcessOrder, data);

	// Wait for completion - result is typed as ProcessOrder['_result']
	const result = await handle.result();

	return ctx.json(result);
};
```

### Fire and Forget

```typescript
private processOrderAsync = async (ctx: RequestContext) => {
	const handle = await ctx.workflows.execute(ProcessOrder, data);

	// Return immediately - processing happens async
	return ctx.json({ workflowId: handle.id }, 202);
};
```

---

## FlowHandle

When you start a workflow, you get a `FlowHandle`:

```typescript
interface FlowHandle<TResult> {
	/** Unique flow ID */
	readonly id: string;

	/** Get current status */
	status(): Promise<FlowStatus>;

	/** Wait for completion and get result */
	result(): Promise<TResult>;
}

type FlowStatus = 'pending' | 'running' | 'completed' | 'failed';
```

### Usage

```typescript
const handle = await ctx.workflows.execute(ProcessOrder, data);

// Get workflow ID
console.log('Started workflow:', handle.id);

// Check status (non-blocking)
const status = await handle.status();
if (status === 'running') {
	console.log('Still processing...');
}

// Wait for result (blocking)
try {
	const result = await handle.result();
	console.log('Completed:', result);
} catch (error) {
	console.error('Failed:', error.message);
}
```

---

## StepContext and WorkflowContext

### StepContext

Step handlers receive `StepContext` with workflow data and accumulated results:

```typescript
interface StepContext<TData, TResults = Record<string, unknown>> {
	/** Unique flow ID for this workflow execution */
	readonly flowId: string;
	/** The workflow input data */
	readonly data: TData;
	/** Accumulated results from completed steps */
	readonly results: TResults;
	/** Logger with propagated context */
	readonly log: Logger;
	/** Metadata for context propagation */
	readonly meta: Record<string, unknown>;
	/** Current step name being executed */
	readonly stepName: string;
}
```

### WorkflowContext

`onComplete` and `onError` receive `WorkflowContext`:

```typescript
interface WorkflowContext<TData> {
	/** Unique flow ID for this workflow execution */
	readonly flowId: string;
	/** The workflow input data */
	readonly data: TData;
	/** Accumulated results from all completed steps */
	readonly results: Record<string, unknown>;
	/** Logger with propagated context */
	readonly log: Logger;
	/** Metadata for context propagation */
	readonly meta: Record<string, unknown>;
}
```

### Accessing Step Results

```typescript
steps = {
	'charge-payment': {
		execute: async (ctx) => {
			// Access previous step result
			const { reservationId } = ctx.results['reserve-inventory'] as { reservationId: string };
			ctx.log.info('Charging with reservation', { reservationId });
			// ...
		}
	}
};
```

---

## Type Utilities

OriJS provides utility types for extracting types from workflow definitions:

```typescript
import { type WorkflowConsumer, type Data, type Result } from '@orijs/core';

// Extract data type
type OrderData = Data<typeof ProcessOrder>; // { orderId: string; items: ...; ... }

// Extract result type
type OrderResult = Result<typeof ProcessOrder>; // { orderId: string; status: 'completed'; chargeId: string }

// Get the consumer interface - cleaner than manual typing
type OrderConsumer = WorkflowConsumer<typeof ProcessOrder>;
```

### Using WorkflowConsumer Utility Type

```typescript
import { type WorkflowConsumer } from '@orijs/core';

// Clean: uses utility type
class ProcessOrderConsumer implements WorkflowConsumer<typeof ProcessOrder> {
	onComplete = async (ctx) => {
		// ctx.data is fully typed as { orderId: string; items: ...; ... }
		const { orderId } = ctx.data;
		return { orderId, status: 'completed' as const, chargeId: 'ch-123' };
	};
}

// Equivalent but verbose
class ProcessOrderConsumer implements IWorkflowConsumer<
	(typeof ProcessOrder)['_data'],
	(typeof ProcessOrder)['_result'],
	(typeof ProcessOrder)['_steps']
> {
	// ...
}
```

---

## Execution Flow

### Successful Execution

```
Start → Step 1 → Step 2 → Step 3 → onComplete → Complete
        ✓         ✓         ✓
```

Steps execute in sequence. Each step can return data used by later steps or rollback handlers.

### Failed Execution with Rollback

```
Start → Step 1 → Step 2 → Step 3 (FAIL)
        ✓         ✓         ✗
                  ↓
        Rollback 2 ← Rollback 1 ← (no rollback for step 3)
        ✓           ✓
                    ↓
                onError → Failed
```

When a step fails:

1. Rollback handlers execute in **LIFO order** (reverse of execution)
2. Only steps that completed successfully get rolled back
3. The failed step doesn't get a rollback call (it never completed)
4. `onError` is called after all rollbacks complete

### Parallel Execution

```
Start → Sequential Steps → Parallel Group → Sequential Steps → Complete
                             ├─ Step A ─┤
                             ├─ Step B ─┤
                             └─ Step C ─┘
```

Parallel steps:

- Run concurrently via `Promise.all`
- All must complete before the next group starts
- If any fails, all completed parallel steps are rolled back

---

## BullMQ Provider Configuration

The `BullMQWorkflowProvider` offers comprehensive configuration for production:

### Basic Configuration

```typescript
const provider = new BullMQWorkflowProvider({
	connection: {
		host: 'redis',
		port: 6379,
		password: process.env.REDIS_PASSWORD
	},
	// Queue name prefix
	queuePrefix: 'workflow',
	// Provider instance identifier (for distributed tracing)
	providerId: 'instance-1'
});
```

### Distributed Step Execution

The key benefit of defining steps in the workflow definition is **distributed execution**:

1. **Emitter creates BullMQ flow** - Steps become child jobs
2. **Any consumer processes steps** - Work distributed across instances
3. **Fault tolerance** - If coordinator A dies mid-step, coordinator B picks up from the queue

```
Instance 1: Execute workflow → Creates BullMQ flow with step children
                                     ↓
Redis Queue: [validate] → [process] → [notify-a, notify-b] → [parent]
                                     ↓
Instance 2: Picks up 'validate' step, processes it
Instance 3: Picks up 'process' step, processes it
Instance 1: Picks up 'notify-a', Instance 2: Picks up 'notify-b'
Instance 3: Parent job runs onComplete, returns result
Instance 1: Receives result via QueueEvents
```

### Graceful Shutdown

The BullMQ provider handles shutdown order automatically:

```typescript
process.on('SIGTERM', async () => {
	// Stops in correct order:
	// 1. Workers (wait for current jobs)
	// 2. QueueEvents (completion tracking)
	// 3. FlowProducer
	await provider.stop();
	process.exit(0);
});
```

---

## Error Handling

### Step Failures

When a step throws, the workflow triggers rollback:

```typescript
steps = {
	'charge-payment': {
		execute: async (ctx) => {
			const response = await this.paymentService.charge(ctx.data);

			if (!response.success) {
				// Throwing triggers rollback of previous steps
				throw new Error(`Payment failed: ${response.error}`);
			}

			return { chargeId: response.chargeId };
		}
	}
};
```

### WorkflowStepError

Step failures are wrapped in `WorkflowStepError`:

```typescript
import { WorkflowStepError } from '@orijs/workflows';

onError = async (ctx, error) => {
	if (error instanceof WorkflowStepError) {
		ctx.log.error('Step failed', {
			stepName: error.stepName,
			message: error.message,
			originalError: error.cause
		});
	}
};
```

### Rollback Failures

Rollback handlers should be resilient - failures are logged but don't stop other rollbacks:

```typescript
steps = {
	'charge-payment': {
		execute: async (ctx) => {
			/* ... */
		},
		rollback: async (ctx) => {
			const { chargeId } = ctx.results['charge-payment'] as { chargeId: string };

			try {
				await this.paymentService.refund(chargeId);
			} catch (error) {
				// Log but don't throw - allow other rollbacks to continue
				ctx.log.error('Refund failed, manual intervention required', {
					chargeId,
					error
				});
			}
		}
	}
};
```

---

## Idempotency

### Making Rollbacks Idempotent

Rollbacks may be called multiple times in distributed systems. Design for idempotency:

```typescript
rollback: async (ctx) => {
	const { reservationId } = ctx.results['reserve-inventory'] as { reservationId: string };

	const reservation = await this.inventoryService.findReservation(reservationId);

	// Already cancelled? Skip.
	if (!reservation || reservation.status === 'cancelled') {
		ctx.log.info('Reservation already cancelled or not found');
		return;
	}

	await this.inventoryService.cancel(reservationId);
};
```

### Idempotent External Calls

Use idempotency keys when calling external services:

```typescript
execute: async (ctx) => {
	const { orderId, amount } = ctx.data;

	// Use idempotency key to prevent double-charging
	const result = await this.paymentService.charge({
		idempotencyKey: `order-${orderId}-charge`,
		amount
	});

	return { chargeId: result.chargeId };
};
```

---

## Testing Workflows

### Unit Testing Step Handlers

```typescript
import { describe, it, expect, mock } from 'bun:test';

describe('ProcessOrderConsumer', () => {
	it('reserves inventory', async () => {
		const inventoryService = {
			reserve: mock(() => Promise.resolve('res-123'))
		};

		const consumer = new ProcessOrderConsumer(
			inventoryService as any,
			{} as PaymentService,
			{} as NotificationService
		);

		const ctx = {
			data: { items: [{ productId: 'p1', quantity: 2 }] },
			log: { info: () => {}, error: () => {} },
			results: {},
			flowId: 'flow-1',
			stepName: 'reserve-inventory',
			meta: {}
		};

		const result = await consumer.steps['reserve-inventory'].execute(ctx);

		expect(result.reservationId).toBe('res-123');
		expect(inventoryService.reserve).toHaveBeenCalledWith([{ productId: 'p1', quantity: 2 }]);
	});

	it('releases inventory on rollback', async () => {
		const inventoryService = {
			release: mock(() => Promise.resolve())
		};

		const consumer = new ProcessOrderConsumer(
			inventoryService as any,
			{} as PaymentService,
			{} as NotificationService
		);

		const ctx = {
			log: { info: () => {} },
			results: { 'reserve-inventory': { reservationId: 'res-123' } },
			data: {},
			flowId: 'flow-1',
			stepName: 'reserve-inventory',
			meta: {}
		};

		await consumer.steps['reserve-inventory'].rollback!(ctx);

		expect(inventoryService.release).toHaveBeenCalledWith('res-123');
	});
});
```

### Integration Testing with BullMQ

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer } from 'testcontainers';

describe('BullMQ Workflow Integration', () => {
	let redisContainer;
	let provider: BullMQWorkflowProvider;

	beforeAll(async () => {
		redisContainer = await new GenericContainer('redis:7').withExposedPorts(6379).start();

		provider = new BullMQWorkflowProvider({
			connection: {
				host: redisContainer.getHost(),
				port: redisContainer.getMappedPort(6379)
			}
		});
	});

	afterAll(async () => {
		await provider.stop();
		await redisContainer.stop();
	});

	it('executes workflow through BullMQ', async () => {
		// Register consumer
		// ... setup code

		const handle = await provider.execute(TestWorkflow, { value: 42 });
		const result = await handle.result();

		expect(result.success).toBe(true);
	});
});
```

---

## Best Practices

### 1. Define Steps in the Definition

Steps belong in the workflow definition, not the consumer:

```typescript
// GOOD - steps defined in definition
export const ProcessOrder = Workflow.define({
	name: 'process-order',
	data: Type.Object({ orderId: Type.String() }),
	result: Type.Object({ status: Type.String() })
}).steps((s) =>
	s
		.sequential(s.step('validate', Type.Object({ valid: Type.Boolean() })))
		.sequential(s.step('process', Type.Object({ id: Type.String() })))
);

// Consumer only provides handlers
class ProcessOrderConsumer implements WorkflowConsumer<typeof ProcessOrder> {
	steps = {
		validate: { execute: async (ctx) => ({ valid: true }) },
		process: { execute: async (ctx) => ({ id: 'p-123' }) }
	};
	onComplete = async (ctx) => ({ status: 'done' });
}
```

### 2. Keep Steps Focused

Each step should do one thing:

```typescript
// GOOD - focused steps
.steps(s => s
	.sequential(s.step('reserve-inventory', ...))
	.sequential(s.step('charge-payment', ...))
	.sequential(s.step('create-shipment', ...))
)

// BAD - step does too much
.steps(s => s
	.sequential(s.step('process-order', ...)) // Does everything
)
```

### 3. Return Rollback Data

Always return data that rollback handlers will need:

```typescript
steps = {
	'create-user': {
		execute: async (ctx) => {
			const user = await this.userService.create(ctx.data);
			// Return ID for rollback
			return { userId: user.id };
		},
		rollback: async (ctx) => {
			// Use the returned ID
			const { userId } = ctx.results['create-user'] as { userId: string };
			await this.userService.delete(userId);
		}
	}
};
```

### 4. Make Rollbacks Idempotent

Rollbacks may be called multiple times:

```typescript
// GOOD - check state before rolling back
rollback: async (ctx) => {
	const { reservationId } = ctx.results['reserve-inventory'];
	const reservation = await this.findReservation(reservationId);

	if (!reservation || reservation.status === 'cancelled') {
		ctx.log.info('Already cancelled');
		return;
	}

	await this.inventoryService.cancel(reservationId);
};

// BAD - assumes reservation exists and isn't cancelled
rollback: async (ctx) => {
	const { reservationId } = ctx.results['reserve-inventory'];
	await this.inventoryService.cancel(reservationId); // May fail if already cancelled
};
```

### 5. Use Parallel Steps for Independent Operations

```typescript
// GOOD - notifications can run in parallel
.steps(s => s
	.sequential(s.step('process', ...))
	.parallel(
		s.step('notify-email', ...),
		s.step('notify-sms', ...),
		s.step('update-crm', ...)
	)
)

// BAD - sequential when operations are independent
.steps(s => s
	.sequential(s.step('process', ...))
	.sequential(s.step('notify-email', ...)) // Waiting unnecessarily
	.sequential(s.step('notify-sms', ...))
)
```

### 6. Handle Serialization in Distributed Mode

When using BullMQ, ensure data is JSON-serializable:

```typescript
// GOOD - plain objects are serializable
return { userId: user.id, createdAt: user.createdAt.toISOString() };

// BAD - Date objects may not serialize correctly
return { userId: user.id, createdAt: user.createdAt };

// BAD - functions cannot be serialized
return { userId: user.id, format: () => '...' };
```

---

## Architecture: Distributed Workflow Steps

The BullMQ provider uses **FlowProducer** for distributed step execution.

### Why Steps Are in the Definition (Not Consumer)

This is a critical design decision for distributed execution:

```typescript
// Steps defined in definition - CORRECT
const ProcessOrder = Workflow.define({...}).steps(s => s
	.sequential(s.step('validate', ...))
	.sequential(s.step('process', ...))
);

// Consumer only provides handlers
class ProcessOrderConsumer implements WorkflowConsumer<typeof ProcessOrder> {
	steps = { /* handlers only */ };
}
```

**Why?** When you call `ctx.workflows.execute(ProcessOrder, data)`:

1. The **emitter** reads the step structure from the definition
2. Creates a BullMQ **FlowProducer** job tree based on those steps
3. Steps become **child jobs** in Redis queues
4. **Any worker** can pick up and execute step jobs
5. Consumer's `steps` handlers are looked up by name when a step job runs

If the emitter (Coordinator A) dies mid-workflow, the jobs are already in Redis. Another coordinator (B) picks up from the queue and continues.

### BullMQ Flow Structure

```
Workflow Definition:
  .steps(s => s
    .sequential(step1)     →  Creates child job hierarchy
    .sequential(step2)     →  in BullMQ FlowProducer
    .parallel(step3, step4)
  )

BullMQ Flow Structure:
  Parent Job (workflow)
    └── step4 (parallel group)
        └── step3 (parallel group)
            └── step2 (runs after step1)
                └── step1 (runs first, deepest child)
```

**How it works:**

- BullMQ runs children **before** parents
- Sequential: step2 is child of step1 → step1 completes first
- Parallel: steps at same level are siblings → run concurrently
- Parent job runs after all children complete → collects results

### Coordinator Failover

```
Timeline:
  t=0:  Coordinator A calls execute(ProcessOrder, data)
  t=1:  BullMQ creates flow: parent → step2 → step1
  t=2:  Worker X picks up step1, starts executing
  t=3:  Coordinator A crashes!
  t=4:  step1 completes, Worker X returns result
  t=5:  Worker Y picks up step2 (any worker can process it)
  t=6:  step2 completes
  t=7:  Worker Z picks up parent job, calls onComplete
  t=8:  Coordinator B's QueueEvents receives 'completed' event
```

**Key insight**: No state is lost because everything is in Redis. Workers don't need the original coordinator.

### Step Result Aggregation

When a parent job runs, it can access all child results:

```typescript
// In BullMQ worker
async function processParentJob(job) {
	// getChildrenValues() returns all child job results
	const childResults = await job.getChildrenValues();
	// Returns: { 'steps.validate:job-id-123': { valid: true }, ... }
}
```

The `BullMQWorkflowProvider` aggregates these into `ctx.results`:

```typescript
// In onComplete handler
onComplete = async (ctx) => {
	// ctx.results is built from child job return values
	const { reservationId } = ctx.results['reserve-inventory'];
	const { chargeId } = ctx.results['charge-payment'];
	return { orderId: ctx.data.orderId, status: 'completed', chargeId };
};
```

### Benefits

- **Fault tolerance** - Steps persist in Redis, survive crashes
- **Distributed execution** - Any worker can process any step
- **Result aggregation** - Parent job collects child results
- **Scaling** - Add more workers to process steps faster
- **Visibility** - BullMQ Board shows workflow progress
- **Retry** - Individual steps can be retried without restarting workflow

---

## Troubleshooting

### Common Errors

| Error                                     | Cause                                           | Solution                                                 |
| ----------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `Cannot execute workflow: not registered` | Workflow definition not passed to `.workflow()` | Add `.workflow(Definition).consumer(...)` to app setup   |
| `No workflow provider configured`         | Missing `.workflowProvider()` call              | Add `.workflowProvider(new BullMQWorkflowProvider(...))` |
| `Step handler not found: xxx`             | Consumer missing handler for step               | Add step handler to consumer's `steps` property          |
| `this is undefined in handler`            | Using regular method instead of arrow function  | Change to arrow function property                        |
| `Data validation failed`                  | Input doesn't match schema                      | Check data against `dataSchema`                          |
| `Result validation failed`                | Return value doesn't match schema               | Check `onComplete` return against `resultSchema`         |

### Debugging Workflows

**1. Check workflow registration:**

```typescript
console.log('Registered workflows:', app.getWorkflowRegistry().getWorkflowNames());
```

**2. Add logging to step handlers:**

```typescript
steps = {
	'my-step': {
		execute: async (ctx) => {
			ctx.log.debug('Step executing', {
				flowId: ctx.flowId,
				stepName: ctx.stepName,
				data: ctx.data,
				previousResults: ctx.results
			});
			// ... process
		}
	}
};
```

**3. Check BullMQ flow status:**

```typescript
import { FlowProducer, Queue } from 'bullmq';

const queue = new Queue('workflows.process-order', { connection });
const flow = await queue.getFlow(flowId);
console.log('Flow state:', flow?.job?.getState());
console.log('Children:', flow?.children);
```

**4. View failed jobs:**

```typescript
const failedJobs = await queue.getFailed(0, 100);
for (const job of failedJobs) {
	console.log('Failed:', job.name, job.failedReason);
	console.log('Stack:', job.stacktrace);
}
```

### Common Mistakes

**Forgetting rollback data:**

```typescript
// ❌ WRONG - rollback has no data to work with
steps = {
	'create-user': {
		execute: async (ctx) => {
			await this.userService.create(ctx.data);
			return { success: true }; // No user ID!
		},
		rollback: async (ctx) => {
			// How do we know which user to delete?
			const { userId } = ctx.results['create-user']; // undefined!
		}
	}
};

// ✅ CORRECT - return data rollback needs
steps = {
	'create-user': {
		execute: async (ctx) => {
			const user = await this.userService.create(ctx.data);
			return { userId: user.id }; // Include ID for rollback
		},
		rollback: async (ctx) => {
			const { userId } = ctx.results['create-user'];
			await this.userService.delete(userId);
		}
	}
};
```

**Non-idempotent rollback:**

```typescript
// ❌ WRONG - will fail if called twice
rollback: async (ctx) => {
	await this.inventoryService.release(ctx.results['reserve'].id);
	// Second call: reservation already released → error
};

// ✅ CORRECT - idempotent rollback
rollback: async (ctx) => {
	const reservation = await this.inventoryService.find(ctx.results['reserve'].id);
	if (!reservation || reservation.status === 'released') {
		ctx.log.info('Already released, skipping');
		return;
	}
	await this.inventoryService.release(reservation.id);
};
```

**Non-serializable step results:**

```typescript
// ❌ WRONG - Date doesn't serialize well through BullMQ
return { createdAt: new Date() };

// ✅ CORRECT - use ISO string
return { createdAt: new Date().toISOString() };

// ❌ WRONG - functions can't be serialized
return { format: () => 'hello' };

// ✅ CORRECT - only plain data
return { message: 'hello' };
```

### Provider Lifecycle

**Before `start()`:**

- Workers not running
- Cannot process workflows
- Execute calls will queue but not process

**After `start()`:**

- FlowProducer ready
- Workers listening to step queues
- QueueEvents tracking completions

**After `stop()`:**

- Workers finish current jobs
- New workflows queued but not processed
- Safe to shut down application

```typescript
const provider = new BullMQWorkflowProvider({ connection });

// Provider not started - workflows queue but don't process
await ctx.workflows.execute(ProcessOrder, data); // Queued but waiting

await provider.start(); // Now workers processing

await provider.stop(); // Graceful shutdown
```

---

## Next Steps

- [Events](./events.md) - Trigger workflows from events
- [Testing](./testing.md) - Testing workflow consumers
