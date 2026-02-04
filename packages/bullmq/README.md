# @orijs/bullmq

BullMQ event and workflow providers for OriJS. Production-ready distributed execution using Redis.

## Installation

```bash
bun add @orijs/bullmq @orijs/workflows @orijs/events
```

## Quick Start

### Distributed Workflows

```typescript
import { BullMQWorkflowProvider } from '@orijs/bullmq';

const provider = new BullMQWorkflowProvider({
	connection: { host: 'localhost', port: 6379 },
	queuePrefix: 'myapp'
});

// Register workflow (emitter-only mode - another instance processes)
provider.registerEmitterWorkflow(OrderWorkflow.name);

await provider.start();

// Execute workflow (can be picked up by any instance)
const handle = await provider.execute(
	OrderWorkflow,
	{ orderId: '123' },
	{
		idempotencyKey: 'order-123', // Prevents duplicate execution
		timeout: 30000
	}
);

const result = await handle.result();
await provider.stop();
```

### Distributed Events

```typescript
import { BullMQEventProvider } from '@orijs/bullmq';

const eventProvider = new BullMQEventProvider({
	connection: { host: 'localhost', port: 6379 },
	queuePrefix: 'myapp'
});

// Subscribe to events
eventProvider.on('order.created', async (event, ctx) => {
	console.log('Order created:', event.data);
});

await eventProvider.start();

// Publish events
await eventProvider.emit('order.created', { orderId: '123' });

await eventProvider.stop();
```

## Key Features

- **Distributed Execution** - Workflows run across multiple instances via Redis
- **Idempotency Keys** - Prevent duplicate workflow execution
- **Automatic Rollbacks** - Compensating actions on step failure
- **Parent-Child Jobs** - BullMQ FlowProducer for step orchestration
- **Failure Cascading** - `failParentOnFailure` propagates errors up the job tree
- **Context Propagation** - Request IDs, trace IDs flow through all jobs

## Provider Options

```typescript
new BullMQWorkflowProvider({
	connection: { host: 'localhost', port: 6379 }, // Redis connection (required)
	queuePrefix: 'myapp', // Queue name prefix (optional)
	defaultTimeout: 30000, // Default workflow timeout in ms (default: 30s)
	stallInterval: 5000, // Worker stall detection interval (min: 5000ms)
	flowStateCleanupDelay: 300000, // Cleanup delay for local state (default: 5 min)
	providerId: 'instance-1' // Optional instance identifier for distributed tracing
});
```

## Architecture

- Uses BullMQ FlowProducer for parent-child job relationships
- Step handlers registered in StepRegistry (shared across instances)
- QueueEvents for result notification (any instance can receive)
- Local flow state for caller-side promise tracking only

## API Reference

See [OriJS BullMQ Documentation](/docs/reference/bullmq/_llms.md) for BullMQ patterns and [OriJS Workflows](/docs/guides/workflows.md) for workflow concepts.
