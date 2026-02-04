# ADR-007: BullMQWorkflowProvider Facade Pattern

## Status

Accepted

## Context

Code reviews flag `BullMQWorkflowProvider` (~1,900 lines) as an SRP violation because it handles multiple concerns:

- Workflow registration and lifecycle management
- Worker creation and management
- Job creation via FlowProducer
- Step processing and result aggregation
- Rollback orchestration
- Timeout management
- QueueEvents lifecycle
- Local state tracking for callers

This creates review noise similar to what ADR-005 addressed for the `Application` class.

## Decision

**BullMQWorkflowProvider is intentionally centralized as a facade for distributed workflow execution.**

This class follows the same principles as the Application class (ADR-005):

1. **Single Actor**: Serves ONE actor - the application developer who registers workflows and executes them. All methods serve this stakeholder.

2. **Coordination, Not Logic**: The class coordinates BullMQ components (FlowProducer, Workers, QueueEvents) but contains minimal business logic. It's a facade that hides distributed system complexity.

3. **Expected Pattern**: Distributed workflow providers are inherently complex facades:
   - Temporal.io's WorkflowClient coordinates connections, workers, and queries
   - AWS Step Functions SDK coordinates state machines, executions, and history
   - Conductor's WorkflowClient manages workflows, tasks, and metadata

4. **Extraction Cost > Benefit**: Attempted extractions revealed tight coupling:
   - WorkerManager would need processor callbacks and error handling injection
   - QueueEventsManager would need promise resolution callbacks
   - Each extraction adds ~50 lines of interface code without reducing cognitive load
   - Developers would need to understand multiple files instead of one

5. **Partial Extractions Made**: Some focused extractions were beneficial:
   - `workflow-result-utils.ts`: Result wrapper types and flattening (pure functions)
   - `flow-builder.ts`: Job definition building (already extracted)
   - `step-registry.ts`: Handler registration (already extracted)

## Code Review Findings (WON'T FIX)

The following patterns should NOT be flagged in code reviews for this class:

| Pattern                           | Reason                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| BullMQWorkflowProvider >300 lines | Facade classes are exempt from line limits (per ADR-005 principle) |
| Multiple worker maps              | Coordination requires tracking multiple BullMQ resources           |
| Many private methods              | Internal organization of facade responsibilities                   |
| 15+ instance variables            | Inherent to coordinating distributed workflow execution            |

## Consequences

### Positive

- Code reviews stop flagging this repeatedly
- Single file contains all BullMQ workflow coordination
- Easier to understand the full lifecycle in one place
- Pure utility functions are extracted for reuse

### Negative

- Large file requires more scrolling
- New contributors may find it intimidating initially

## References

- ADR-005: Application Class Centralization (establishes facade exemption principle)
- ADR-001: Core Design Decisions (documents BullMQ-specific patterns)
- Uncle Bob's SRP clarification: "A class should have only one reason to change" means one actor/stakeholder
