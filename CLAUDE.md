# OriJS Development Rules

ALWAYS USE ultrathink

---

## CRITICAL: Standalone Framework

**OriJS is a standalone, self-contained framework.** It is designed to be extracted to its own repository.

### Standalone Rules

1. **No external dependencies on parent monorepo** - OriJS must NOT depend on any `@upstat/*` packages
2. **Self-contained packages** - All packages use `@orijs/*` namespace
3. **Own test infrastructure** - Use `@orijs/test-utils` for tests
4. **Own documentation** - All docs live in `docs/`

### Package Namespace

All OriJS packages are published under `@orijs/*`:

- `@orijs/core` - Application, Container, DI
- `@orijs/logging` - Logger, transports
- `@orijs/config` - Configuration system
- `@orijs/validation` - TypeBox validation
- `@orijs/mapper` - Data mappers
- `@orijs/events` - Event system
- `@orijs/workflows` - Workflow/saga orchestration
- `@orijs/cache` - Caching interfaces
- `@orijs/cache-redis` - Redis cache implementation
- `@orijs/bullmq` - BullMQ event and workflow providers
- `@orijs/orijs` - Convenience re-export of all packages
- `@orijs/test-utils` - Test infrastructure (Redis containers)

### Documentation

**For how to USE OriJS**: See [docs/guides/\_llms.md](./docs/guides/_llms.md) - AI navigation index to all documentation.

---

## Quick Commands

- `bun run tsc --noEmit` - Type check
- `bun test` - Run tests
- `bun run example/src/app.ts` - Run example app

## Bun First

Default to Bun instead of Node.js:

- `bun <file>` instead of `node` or `ts-node`
- `bun test` instead of `jest` or `vitest`
- `bun install` instead of `npm install`
- `bunx <pkg>` instead of `npx`
- Bun loads `.env` automatically

### Bun APIs

- `Bun.serve()` for HTTP/WebSocket (not express)
- `Bun.file()` over `node:fs` readFile/writeFile
- `Bun.$\`cmd\`` instead of execa

## Repository Structure

```
packages/              # Modular packages (all @orijs/*)
├── core/              # Application, Container, DI, HTTP
├── logging/           # Logger, transports
├── config/            # Configuration system
├── validation/        # TypeBox schemas
├── mapper/            # Data mappers
├── events/            # Event system
├── workflows/         # Workflow/saga orchestration
├── cache/             # Cache interfaces
├── cache-redis/       # Redis cache implementation
├── bullmq/            # BullMQ event and workflow providers
├── orijs/             # Convenience re-export
└── test-utils/        # Test infrastructure

docs/                  # Framework documentation
├── decisions/         # Architecture Decision Records
└── guides/            # User guides
    ├── _llms.md       # AI navigation index
    ├── _index.md      # Guide overview
    ├── getting-started.md
    ├── core-concepts.md
    ├── http-routing.md
    ├── validation.md
    ├── mapper.md
    ├── events.md
    ├── workflows.md
    ├── caching.md
    ├── logging.md
    ├── configuration.md
    ├── testing.md
    ├── advanced-patterns.md
    ├── api-reference.md
    ├── troubleshooting.md
    └── migration-from-nestjs.md

example/               # Standalone example app
├── package.json       # @orijs/orijs as dependency
└── src/
    ├── controllers/
    ├── services/
    └── app.ts

benchmarks/            # Performance benchmarks
├── run-all.ts
├── runner.ts
└── scenarios/
```

**Package Structure**: Each package in `packages/` has its own `package.json`, `src/`, and `__tests__/` directories.

## Code Rules

### Patterns

- Name by domain responsibility, never by pattern (no "Strategy", "Factory" in names)
- YAGNI: add abstraction at 2+ concrete cases, not before
- One implementation doesn't need an interface
- No re-exports or barrel files (import from source directly)
- No `as const` (use proper type definitions)
- No `as unknown` type assertions

### Functions

- No boolean flag parameters (split function instead)
- One abstraction level per function
- No hidden side effects
- Don't mutate inputs, return new values
- Max 3 parameters; use object for more
- Small functions (under 20 lines ideal)

### SRP Detection

- Constructor 6+ deps → too many responsibilities
- File >300 lines → multiple concerns
- Method names with "And" → split
- Class name has "Manager"/"Handler"/"Processor" → warning sign

### Error Handling

- Exceptions over return codes
- Context in exceptions (what failed, why, relevant IDs)
- Don't return null where avoidable (empty collection, throw, or Optional)
- Don't pass null as parameters

### Comments

- Code should be self-documenting where possible
- Comments explain "why", not "what"
- No commented-out code
- No redundant comments that repeat the code
- Use JSDoc for public APIs

## Testing

Use `bun test` with three layers:

| Layer      | Purpose                | Mock What               |
| ---------- | ---------------------- | ----------------------- |
| Unit       | Class logic            | All dependencies        |
| Functional | Component interactions | Outermost boundary only |
| E2E        | Complete flows         | Only external APIs      |

### Test Rules

1. Strong assertions only (exact values, not just `toBeDefined`)
2. Test names: `should [behavior] when [condition]`
3. Variables: descriptive names (`adminUser`), not `user1`/`user2`
4. Never modify tests just to make them pass - understand first

## Workflow

1. Find 2+ examples from existing code first
2. Write failing test
3. Implement minimal code
4. Run typecheck
5. Refactor if needed

### Broken Window Policy

Before completing ANY task:

1. `bun run tsc --noEmit` - ALL errors resolved
2. `bun test` - ALL tests passing
3. No broken imports
4. No `console.log` statements left
5. No commented-out code

## Promise .finally() Chaining (CRITICAL)

**NEVER use parallel promise handlers. ALWAYS chain them.**

```typescript
// WRONG - parallel handlers create unhandled rejection:
promise.catch(() => {});
promise.finally(() => cleanup());
// The .finally() returns a NEW promise that rejects - unhandled!

// CORRECT - chained handlers:
promise.catch(() => {}).finally(() => cleanup());
// Single chain, fully handled
```

**Why this matters:**

- `.finally()` returns a NEW promise that also rejects if the original rejects
- Parallel handlers `promise.catch(); promise.finally();` create two separate chains
- The `.finally()` chain has no catch handler = unhandled rejection
- Bun's test runner fails tests with unhandled rejections
- This is NOT a Bun bug - it's correct Promise behavior (Node.js does the same)

**Common pattern for timeout cleanup:**

```typescript
const promise = new Promise((resolve, reject) => {
	state.resolve = resolve;
	state.reject = reject;
});

const timeout = setTimeout(() => state.reject(new Error('timeout')), 30000);

// CORRECT: Chain catch and finally
promise.catch(() => {}).finally(() => clearTimeout(timeout));

// Return original promise for caller to await
return { result: () => promise };
```
