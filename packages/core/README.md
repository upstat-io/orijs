# @orijs/core

Core framework package for OriJS - provides the application builder, dependency injection container, HTTP routing, and WebSocket support.

## Installation

```bash
bun add @orijs/core
```

Or install the full framework:

```bash
bun add @orijs/orijs
```

## Quick Start

```typescript
import { Ori } from '@orijs/core';
import type { OriController, RouteBuilder } from '@orijs/core';

class ApiController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/health', () => Response.json({ status: 'ok' }));
  }
}

Ori.create()
  .controller('/api', ApiController)
  .listen(3000);
```

## Features

- **Application Builder** - Fluent API for configuring your application
- **Dependency Injection** - Constructor-based DI with automatic resolution
- **HTTP Routing** - Type-safe routing with guards, interceptors, and validation
- **WebSocket Support** - Built-in WebSocket handling with typed messages
- **Lifecycle Management** - Startup, ready, and shutdown hooks

## Core Concepts

### Application

```typescript
const app = Ori.create()
  .provider(DatabaseService)
  .provider(UserService, [DatabaseService])
  .controller('/api', ApiController, [UserService])
  .listen(3000);
```

### Controllers

```typescript
class UserController implements OriController {
  constructor(private userService: UserService) {}

  configure(r: RouteBuilder) {
    r.get('/users', this.list);
    r.post('/users', this.create, { body: CreateUserSchema });
  }

  private list = async (ctx: RequestContext) => {
    return Response.json(await this.userService.list());
  };

  private create = async (ctx: RequestContext) => {
    const user = await this.userService.create(ctx.body);
    return Response.json(user, { status: 201 });
  };
}
```

### Guards

```typescript
class AuthGuard implements Guard {
  canActivate(ctx: RequestContext): boolean {
    const token = ctx.request.headers.get('Authorization');
    return token?.startsWith('Bearer ') ?? false;
  }
}

// Apply to routes
r.guard(AuthGuard).get('/protected', this.protectedHandler);
```

### Lifecycle Hooks

```typescript
const app = Ori.create();

app.context.onStartup(async () => {
  await database.connect();
});

app.context.onShutdown(async () => {
  await database.disconnect();
});
```

## Documentation

See the [full documentation](../../docs/guides/) for detailed guides on:

- [Getting Started](../../docs/guides/getting-started.md)
- [Core Concepts](../../docs/guides/core-concepts.md)
- [HTTP Routing](../../docs/guides/http-routing.md)
- [API Reference](../../docs/guides/api-reference.md)

## License

MIT
