# Chapter 2: Quick Start

## Installation

OriJS requires Bun v1.1.0 or later. If you don't have Bun installed:

```bash
curl -fsSL https://bun.sh/install | bash
```

Create a new project and install OriJS:

```bash
mkdir my-app && cd my-app
bun init -y
bun add @orijs/orijs
```

That's it. No CLI scaffolding tool, no template generator, no boilerplate repo. OriJS applications are just TypeScript files that import from `@orijs/orijs`.

## Your First Application

Create `src/app.ts`:

```typescript
import { Ori } from '@orijs/orijs';
import type { OriController, RouteBuilder, RequestContext } from '@orijs/orijs';

class HealthController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/health').handle(this.checkHealth);
  }

  private checkHealth = async (ctx: RequestContext) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  };
}

const app = Ori.create()
  .controller(HealthController)
  .listen(3000, () => {
    console.log('Server running at http://localhost:3000');
  });
```

Run it:

```bash
bun run src/app.ts
```

Test it:

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2024-01-15T10:30:00.000Z"}
```

Let's break down what just happened:

1. **`Ori.create()`** creates a new application instance. This sets up the DI container, request pipeline, and lifecycle management.

2. **`.controller(HealthController)`** registers the controller. Since `HealthController` has no constructor dependencies, we don't need to list any.

3. **`.listen(3000)`** compiles all routes into Bun's native route format and starts the HTTP server. Under the hood, this creates a `Bun.serve()` instance with optimized route matching.

4. **`HealthController.configure(r)`** is called during compilation. The `RouteBuilder` provides a fluent API for defining routes. `r.get('/health')` registers a GET handler at `/health`.

5. **The handler returns a plain object.** OriJS automatically serializes it to JSON with the appropriate `Content-Type: application/json` header and a `200` status code. No need for `res.json()` or `return Response.json()`.

## Adding a Service

Real applications separate business logic from HTTP handling. Let's add a greeting service:

```typescript
import { Ori } from '@orijs/orijs';
import type { OriController, RouteBuilder, RequestContext } from '@orijs/orijs';

// Service — contains business logic
class GreetingService {
  public greet(name: string): string {
    const hour = new Date().getHours();
    if (hour < 12) return `Good morning, ${name}!`;
    if (hour < 18) return `Good afternoon, ${name}!`;
    return `Good evening, ${name}!`;
  }
}

// Controller — handles HTTP, delegates to service
class GreetingController implements OriController {
  constructor(private greetingService: GreetingService) {}

  configure(r: RouteBuilder) {
    r.get('/greet/:name').handle(this.greet);
  }

  private greet = async (ctx: RequestContext) => {
    const name = ctx.params.name;
    const message = this.greetingService.greet(name);
    return { message };
  };
}

Ori.create()
  .provider(GreetingService)                           // Register service
  .controller(GreetingController, [GreetingService])   // Register controller with deps
  .listen(3000);
```

```bash
curl http://localhost:3000/greet/world
# {"message":"Good afternoon, world!"}
```

Key points:

- **`.provider(GreetingService)`** registers `GreetingService` in the DI container. Since it has no dependencies, the deps array is omitted.
- **`.controller(GreetingController, [GreetingService])`** registers the controller and declares its dependency on `GreetingService`. The framework will instantiate `GreetingService` and pass it to `GreetingController`'s constructor.
- **The deps array matches constructor parameter order.** `GreetingController`'s constructor takes `GreetingService` as its first parameter, so `[GreetingService]` is the deps array. This is how OriJS does dependency injection without decorators or reflect-metadata.

## Adding Validation

Let's create an endpoint that accepts a JSON body with validation:

```typescript
import { Type } from '@orijs/validation';
import type { RequestContext } from '@orijs/orijs';

const CreateGreetingBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 50 }),
  style: Type.Optional(
    Type.Union([Type.Literal('formal'), Type.Literal('casual')])
  ),
});

class GreetingController implements OriController {
  constructor(private greetingService: GreetingService) {}

  configure(r: RouteBuilder) {
    r.get('/greet/:name').handle(this.greet);

    r.post('/greet')
      .validate({ body: CreateGreetingBody })
      .handle(this.createGreeting);
  }

