# ADR-005: Application Class Centralization

## Status

Accepted

## Context

Code reviews repeatedly flag the `Application` class (~900 lines) as an SRP violation because it handles multiple concerns:

- Provider registration and DI configuration
- Event/workflow coordinator management
- HTTP server lifecycle (listen/stop)
- Route compilation
- Logger configuration
- Cache configuration
- Deprecated API compatibility

This issue has been raised in multiple code reviews, creating noise and wasted review cycles.

## Decision

**The Application class is intentionally centralized and this is NOT an SRP violation for framework bootstrap code.**

Framework Application/Bootstrap classes are fundamentally different from domain classes:

1. **Single Actor**: The Application class serves ONE actor - the framework consumer who calls `app.provider()`, `app.listen()`, etc. All methods serve the same stakeholder.

2. **Coordination, Not Logic**: The class coordinates other components (coordinators, providers, server) but contains minimal business logic itself. It's a facade/orchestrator.

3. **Expected Pattern**: Every major framework has a central bootstrap class:
   - NestJS: `NestFactory` + `INestApplication`
   - Express: `Application`
   - Fastify: `FastifyInstance`
   - Spring: `SpringApplication`

4. **Extraction Cost > Benefit**: Splitting into LoggerCoordinator, BootstrapCoordinator, etc. would:
   - Add indirection without simplifying the code
   - Make the bootstrap flow harder to follow
   - Create more files to navigate
   - Not reduce cognitive load (user still needs to understand all pieces)

## Code Review Findings (WON'T FIX)

The following patterns should NOT be flagged in code reviews:

| Pattern                                 | Reason                                               |
| --------------------------------------- | ---------------------------------------------------- |
| Application class >300 lines            | Bootstrap/facade classes are exempt from line limits |
| Application handles multiple "concerns" | Coordination is the single responsibility            |
| Application has many public methods     | Fluent API for configuration is intentional          |

## Consequences

### Positive

- Code reviews stop flagging this repeatedly
- Framework consumers have a single entry point
- Bootstrap flow is easy to follow in one file

### Negative

- Application.ts requires more scrolling to read
- New contributors might initially find it large

## References

- SRP clarification: "A class should have only one reason to change" means one actor/stakeholder, not one method or concept
- Uncle Bob's clarification: https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html
