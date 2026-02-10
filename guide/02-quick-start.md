# Chapter 2: Quick Start

## Installation

OriJS requires Bun v1.1.0 or later. If you don't have Bun installed:

```bash
curl -fsSL https://bun.sh/install | bash
```

Create a new project and install OriJS:

```bash
mkdir my-api && cd my-api
bun init -y
bun add @orijs/core @orijs/orijs
```

That's it. No CLI scaffolding tool, no project generator, no boilerplate repository. OriJS is a library, not a framework that owns your project structure.

**Why no CLI?** Scaffolding tools generate code you don't understand. They create files you don't need, with patterns you haven't chosen, using conventions you haven't learned. With OriJS, you build your project file by file, understanding every line. When something goes wrong, you know exactly where to look because you wrote it.

## Your First Application

Create `src/app.ts`:

```typescript
import { Ori } from '@orijs/orijs';

const app = Ori.create();

app.controller('/', class {
  configure(r) {
    r.get('/', () => new Response('Hello, OriJS!'));
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

Run it:

```bash
bun run src/app.ts
```

Visit `http://localhost:3000` and you'll see "Hello, OriJS!". That's a working HTTP server in 10 lines.

Let's break down what happened:

1. **`Ori.create()`** creates an application instance. This sets up the DI container, lifecycle manager, and routing coordinator.
2. **`app.controller('/', class { ... })`** registers an inline controller at the root path. The string `'/'` is the route prefix — all routes defined inside will be relative to it.
3. **`configure(r)`** is called by the framework during bootstrap. The `r` parameter is a `RouteBuilder` — a fluent API for defining HTTP routes.
4. **`r.get('/', handler)`** registers a GET handler at the controller's prefix path.
5. **`app.listen(3000)`** starts Bun's native HTTP server on port 3000.

## A Real Application

The inline example above works for demos, but real applications need structure. Let's build a simple user API with proper separation of concerns.

### Project Structure

```
my-api/
├── src/
│   ├── app.ts                    # Application entry point
│   ├── providers.ts              # Extension functions (DI registration)
│   ├── users/
│   │   ├── user.controller.ts    # HTTP layer
│   │   ├── user.service.ts       # Business logic
│   │   └── user.repository.ts    # Data access
│   └── types/
│       └── user.types.ts         # Shared types
├── package.json
└── tsconfig.json
```

**Why this structure?** OriJS doesn't enforce a directory layout — that's a deliberate decision. NestJS forces you into a `module/controller/service/dto` structure with CLI-generated files. OriJS lets you organize code however makes sense for your team. The structure above groups by feature (`users/`) with shared types pulled out. As your app grows, you might adopt domain-driven directories, or keep a flat structure — your call.

### Define Types

```typescript
// src/types/user.types.ts
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}
```

### Data Access Layer

```typescript
// src/users/user.repository.ts
import type { User } from '../types/user.types';

export class UserRepository {
  private users: Map<string, User> = new Map();

  public async findAll(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  public async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  public async create(name: string, email: string): Promise<User> {
    const user: User = {
      id: crypto.randomUUID(),
      name,
      email,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  public async delete(id: string): Promise<boolean> {
    return this.users.delete(id);
  }
}
```

### Business Logic Layer

```typescript
// src/users/user.service.ts
import type { User } from '../types/user.types';
import type { UserRepository } from './user.repository';

export class UserService {
  constructor(private repo: UserRepository) {}

  public async getUsers(): Promise<User[]> {
    return this.repo.findAll();
  }

  public async getUser(id: string): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new Error(`User not found: ${id}`);
    }
    return user;
  }

  public async createUser(name: string, email: string): Promise<User> {
    // Business rule: email must be unique
    const existing = await this.repo.findAll();
    if (existing.some(u => u.email === email)) {
      throw new Error(`Email already in use: ${email}`);
    }
    return this.repo.create(name, email);
  }

  public async deleteUser(id: string): Promise<void> {
    const deleted = await this.repo.delete(id);
    if (!deleted) {
      throw new Error(`User not found: ${id}`);
    }
  }
}
```

### HTTP Layer

```typescript
// src/users/user.controller.ts
import type { OriController, RequestContext, RouteBuilder } from '@orijs/orijs';
import type { UserService } from './user.service';

export class UserController implements OriController {
  constructor(private userService: UserService) {}

  public configure(r: RouteBuilder): void {
    r.get('/', this.list);
    r.get('/:id', this.getById);
    r.post('/', this.create);
    r.delete('/:id', this.remove);
  }

  private list = async (ctx: RequestContext) => {
    const users = await this.userService.getUsers();
    return Response.json(users);
  };

  private getById = async (ctx: RequestContext) => {
    const user = await this.userService.getUser(ctx.params.id);
    return Response.json(user);
  };

  private create = async (ctx: RequestContext) => {
    const { name, email } = await ctx.json<{ name: string; email: string }>();
    const user = await this.userService.createUser(name, email);
    return Response.json(user, { status: 201 });
  };

  private remove = async (ctx: RequestContext) => {
    await this.userService.deleteUser(ctx.params.id);
    return new Response(null, { status: 204 });
  };
}
```

