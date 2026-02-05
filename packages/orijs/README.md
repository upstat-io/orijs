# @orijs/orijs

The OriJS Framework meta-package - a lightweight, high-performance TypeScript backend framework for Bun.

## Installation

```bash
bun add @orijs/orijs
```

## Quick Start

```typescript
import { Ori } from '@orijs/orijs';
import type { OriController, RouteBuilder } from '@orijs/orijs';

class ApiController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/health', () => Response.json({ status: 'ok' }));
    r.get('/users', this.listUsers);
  }

  private listUsers = async () => {
    return Response.json([{ id: '1', name: 'Alice' }]);
  };
}

Ori.create()
  .controller('/api', ApiController)
  .listen(3000);
```

## What's Included

This package re-exports all core OriJS modules:

| Package | Description |
|---------|-------------|
| `@orijs/core` | Application builder, DI, routing, WebSocket |
| `@orijs/logging` | Structured logging with transports |
| `@orijs/config` | Configuration with validation |
| `@orijs/validation` | TypeBox schemas and validation |
| `@orijs/mapper` | Database row to object mapping |
| `@orijs/events` | Event system with handlers |
| `@orijs/workflows` | Workflow/saga orchestration |
| `@orijs/cache` | Caching with entity registry |
| `@orijs/websocket` | WebSocket support |

## Individual Packages

For smaller bundle sizes, import from individual packages:

```typescript
// Instead of
import { Ori, Logger, CacheService } from '@orijs/orijs';

// Use individual packages
import { Ori } from '@orijs/core';
import { Logger } from '@orijs/logging';
import { CacheService } from '@orijs/cache';
```

## Features

- **Bun-Native** - Built specifically for the Bun runtime
- **Type-Safe** - Full TypeScript support throughout
- **No Decorators** - Clean, explicit configuration
- **Dependency Injection** - Constructor-based DI
- **Modular** - Use only what you need

## Documentation

See the [Getting Started Guide](../../docs/guides/getting-started.md) for a complete tutorial.

## License

MIT