  private greet = async (ctx: RequestContext) => {
    return { message: this.greetingService.greet(ctx.params.name) };
  };

  private createGreeting = async (ctx: RequestContext) => {
    // ctx.body is typed as { name: string; style?: 'formal' | 'casual' }
    const { name, style } = ctx.body;
    const message = style === 'formal'
      ? `Dear ${name}, how do you do?`
      : this.greetingService.greet(name);
    return ctx.response.created({ message });
  };
}
```

```bash
# Valid request
curl -X POST http://localhost:3000/greet \
  -H 'Content-Type: application/json' \
  -d '{"name": "Alice", "style": "formal"}'
# {"message":"Dear Alice, how do you do?"}

# Invalid request — name too short
curl -X POST http://localhost:3000/greet \
  -H 'Content-Type: application/json' \
  -d '{"name": ""}'
# 400 Bad Request with validation error details
```

The `.validate()` method:
- Parses the request body as JSON
- Validates it against the TypeBox schema
- Returns a 400 error with detailed validation messages if invalid
- Types the `ctx.body` property based on the schema (full type inference, no manual typing needed)

## Project Structure

As your application grows, organize code by feature:

```
my-app/
├── src/
│   ├── app.ts                    # Application entry point
│   ├── users/
│   │   ├── user.controller.ts    # HTTP handlers
│   │   ├── user.service.ts       # Business logic
│   │   ├── user.repository.ts    # Data access
│   │   └── user.types.ts         # TypeBox schemas & types
│   ├── auth/
│   │   ├── auth.guard.ts         # Authentication guard
│   │   ├── auth.service.ts       # Auth business logic
│   │   └── auth.types.ts         # Auth types
│   └── shared/
│       ├── database.ts           # Database connection
│       └── logging.ts            # Logger configuration
├── tests/
│   ├── users/
│   │   ├── user.controller.spec.ts
│   │   └── user.service.spec.ts
│   └── preload.ts                # Test setup
├── package.json
├── tsconfig.json
└── bunfig.toml
```

And compose the app from feature-based extension functions:

```typescript
// src/users/index.ts
import type { OriApplication } from '@orijs/orijs';

export function useUsers(app: OriApplication) {
  app
    .provider(UserRepository, [DatabaseService])
    .provider(UserService, [UserRepository])
    .controller(UserController, [UserService]);
}
```

```typescript
// src/auth/index.ts
import type { OriApplication } from '@orijs/orijs';

export function useAuth(app: OriApplication) {
  app
    .provider(AuthService, [UserRepository])
    .globalGuard(AuthGuard, [AuthService]);
}
```

```typescript
// src/app.ts
import { Ori } from '@orijs/orijs';
import { useUsers } from './users';
import { useAuth } from './auth';
import { useDatabase } from './shared/database';

Ori.create()
  .use(useDatabase)
  .use(useAuth)
  .use(useUsers)
  .listen(3000);
```

This pattern keeps the entry point clean and each feature self-contained. Extension functions are just plain functions — they can be conditionally applied, tested independently, and reused across applications.

## Logging

OriJS includes a built-in structured logger inspired by Pino:

```typescript
import { Ori } from '@orijs/orijs';

Ori.create()
  .logger({
    level: 'info',
    transport: 'pretty',  // Human-readable for development
  })
  .controller(HealthController)
  .listen(3000);
```

In production, use JSON transport for log aggregation:

```typescript
Ori.create()
  .logger({
    level: 'warn',
    transport: 'json',  // Structured JSON for production
  })
  // ...
```

The logger automatically includes request context (request ID, path, method) in every log line within request handlers, using `AsyncLocalStorage` for zero-overhead context propagation.

## TypeScript Configuration

A recommended `tsconfig.json` for OriJS projects:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

Note that `experimentalDecorators` and `emitDecoratorMetadata` are **not needed**. This is intentional — OriJS doesn't use decorators, so your TypeScript compilation is faster and your output is cleaner.

## What's Next

Now that you have a running application, the next chapter explores OriJS's core concepts in depth: the application lifecycle, dependency injection container, and the `AppContext` that ties everything together.

[Previous: Introduction ←](./01-introduction.md) | [Next: Core Concepts →](./03-core-concepts.md)