**Key patterns to notice:**

- **Handlers are arrow functions**, not methods. This preserves `this` binding without needing `.bind()` in the constructor. In NestJS, methods work because the framework manages `this` through the DI container. In OriJS, handlers are plain functions — arrow functions are the cleanest solution.

- **`ctx.params.id`** gives you path parameters directly. No `@Param('id')` decorator needed.

- **`ctx.json<T>()`** parses the request body. It uses a safe JSON parser that prevents prototype pollution attacks — something you'd need a separate library for in Express.

- **The controller implements `OriController`**. This is a TypeScript interface that requires a `configure(r: RouteBuilder)` method. It's optional — you could skip the `implements` clause and it would still work — but it gives you autocomplete and compile-time checking.

### Extension Functions (DI Registration)

```typescript
// src/providers.ts
import type { Application } from '@orijs/orijs';
import { UserRepository } from './users/user.repository';
import { UserService } from './users/user.service';
import { UserController } from './users/user.controller';

export function addUsers(app: Application): Application {
  return app
    .provider(UserRepository)
    .provider(UserService, [UserRepository])
    .controller('/users', UserController, [UserService]);
}
```

**This is the most important file to understand.** The extension function is where you tell OriJS how to wire everything together:

- `app.provider(UserRepository)` — registers `UserRepository` with no dependencies. The DI container will create a single instance when first requested.
- `app.provider(UserService, [UserRepository])` — registers `UserService` and tells the container it needs a `UserRepository` injected into its constructor.
- `app.controller('/users', UserController, [UserService])` — registers the controller at the `/users` prefix with `UserService` as a dependency.

The deps array `[UserRepository]` must match the constructor signature exactly — both in types and order. TypeScript enforces this at compile time. If you add a parameter to the constructor but forget to update the deps array, you get a type error, not a runtime crash.

**Why extension functions instead of NestJS modules?** See the detailed comparison in [Chapter 3: Core Concepts](./03-core-concepts.md). The short version: extension functions are plain TypeScript functions with no magic, no decorator metadata, and no circular dependency issues.

### Application Entry Point

```typescript
// src/app.ts
import { Ori } from '@orijs/orijs';
import { addUsers } from './providers';

const app = Ori.create();

app.use(addUsers);

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

The entry point is clean and declarative. You can read it top to bottom and understand the entire application: create an app, add user functionality, start listening.

### Test It

```bash
bun run src/app.ts
```

```bash
# Create a user
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@example.com"}'

# List users
curl http://localhost:3000/users

# Get a specific user (use the ID from the create response)
curl http://localhost:3000/users/<id>

# Delete a user
curl -X DELETE http://localhost:3000/users/<id>
```

## Adding Validation

The example above has a problem: the `POST /users` endpoint accepts any JSON body without validation. Someone could send `{"foo": 42}` and your service would try to create a user with `undefined` name and email.

Install the validation provider:

```bash
bun add @orijs/validation
```

Update the controller to validate request bodies:

```typescript
// src/users/user.controller.ts
import { Type } from '@sinclair/typebox';
import type { OriController, RequestContext, RouteBuilder } from '@orijs/orijs';
import type { UserService } from './user.service';

const CreateUserBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  email: Type.String({ format: 'email' }),
});

export class UserController implements OriController {
  constructor(private userService: UserService) {}

  public configure(r: RouteBuilder): void {
    r.get('/', this.list);
    r.get('/:id', this.getById);
    r.post('/', this.create, { body: CreateUserBody });
    r.delete('/:id', this.remove);
  }

  private list = async (ctx: RequestContext) => {
    const users = await this.userService.getUsers();
    return Response.json(users);
  };

  private getById = async (ctx: RequestContext) => {
    const user = await this.userService.getUser(ctx.params.id);
    return Response.json(user);
  };

  private create = async (ctx: RequestContext) => {
    // ctx.body is now typed as { name: string; email: string }
    // and guaranteed to be valid — the framework rejects invalid bodies
    // before your handler runs
    const user = await this.userService.createUser(ctx.body.name, ctx.body.email);
    return Response.json(user, { status: 201 });
  };

  private remove = async (ctx: RequestContext) => {
    await this.userService.deleteUser(ctx.params.id);
    return new Response(null, { status: 204 });
  };
}
```

Now if someone sends an invalid body, they get a 400 response with validation errors — and your handler never executes. The validated body is available on `ctx.body` with full TypeScript types inferred from the schema.

**TypeBox is a provider.** If you prefer Zod, you can write a validation provider that wraps Zod and plug it in. The framework doesn't know or care what validation library runs behind the interface. See [Chapter 4: The Provider Architecture](./04-the-provider-architecture.md) for how this works.

## Adding a Guard

Let's protect the delete endpoint with a simple API key guard:

```typescript
// src/guards/api-key.guard.ts
import type { Guard, RequestContext } from '@orijs/orijs';

