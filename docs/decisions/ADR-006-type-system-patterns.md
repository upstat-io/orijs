# ADR-006: Type System Design Decisions

## Status

Accepted

## Context

This ADR consolidates architectural decisions for the OriJS type system (`packages/core/src/types/`), documenting patterns that code reviewers should NOT flag as issues. These patterns were explicitly reviewed and accepted during the consumer pattern code review (2026-01-14).

---

## Part 1: Type Carrier Pattern

### Decision

Use `undefined as unknown as Static<T>` for phantom type carriers.

### Rationale

Type carriers enable compile-time type extraction via `typeof Event['_payload']` without runtime overhead. The pattern is:

```typescript
interface EventDefinition<TPayload, TResponse> {
	readonly name: string;
	readonly _payload: TPayload; // Always undefined at runtime
	readonly _response: TResponse; // Always undefined at runtime
}

// Factory creates type carriers
Event.define({
	name: 'user.created',
	payload: Type.Object({ userId: Type.String() }),
	response: Type.Void()
});
// Result: { name: 'user.created', _payload: undefined, _response: undefined }
```

### Won't Fix Patterns

| Pattern                                   | Reason                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `as unknown as` type assertion            | Required for phantom types - no alternative                                    |
| `_payload`, `_response` underscore prefix | Standard phantom type convention (Zod, io-ts, Effect)                          |
| No runtime validation of type carriers    | Tests verify behavior; throwing getters add overhead for theoretical edge case |
| Type carriers appear in Object.keys()     | Expected behavior; consumers use utility types, not direct access              |

### References

- Code Review #11, #12, #29, #34, #43, #58, #81, #90

---

## Part 2: Utility Type Naming

### Decision

Use short, generic names for utility types following TypeScript conventions.

### Rationale

```typescript
// OriJS utility types
Payload<T>; // Extract payload type from EventDefinition
Response<T>; // Extract response type from EventDefinition
Data<T>; // Extract data type from WorkflowDefinition
Result<T>; // Extract result type from WorkflowDefinition
Consumer<T>; // Consumer type for EventDefinition
Context<T>; // Deprecated alias for EventCtx<T>
EventCtx<T>; // Event context type
WorkflowCtx<T>; // Workflow context type

// TypeScript built-in utility types (same pattern)
(Partial<T>, Required<T>, Pick<T, K>, Omit<T, K>);
```

### Won't Fix Patterns

| Pattern                           | Reason                                                    |
| --------------------------------- | --------------------------------------------------------- |
| Generic names (Payload, Response) | Follow TypeScript utility type conventions                |
| Single-letter `T` parameter       | Standard convention; constraint documents meaning         |
| No namespace organization         | Flat exports match TypeScript conventions                 |
| Potential naming collisions       | Import aliasing available; `@orijs/core` context is clear |

### References

- Code Review #6, #30, #33, #66, #82, #93

---

## Part 3: Event vs Workflow Naming

### Decision

Use semantically distinct naming for events and workflows.

### Rationale

Events use **messaging terminology**:

- `payload` - Data sent with message
- `response` - Reply to message
- `EventContext` - Message handling context

Workflows use **processing terminology**:

- `data` - Input to process
- `result` - Output of process
- `WorkflowContext` - Processing execution context

This distinction helps developers understand the different execution models:

- Events: Fire-and-forget or request-response messaging
- Workflows: Multi-step orchestrated processing

### Won't Fix Patterns

| Pattern                                 | Reason                                                         |
| --------------------------------------- | -------------------------------------------------------------- |
| `payload`/`response` vs `data`/`result` | Semantic distinction, not inconsistency                        |
| `onEvent` vs `onComplete`               | Events have single handler; workflows complete after all steps |
| `EventCtx` vs `WorkflowCtx`             | Consistent abbreviation pattern                                |

### References

- Code Review #7, #57, #61

---

## Part 4: Validation at Registration

### Decision

Defer name validation to registration layer (`app.event()`, `app.workflow()`).

### Rationale

```typescript
// Definition factories are PURE TYPE DEFINITIONS
const UserCreated = Event.define({
	name: 'user.created', // Any string accepted here
	payload: UserCreatedPayload,
	response: Type.Void()
});

// Registration layer VALIDATES names
app.event(UserCreated, UserCreatedConsumer);
// ^ Throws if name is empty, has invalid characters, etc.
```

Benefits:

1. Factories stay simple (single responsibility)
2. Different contexts can have different naming requirements
3. Validation errors occur at application startup, not definition time
4. Template literal types would be overly restrictive for edge cases

### Won't Fix Patterns

| Pattern                                   | Reason                            |
| ----------------------------------------- | --------------------------------- |
| No runtime validation in `Event.define()` | Deferred to registration          |
| No template literal type for names        | Too restrictive, poor DX          |
| Empty string accepted as name             | Caught at registration            |
| No dot notation enforcement               | Naming conventions are guidelines |

### References

- Code Review #8, #31, #44, #59, #60, #91

---

## Part 5: Phase 1 Placeholder Interfaces

### Decision

Include placeholder interfaces for Phase 2 features with `@experimental` tags.

### Rationale

```typescript
/**
 * @experimental Phase 2 will add: addStep, addParallel, withRetry, withTimeout, onRollback
 */
export interface WorkflowBuilder {
	// Placeholder - current implementations should be no-ops
}

/**
 * @experimental Phase 2 will add: step state, retry info, progress tracking
 */
export interface WorkflowContext<TData> {
	readonly data: TData;
	readonly logger: Logger;
}
```

