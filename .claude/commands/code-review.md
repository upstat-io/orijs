# OriJS Framework Code Review

Perform a comprehensive code review of the OriJS framework, checking for OSS readiness, architecture violations, and code quality issues.

---

## Execution Strategy

### Phase 0: Automated Tooling

Run these commands **in parallel** to detect automated issues:

| Tool | Command | Detection |
|------|---------|-----------|
| **typecheck** | `bun run tsc --noEmit 2>&1` | Type errors, import issues |
| **tests** | `bun test 2>&1` | Failing tests, regressions |
| **ext-deps** | `grep -r "from '[^@.]" packages/ --include="*.ts" \|\| echo "CLEAN: No unexpected external imports"` | Unexpected external imports |
| **console-logs** | `grep -rn "console\\.log" packages/ --include="*.ts" \|\| echo "CLEAN: No console.log"` | Debug statements left in code |
| **commented-code** | `grep -rn "// TODO\\|// FIXME\\|// HACK\\|// XXX" packages/ --include="*.ts" \|\| echo "CLEAN: No TODO markers"` | Unresolved TODOs |
| **as-unknown** | `grep -rn "as unknown" packages/ --include="*.ts" \|\| echo "CLEAN: No type escapes"` | Type assertion escapes |
| **as-const** | `grep -rn "as const" packages/ --include="*.ts" \|\| echo "CLEAN: No as const"` | as const usage (use proper types) |

**Critical**: Each command must end with `|| true` or `|| echo` to prevent cascading failures.

### Phase 1: Manual Analysis

Launch **10 parallel Explore agents** to analyze these categories. Each agent should:
- Search relevant files using Glob and Grep
- Read suspicious files for detailed analysis
- Report findings with file:line references

#### Categories to Analyze:

**1. OSS Readiness & Framework Genericity**
Check that the framework is truly standalone and usable by anyone:
- All packages properly namespaced under `@orijs/*`
- Generic examples in documentation
- No hardcoded URLs, domains, or configuration
- No internal/private APIs exposed that shouldn't be
- License headers if required
- README.md exists for each package

**2. Architecture & Package Boundaries**
Check package dependency direction and separation:
- No circular dependencies between packages
- Proper layer separation (core doesn't depend on implementations)
- `@orijs/core` is the foundation, others depend on it
- Implementation packages (cache-redis, bullmq) don't leak into core
- No barrel files or re-exports (import from source directly)
- Each package has clear, single responsibility

**3. Dependency Injection & Container**
Check DI patterns are correctly implemented:
- Services use constructor injection
- No service locator anti-pattern (don't reach into container directly)
- Proper lifetime management (singleton vs transient)
- No hidden dependencies (all deps in constructor)
- Factory functions for complex object creation

**4. Controller & HTTP Patterns**
Check controller implementation follows patterns:
- `configure()` method is routing table only (no logic)
- Handlers are arrow function properties (not methods)
- Guards applied correctly via `r.guard()`
- Request validation uses TypeBox schemas
- Proper response handling via `ctx.json()`, `ctx.text()`
- No business logic in controllers (delegate to services)

**5. Validation & Type Safety**
Check validation patterns:
- TypeBox schemas (not Zod)
- `Static<typeof Schema>` for type inference
- No `any` types in public APIs
- No type assertions (`as Type`, `as unknown as Type`)
- Proper error types with context
- Discriminated unions where appropriate

**6. Error Handling & Exceptions**
Check error handling patterns:
- Custom error classes with context (what failed, why, IDs)
- No swallowed errors (empty catch blocks)
- No `return null` where exception is appropriate
- Error messages are actionable
- Proper async error propagation
- No `unwrap()` patterns without validation

**7. Testing Coverage & Quality**
Check test implementation:
- Test files exist for all public modules
- Test names follow `should [behavior] when [condition]`
- Strong assertions (exact values, not just `toBeDefined`)
- Descriptive variable names (not `user1`, `user2`)
- Promise chains properly handled (`.catch().finally()`)
- No `test.skip` or `test.todo` without explanation
- Mocks don't verify implementation details

**8. Code Style & Clean Code**
Check code quality:
- Functions under 20 lines (ideally)
- Max 3 parameters (use object for more)
- No boolean flag parameters
- No pattern names in identifiers ("Factory", "Manager", "Handler")
- Files under 300 lines
- No commented-out code
- No `console.log` statements

**9. Async Patterns & Performance**
Check async code patterns:
- Proper Promise handling (no floating promises)
- Promise.all for parallel operations
- No blocking operations in async context
- Proper cleanup in finally blocks
- `.catch().finally()` chain pattern (never parallel)
- No unnecessary awaits
- Efficient data structures for hot paths

**10. Documentation & Public API**
Check documentation completeness:
- JSDoc on all public exports
- Type exports for consumers
- Guide documentation in `docs/guides/`
- Examples are runnable and up-to-date
- Breaking changes documented
- API stability indicators

### Phase 2: Synthesis

After all agents complete, aggregate findings:

1. **Group by severity**: CRITICAL → HIGH → MEDIUM
2. **Cross-reference**: Link automated and manual findings
3. **Identify patterns**: Same issue across multiple files
4. **Prioritize**: By impact on OSS readiness and maintainability

---

## Severity Guide

| Level | Description | Action |
|-------|-------------|--------|
| **CRITICAL** | Blocks OSS release, security issue, or data loss risk | Must fix immediately |
| **HIGH** | Violates core principles, affects usability | Should fix before release |
| **MEDIUM** | Code quality, style, minor improvements | Fix when touching code |

### Critical Issues (Examples)
- Type assertion escapes (`as unknown as`)
- Exposed secrets or credentials
- Circular package dependencies
- Missing error handling on user input

### High Issues (Examples)
- Missing tests for public APIs
- Business logic in controllers
- Functions over 50 lines
- `any` types in public APIs
- Empty catch blocks

### Medium Issues (Examples)
- Missing JSDoc on exports
- Inconsistent naming
- TODO comments
- Suboptimal async patterns

---

## Output Format

For each finding, report:

```
[SEVERITY] Category: Issue Title
  Location: file:line
  Issue: One-line description of what's wrong
  Fix: One-line description of how to resolve
```

Group results by severity, then by category.

---

## OSS Checklist (Must Pass)

Before any release, verify:

- [ ] `bun run tsc --noEmit` has zero errors
- [ ] `bun test` all tests pass
- [ ] No `console.log` in production code
- [ ] All packages have README.md
- [ ] All public APIs have JSDoc
- [ ] Example app runs successfully
- [ ] No `as unknown` type escapes
- [ ] No secrets in repository

---

## Framework-Specific Checks

### Package Export Verification
Each package in `packages/` should:
- Export types for consumers
- Have `package.json` with correct `main`, `types`, `exports`
- Not export internal implementation details
- Have clear public API surface

### Documentation Verification
Check `docs/guides/`:
- `_llms.md` index is up-to-date
- All guides reference current API
- Code examples compile and run
- No project-specific examples (keep generic)

### Example App Verification
Check `example/`:
- Uses `@orijs/orijs` as dependency (not relative imports)
- Demonstrates framework patterns correctly
- Runs with `bun run example/src/app.ts`
- Shows realistic but generic use case