export class ApiKeyGuard implements Guard {
  public async canActivate(ctx: RequestContext): Promise<boolean> {
    const apiKey = ctx.request.headers.get('X-API-Key');
    return apiKey === Bun.env.API_KEY;
  }
}
```

Register it on the route:

```typescript
// In user.controller.ts configure()
r.delete('/:id', this.remove);
r.guard(ApiKeyGuard);  // Only applies to the DELETE route above
```

Guards are simple: return `true` to allow the request, `false` to deny it (403 Forbidden). They run before validation and before your handler. See [Chapter 7: Guards & Authentication](./07-guards-and-authentication.md) for authentication patterns, role-based access, and guard composition.

## TypeScript Configuration

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"]
}
```

**Notable: no `experimentalDecorators` or `emitDecoratorMetadata`.** OriJS doesn't need them. This means:
- Faster TypeScript compilation (no metadata emission)
- Compatible with TC39 Stage 3 decorators if you use them elsewhere
- No `reflect-metadata` polyfill needed
- Smaller output files

## Installing Provider Packages

OriJS's core is deliberately minimal. You add capabilities by installing provider packages:

```bash
# Validation (TypeBox-based)
bun add @orijs/validation

# Configuration management
bun add @orijs/config

# Caching (in-memory + Redis)
bun add @orijs/cache
bun add @orijs/cache-redis  # For Redis-backed caching

# Events (BullMQ-based persistent events)
bun add @orijs/events
bun add @orijs/bullmq       # BullMQ provider

# Workflows (Saga pattern)
bun add @orijs/workflows

# WebSockets
bun add @orijs/websocket
bun add @orijs/websocket-redis  # For horizontal scaling

# Logging (Pino-inspired)
bun add @orijs/logging

# Data mapping (SQL result mapping)
bun add @orijs/mapper

# Testing utilities
bun add -d @orijs/test-utils
```

You don't need all of these. Install only what you use. Each package is a provider that plugs into the framework through a well-defined interface. If you need events but prefer RabbitMQ over BullMQ, you can write a RabbitMQ event provider and skip `@orijs/bullmq` entirely.

## Project Structure Recommendations

OriJS doesn't enforce structure, but here are patterns that scale well:

### Small Applications (1-5 controllers)

```
src/
├── app.ts
├── providers.ts
├── users/
│   ├── user.controller.ts
│   ├── user.service.ts
│   └── user.repository.ts
├── posts/
│   ├── post.controller.ts
│   ├── post.service.ts
│   └── post.repository.ts
├── guards/
│   └── auth.guard.ts
└── types/
    ├── user.types.ts
    └── post.types.ts
```

### Medium Applications (5-20 controllers)

```
src/
├── app.ts
├── providers/
│   ├── index.ts          # Combines all extension functions
│   ├── users.ts          # addUsers extension function
│   ├── posts.ts          # addPosts extension function
│   └── infrastructure.ts # addDatabase, addCache, etc.
├── domain/
│   ├── users/
│   │   ├── user.controller.ts
│   │   ├── user.service.ts
│   │   ├── user.repository.ts
│   │   └── user.types.ts
│   └── posts/
│       ├── post.controller.ts
│       ├── post.service.ts
│       ├── post.repository.ts
│       └── post.types.ts
├── infrastructure/
│   ├── database.ts
│   ├── cache.ts
│   └── events.ts
└── guards/
    ├── auth.guard.ts
    └── admin.guard.ts
```

### Large Applications (Monorepo)

```
packages/
├── types-shared/       # Shared TypeScript types
├── db-shared/          # Database services
├── repository-shared/  # Repository layer
├── services-shared/    # Business logic
└── test-infrastructure/ # Test fixtures
apps/
├── api-server/         # HTTP API
│   ├── src/
│   │   ├── app.ts
│   │   └── providers.ts
│   └── package.json
└── worker/             # Background jobs
    ├── src/
    │   ├── app.ts
    │   └── consumers.ts
    └── package.json
```

The key principle: **group by feature, not by technical layer.** A `users/` directory with controller, service, and repository is easier to navigate than separate `controllers/`, `services/`, and `repositories/` directories where related files are scattered.

## What's Next

You now have a working OriJS application with controllers, services, dependency injection, validation, and guards. In the next chapter, we'll go deeper into OriJS's core concepts — the application lifecycle, how dependency injection actually works under the hood, AppContext, and extension functions.

[Next: Core Concepts →](./03-core-concepts.md)