Placeholders establish the API shape for Phase 2 without blocking Phase 1 release.

### Won't Fix Patterns

| Pattern                                | Reason                                      |
| -------------------------------------- | ------------------------------------------- |
| Empty `WorkflowBuilder` interface      | Phase 1 scope boundary                      |
| Minimal `WorkflowContext` fields       | Will expand in Phase 2                      |
| No progress/status in `WorkflowHandle` | Requires workflow engine                    |
| No timeout in `WorkflowExecuteOptions` | Job-level BullMQ concern                    |
| Missing JSDoc examples                 | Would be speculative without implementation |

### References

- Code Review #5, #16, #41, #42, #50, #51, #52, #62, #84, #88

---

## Part 6: Documentation Style

### Decision

Use module-level JSDoc with `@template` tags; no separate README files.

### Rationale

1. `@template` tags enhance IDE tooltips and autocomplete
2. Module docs are co-located with code (easier to maintain)
3. README files prohibited by project rules (CLAUDE.md)
4. Naming conventions belong in user guides, not type JSDoc

### Won't Fix Patterns

| Pattern                                     | Reason                                 |
| ------------------------------------------- | -------------------------------------- |
| `@template` tags repeating type constraints | IDE experience enhancement             |
| No README in `types/` directory             | Module docs suffice; README prohibited |
| No naming convention docs in JSDoc          | Belongs in user guides                 |
| Comprehensive module-level JSDoc            | Self-documenting code principle        |

### References

- Code Review #17, #18, #75, #78, #83

---

## Part 7: Runtime Concerns Separate from Types

### Decision

Keep type definitions pure; runtime concerns handled by providers.

### Rationale

| Concern              | Where Handled                      |
| -------------------- | ---------------------------------- |
| Idempotency tracking | BullMQ provider via `jobId`        |
| Retry/backoff policy | `app.event()` registration options |
| Dead letter queues   | BullMQ configuration               |
| Correlation IDs      | Phase 2 tracing integration        |
| Timeouts             | BullMQ job options                 |
| Circuit breakers     | Step handler responsibility        |

Type definitions describe WHAT; providers implement HOW.

### Won't Fix Patterns

| Pattern                              | Reason                                           |
| ------------------------------------ | ------------------------------------------------ |
| No idempotency key in `EventContext` | `eventId` provided; BullMQ handles deduplication |
| No retry config in `IEventConsumer`  | Registration-time configuration                  |
| No correlation ID fields             | Phase 2 addition with `@orijs/tracing`           |
| No timeout in workflow interfaces    | BullMQ handles via `jobTimeout`                  |

### References

- Code Review #47, #48, #49, #51

---

## Part 8: Interface Design Choices

### Decision

Accept certain patterns as intentional design choices.

### Won't Fix Patterns

| Pattern                           | Reason                                             |
| --------------------------------- | -------------------------------------------------- |
| 3 parameters in `execute()`       | Within acceptable limit; third is options object   |
| No type guard functions           | YAGNI - definitions always from factories          |
| Shallow `readonly` (not deep)     | Deep readonly adds complexity; convention suffices |
| Similar Event/Workflow factories  | Acceptable duplication for clarity                 |
| No factory extension mechanism    | YAGNI - can add methods later if needed            |
| `unknown` for generic type params | Correctly bounded with `extends TSchema`           |

### References

- Code Review #20, #53, #54, #67, #85, #94

---

## Part 9: Test Naming Style

### Decision

Accept current test naming as functional and clear.

### Won't Fix Patterns

| Pattern                                          | Reason                                   |
| ------------------------------------------------ | ---------------------------------------- |
| `describe('Event.define()')` instead of behavior | Clearly communicates what's being tested |
| Category describes ('basic functionality')       | Logical grouping; tests are passing      |
| "correct" qualifier in test names                | Explicit intent clarity                  |
| lowercase variable names in tests                | Contextually appropriate                 |

### References

- Code Review #95, #96, #97, #98

---

## Part 10: Consolidated Duplicates

The following issues were identified as duplicates during code review:

| Primary | Duplicates              | Issue                                    |
| ------- | ----------------------- | ---------------------------------------- |
| #8      | #31, #44, #59, #60, #91 | Name validation deferred to registration |
| #11     | #12, #58, #81           | Type carrier `as unknown as` pattern     |
| #21     | #37, #80, #87           | Missing consumer.ts tests (now created)  |
| #22     | #38, #80, #87           | Missing emitter.ts tests (now created)   |
| #5      | #41                     | WorkflowBuilder placeholder              |
| #6      | #66                     | Utility type naming                      |
| #7      | #57                     | Event/workflow naming difference         |
| #19     | #30, #82                | Context vs Ctx naming                    |
| #29     | #58                     | Type carrier runtime behavior            |
| #32     | #50, #62, #71, #84, #88 | Placeholder interface documentation      |
| #40     | #14, #15, #68, #92      | Logger type as unknown                   |
| #85     | #89                     | Similar factory patterns                 |

---

## Consequences

### Positive

- Clear documentation of intentional patterns
- Code reviewers won't repeatedly flag these patterns
- Design rationale preserved for future maintainers
- Consistent patterns across type system

### Negative

- Must update ADR if patterns change
- New reviewers must read ADR before reviewing type system

---

## References

- Code review: `docs/work/code-review/code_review_2026-01-14_orijs-types.md`
- ADR-001: Core design principles (type carrier pattern)
- TypeScript handbook: Utility types
- Phantom types in TypeScript (Zod, io-ts patterns)
