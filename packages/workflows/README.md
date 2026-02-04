# @orijs/workflows

Workflow orchestration system for OriJS with sequential/parallel step execution, rollback handlers, and pluggable providers.

## Installation

```bash
bun add @orijs/workflows
```

## Quick Start

```typescript
import { WorkflowRegistry, InProcessWorkflowProvider } from '@orijs/workflows';

// Define a workflow
class OrderWorkflow {
	name = 'OrderWorkflow';

	build(builder) {
		return builder
			.step('validate', async (ctx) => {
				return { valid: true };
			})
			.step(
				'charge',
				async (ctx) => {
					const { valid } = ctx.getResult('validate');
					return { chargeId: 'ch_123' };
				},
				{
					rollback: async (ctx) => {
						// Compensating action if later steps fail
						await refundCharge(ctx.getResult('charge').chargeId);
					}
				}
			)
			.step('fulfill', async (ctx) => {
				return { shipped: true };
			});
	}
}

// Register and execute
const registry = WorkflowRegistry.create().register(OrderWorkflow).build();
const provider = new InProcessWorkflowProvider({ registry });

await provider.start();
const handle = await provider.execute(OrderWorkflow, { orderId: '123' });
const result = await handle.result();
await provider.stop();
```

## Key Concepts

- **Workflows** - Define multi-step business processes
- **Steps** - Individual units of work with optional rollback handlers
- **Parallel Groups** - Execute multiple steps concurrently with `parallel()`
- **Rollbacks** - Compensating actions run in reverse order on failure
- **Providers** - Pluggable execution engines (in-process, distributed)

## Providers

| Provider                    | Use Case                                |
| --------------------------- | --------------------------------------- |
| `InProcessWorkflowProvider` | Development, testing, single-instance   |
| Distributed providers       | Production, distributed, multi-instance |

## API Reference

See [OriJS Workflows Documentation](/docs/guides/workflows.md) for complete API reference.
