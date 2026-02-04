# OriJS

A NestJS-inspired web framework for Bun — without the decorators.

## Philosophy

OriJS combines the best ideas from modern web frameworks and implements them using TypeScript interfaces and a fluent builder API instead of decorators.

**Inspiration:**

| Framework   | Ideas Borrowed                                                    |
| ----------- | ----------------------------------------------------------------- |
| **NestJS**  | Dependency injection, guards, interceptors, organized controllers |
| **Elysia**  | End-to-end type safety, schema validation options object          |
| **Hono**    | Lightweight middleware, simple composable API                     |
| **Fastify** | Schema-based validation, hooks, serialization                     |
| **Pino**    | Structured logging with child loggers and transports              |

**Why no decorators?**

- Decorators are still experimental in TypeScript
- The TC39 standard decorators are incompatible with legacy decorators (which NestJS uses)
- `reflect-metadata` adds runtime overhead
- Explicit configuration is easier to test and debug

## Status

| Feature                       | Status      |
| ----------------------------- | ----------- |
| Controllers (interface-based) | ✅ Complete |
| Fluent RouteBuilder API       | ✅ Complete |
| Dependency Injection          | ✅ Complete |
| Guards (auth/authz)           | ✅ Complete |
| Interceptors (onion model)    | ✅ Complete |
| Guard/Interceptor inheritance | ✅ Complete |
| Structured Logging            | ✅ Complete |
| Schema Validation             | ✅ Complete |
| Exception Filters             | 🔜 Planned  |
| Modules                       | 🔜 Planned  |
| WebSocket Support             | 🔜 Planned  |

## Documentation

For detailed documentation, see the [`docs/guides/`](./docs/guides/) folder:

- **[Getting Started](./docs/guides/getting-started.md)** - Installation, first app, project structure
- **[Core Concepts](./docs/guides/core-concepts.md)** - Controllers, DI, guards, interceptors in depth
- **[HTTP Routing](./docs/guides/http-routing.md)** - Route patterns, parameters, middleware
- **[Validation](./docs/guides/validation.md)** - TypeBox schemas, request validation
- **[Mappers](./docs/guides/mapper.md)** - Database-to-domain mapping
- **[Events](./docs/guides/events.md)** - Event-driven architecture, handlers, providers
- **[Workflows](./docs/guides/workflows.md)** - Saga-style workflows with BullMQ
- **[Caching](./docs/guides/caching.md)** - Cache-aside pattern, singleflight, Redis provider
- **[Logging](./docs/guides/logging.md)** - Structured logging, transports, request context
- **[Configuration](./docs/guides/configuration.md)** - Environment, typed config
- **[Testing](./docs/guides/testing.md)** - Unit, functional, E2E testing patterns
- **[Advanced Patterns](./docs/guides/advanced-patterns.md)** - Extension functions, tokens, multi-tenancy
- **[API Reference](./docs/guides/api-reference.md)** - Complete API documentation
- **[Troubleshooting](./docs/guides/troubleshooting.md)** - Common issues and solutions
- **[Migration from NestJS](./docs/guides/migration-from-nestjs.md)** - Decorator to interface migration

**AI Navigation**: See [`docs/guides/_llms.md`](./docs/guides/_llms.md) for AI-optimized documentation index.

## Quick Start

```typescript
import { Ori, Type, Params } from 'orijs';
import type { OriController, RouteBuilder, Context } from 'orijs';

class UserService {
	findAll() {
		return [{ id: '1', name: 'Alice' }];
	}

	findById(id: string) {
		return { id, name: 'Alice' };
	}
}

class UsersController implements OriController {
	constructor(private users: UserService) {}

	configure(r: RouteBuilder) {
		r.get('/', () => this.users.findAll()).get('/:id', (ctx) => this.users.findById(ctx.params.id), {
			params: Params.uuid('id')
		});
	}
}

Ori.create().provider(UserService).controller('/users', UsersController, [UserService]).listen(3000);
```

## Table of Contents

- [Controllers](#controllers)
- [Dependency Injection](#dependency-injection)
- [Guards](#guards)
- [Interceptors](#interceptors)
- [Validation](#validation)
- [Logging](#logging)
- [Testing](#testing)
- [API Reference](#api-reference)

---

## Controllers

Controllers define routes by implementing the `OriController` interface:

```typescript
import type { OriController, RouteBuilder, Context } from 'orijs';

class UsersController implements OriController {
	constructor(private users: UserService) {}

	configure(r: RouteBuilder) {
		r.get('/', () => this.list())
			.get('/:id', (ctx) => this.findById(ctx))
			.post('/', (ctx) => this.create(ctx))
			.put('/:id', (ctx) => this.update(ctx))
			.delete('/:id', (ctx) => this.delete(ctx));
	}

	private list() {
		return this.users.findAll();
	}

	private findById(ctx: Context) {
		return this.users.findById(ctx.params.id);
	}

	private async create(ctx: Context) {
		const body = await ctx.json<{ name: string }>();
		return this.users.create(body);
	}

	// ...
}
```

### Handler Return Values

Handlers can return:

- **Objects/Arrays** — Serialized to JSON with `Content-Type: application/json`
- **Response objects** — Returned as-is for full control
- **Promises** — Awaited automatically

```typescript
configure(r: RouteBuilder) {
  r
    // Returns JSON
    .get('/json', () => ({ message: 'Hello' }))

    // Returns custom Response
    .get('/custom', () => new Response('Hello', {
      status: 201,
      headers: { 'X-Custom': 'value' }
    }))

    // Async handler
    .get('/async', async (ctx) => {
      const data = await fetchData();
      return data;
    });
}
```

> **See also**: [HTTP Routing](./docs/guides/http-routing.md) for route patterns, parameters, and middleware; [Core Concepts](./docs/guides/core-concepts.md) for controller lifecycle.

---

## Dependency Injection

Services are registered with explicit dependencies — no decorators or reflection:

```typescript
// Services
class DatabaseService {
	query(sql: string) {
		/* ... */
	}
}

class UserService {
	constructor(private db: DatabaseService) {}

	findAll() {
		return this.db.query('SELECT * FROM users');
	}
}

// Registration
Ori.create()
	.provider(DatabaseService) // No dependencies
	.provider(UserService, [DatabaseService]) // Depends on DatabaseService
	.controller('/users', UsersController, [UserService])
	.listen(3000);
```

### Container API

```typescript
const app = Ori.create();
const container = app.getContainer();

// Register a service
container.register(MyService, [Dependency1, Dependency2]);

// Check if registered
container.has(MyService); // boolean

// Resolve an instance (singleton)
const instance = container.resolve(MyService);

// Register a specific instance (useful for testing)
container.registerInstance(MyService, mockInstance);
```

> **See also**: [Core Concepts](./docs/guides/core-concepts.md#dependency-injection) for advanced DI patterns including scoped instances and async factories.

---

## Guards

Guards handle authentication and authorization. They run before the handler and can block requests.

```typescript
import type { Guard, Context } from 'orijs';

class AuthGuard implements Guard {
	canActivate(ctx: Context): boolean | Promise<boolean> {
		const token = ctx.request.headers.get('Authorization');
		if (!token?.startsWith('Bearer ')) {
			return false; // Returns 403 Forbidden
		}
		// Validate token, set user in state
		ctx.state.set('user', { id: '123' });
		return true;
	}
}

class AdminGuard implements Guard {
	canActivate(ctx: Context): boolean {
		const user = ctx.state.get('user') as { role?: string };
		return user?.role === 'admin';
	}
}
```

### Applying Guards

```typescript
// Global — applies to all routes
Ori.create()
  .guard(AuthGuard)
  .controller('/api', ApiController, [])
  .listen(3000);

// Controller level — applies to all routes in controller
configure(r: RouteBuilder) {
  r
    .guard(AuthGuard)
    .get('/', () => this.list())
    .post('/', (ctx) => this.create(ctx));
}

// Route level — applies to specific route only
configure(r: RouteBuilder) {
  r
    .get('/', () => this.list())
    .post('/', (ctx) => this.create(ctx))
      .guard(AdminGuard);  // Only POST requires admin
}

// Clear inherited guards
configure(r: RouteBuilder) {
  r
    .get('/public', () => this.publicData())
      .clearGuards();  // No guards on this route
}
```

> **See also**: [Core Concepts](./docs/guides/core-concepts.md#guards) for guard execution order and combining with interceptors.

---

## Interceptors

Interceptors wrap request handling in an onion model. Use them for logging, timing, response transformation, caching, etc.

```typescript
import type { Interceptor, Context } from 'orijs';

class LoggingInterceptor implements Interceptor {
	async intercept(ctx: Context, next: () => Promise<Response>): Promise<Response> {
		const start = performance.now();
		console.log(`→ ${ctx.request.method} ${new URL(ctx.request.url).pathname}`);

		const response = await next();

		const duration = (performance.now() - start).toFixed(2);
		console.log(`← ${response.status} (${duration}ms)`);

		return response;
	}
}

class CacheInterceptor implements Interceptor {
	private cache = new Map<string, Response>();

	async intercept(ctx: Context, next: () => Promise<Response>): Promise<Response> {
		const key = ctx.request.url;

		if (this.cache.has(key)) {
			return this.cache.get(key)!.clone();
		}

		const response = await next();
		this.cache.set(key, response.clone());
		return response;
	}
}
```

### Applying Interceptors

Same pattern as guards:

```typescript
// Global
Ori.create().intercept(LoggingInterceptor);

// Controller level
r.intercept(CacheInterceptor);

// Route level
r.get('/data', handler).intercept(CacheInterceptor);

// Clear inherited
r.get('/no-cache', handler).clearInterceptors();
```

> **See also**: [Core Concepts](./docs/guides/core-concepts.md#interceptors) for the onion model and common interceptor patterns.

---

## Validation

OriJS supports two validation approaches:

1. **TypeBox** (default, fastest) — JSON Schema based
2. **Custom validators** — Your own sync/async functions

### TypeBox Validation

```typescript
import { Type, Params, Query } from 'orijs';

class UsersController implements OriController {
	configure(r: RouteBuilder) {
		r
			// Validate UUID param
			.get('/:id', (ctx) => this.findById(ctx), {
				params: Params.uuid('id')
			})

			// Validate query parameters
			.get('/', (ctx) => this.list(ctx), {
				query: Query.pagination({ maxLimit: 50 })
			})

			// Validate request body
			.post('/', (ctx) => this.create(ctx), {
				body: Type.Object({
					name: Type.String({ minLength: 1 }),
					email: Type.String({ pattern: '^[^@]+@[^@]+\\.[^@]+$' }),
					age: Type.Optional(Type.Number({ minimum: 0 }))
				})
			});
	}
}
```

### Built-in Helpers

**Params** — URL path parameter validation:

```typescript
import { Params } from 'orijs';

// Single UUID
Params.uuid('id');

// Multiple UUIDs
Params.uuid('orgId', 'userId');

// String with constraints
Params.string('slug', { minLength: 1, maxLength: 100, pattern: '^[a-z-]+$' });

// Numeric string
Params.number('page', { min: 1 });
```

**Query** — Query string validation:

```typescript
import { Query } from 'orijs';

// Pagination: ?page=1&limit=20
Query.pagination({ defaultPage: 1, defaultLimit: 20, maxLimit: 100 });

// Search: ?q=searchterm
Query.search({ minLength: 2, maxLength: 100 });

// Sort: ?sortBy=createdAt&order=desc
Query.sort({ allowed: ['createdAt', 'name'], defaultOrder: 'desc' });
```

### Custom Validators

For complex validation logic (database lookups, business rules):

```typescript
class UsersController implements OriController {
	constructor(private users: UserService) {}

	configure(r: RouteBuilder) {
		r.post('/', (ctx) => this.create(ctx), {
			// Sync validator
			body: (data) => {
				if (!data || typeof data !== 'object') {
					throw new Error('Invalid request body');
				}
				const obj = data as Record<string, unknown>;
				if (!obj.name) {
					throw new Error('Name is required');
				}
				return data as { name: string };
			}
		});

		r.post('/register', (ctx) => this.register(ctx), {
			// Async validator — check database
			body: async (data) => {
				const { email } = data as { email: string };

				if (await this.users.emailExists(email)) {
					throw new Error('Email already registered');
				}

				return data as { email: string; password: string };
			}
		});
	}
}
```

### Validation Errors

Failed validation returns a 400 response:

```json
{
	"error": "Validation Error",
	"errors": [
		{ "path": "body.email", "message": "Invalid email format" },
		{ "path": "body.name", "message": "Required" }
	]
}
```

> **See also**: [API Reference](./docs/guides/api-reference.md#validation) for complete TypeBox helpers and custom validator patterns.

---

## Logging

OriJS includes a Pino-inspired structured logging system with automatic request context.

### Basic Usage

```typescript
import { Logger } from 'orijs';

const log = new Logger('MyService');

log.info('User created', { userId: '123' });
log.error('Failed to connect', { host: 'db.example.com' });
log.debug('Processing request', { requestId: 'abc' });
log.warn('Rate limit approaching', { current: 95, limit: 100 });
```

Output:

```
INFO [MyService] User created {"userId":"123"}
```

### Child Loggers

Create loggers with additional context:

```typescript
const log = new Logger('OrderService');
const orderLog = log.with({ orderId: '456' });

orderLog.info('Processing order');
// INFO [OrderService] Processing order {"orderId":"456"}

orderLog.info('Payment received', { amount: 99.99 });
// INFO [OrderService] Payment received {"orderId":"456","amount":99.99}
```

### Request Context

Every request automatically gets a logger with `requestId`:

```typescript
class UsersController implements OriController {
	configure(r: RouteBuilder) {
		r.get('/:id', (ctx) => {
			ctx.log.info('Fetching user', { id: ctx.params.id });
			// INFO [Request] Fetching user {"requestId":"abc123","id":"42"}

			return this.users.findById(ctx.params.id);
		});
	}
}
```

### Request Context in Services

Use `requestContext()` to access the current request's logger from anywhere:

```typescript
import { requestContext } from 'orijs';

class UserService {
	findById(id: string) {
		const { log } = requestContext();
		log.info('Looking up user', { id });
		// Automatically includes requestId from the current request

		return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
	}
}
```

### Transports

Configure where logs go:

```typescript
import { transports } from 'orijs';

Ori.create()
	.logger({
		level: 'info', // 'debug' | 'info' | 'warn' | 'error'
		transports: [
			transports.pretty(), // Colored console output
			transports.json() // JSON to stdout (for production)
		]
	})
	.listen(3000);
```

**Built-in transports:**

- `transports.pretty()` — Colored, human-readable console output
- `transports.json()` — Newline-delimited JSON (for log aggregators)

**Custom transport:**

```typescript
const customTransport = {
	log(entry: { level: number; time: number; msg: string; name: string; [key: string]: unknown }) {
		// Send to external service, write to file, etc.
		await fetch('https://logs.example.com', {
			method: 'POST',
			body: JSON.stringify(entry)
		});
	}
};
```

> **See also**: [Logging](./docs/guides/logging.md) for log levels, filtering, and production configurations.

---

## Testing

OriJS is designed for easy testing at all levels.

### Unit Testing Controllers

Controllers are plain classes — just instantiate with mocks:

```typescript
import { test, expect } from 'bun:test';

test('should return user by id', async () => {
	const mockUsers = {
		findById: (id: string) => ({ id, name: 'Alice' })
	};

	const controller = new UsersController(mockUsers as UserService);
	const ctx = { params: { id: '123' } } as Context;

	const result = controller.findById(ctx);

	expect(result).toEqual({ id: '123', name: 'Alice' });
});
```

### Testing Route Configuration

```typescript
import { RouteBuilder } from 'orijs';

test('should configure routes correctly', () => {
	const controller = new UsersController(mockUsers);
	const builder = new RouteBuilder();

	controller.configure(builder);
	const routes = builder.getRoutes();

	expect(routes).toHaveLength(3);
	expect(routes[0]).toMatchObject({ method: 'GET', path: '/' });
});
```

### Integration Testing

```typescript
import { test, expect, afterEach } from 'bun:test';
import { Ori } from 'orijs';

let server: ReturnType<typeof Bun.serve>;

afterEach(() => {
	server?.stop();
});

test('should return users list', async () => {
	server = Ori.create().provider(UserService).controller('/users', UsersController, [UserService]).listen(0); // Random available port

	const response = await fetch(`http://localhost:${server.port}/users`);

	expect(response.status).toBe(200);
	const users = await response.json();
	expect(users).toBeArray();
});
```

### Mocking Services

```typescript
const container = app.getContainer();

// Register mock instance
container.registerInstance(DatabaseService, {
	query: () => [{ id: '1', name: 'Test' }]
});
```

> **See also**: [Testing](./docs/guides/testing.md) for test layers, test infrastructure, and E2E testing patterns.

---

## API Reference

### Application

```typescript
Ori.create()
  .logger({ level, transports })                    // Configure logging
  .guard(GuardClass)                                // Add global guard
  .intercept(InterceptorClass)                      // Add global interceptor
  .provider(ServiceClass, [Dependencies])           // Register service
  .controller(path, ControllerClass, [Deps])        // Register controller
  .listen(port, callback?)                          // Start server
  .stop()                                           // Stop server
  .getRouter()                                      // Access router (debugging)
  .getContainer()                                   // Access DI container
```

### RouteBuilder

```typescript
r
  // Guards
  .guard(GuardClass)          // Add guard
  .guards([...])              // Replace all guards
  .clearGuards()              // Remove all guards

  // Interceptors
  .intercept(InterceptorClass)
  .interceptors([...])
  .clearInterceptors()

  // Clear all
  .clear()

  // HTTP methods (all accept optional schema as 3rd argument)
  .get(path, handler, schema?)
  .post(path, handler, schema?)
  .put(path, handler, schema?)
  .patch(path, handler, schema?)
  .delete(path, handler, schema?)
  .head(path, handler, schema?)
  .options(path, handler, schema?)
```

### Context

```typescript
interface Context {
	request: Request; // Fetch API Request
	params: Record<string, string>; // URL params (/users/:id)
	query: Record<string, string | string[]>; // Query string
	body: unknown; // Parsed body
	state: Map<string, unknown>; // Share data between middleware
	log: Logger; // Request-scoped logger

	json<T>(): Promise<T>; // Parse body as JSON
	text(): Promise<string>; // Parse body as text
}
```

### Schema Options

```typescript
interface RouteSchemaOptions {
	params?: TSchema | StandardSchema | Validator;
	query?: TSchema | StandardSchema | Validator;
	body?: TSchema | StandardSchema | Validator;
}

// Validator function type
type Validator<T> = (data: unknown) => T | Promise<T>;
```

---

## Project Structure

```
src/
├── core/                  # Framework core
│   ├── application.ts     # Ori.create() and Application class
│   ├── container.ts       # Dependency injection container
│   ├── router.ts          # HTTP routing with path parameters
│   ├── route-builder.ts   # Fluent route configuration API
│   ├── context.ts         # Request context implementation
│   └── index.ts           # Core exports
├── logging/               # Structured logging
│   ├── logger.ts          # Logger class with child logger support
│   ├── context.ts         # AsyncLocalStorage for request context
│   ├── transports.ts      # Built-in transports (pretty, json)
│   └── index.ts           # Logging exports
├── validation/            # Request validation
│   ├── types.ts           # Validation types, validate function
│   ├── params.ts          # Params helpers (uuid, string, number)
│   ├── query.ts           # Query helpers (pagination, search, sort)
│   └── index.ts           # Validation exports
├── types/                 # Type definitions
│   ├── context.ts         # Context, Handler
│   ├── middleware.ts      # Guard, Interceptor, Pipe
│   ├── controller.ts      # OriController, RouteBuilder, RouteDefinition
│   ├── http.ts            # HttpMethod
│   └── index.ts           # Type exports
└── index.ts               # Main entry point
```

---

## Running

```bash
# Install dependencies
bun install

# Run the example
bun run example/src/app.ts

# Type check
bun run tsc --noEmit

# Run tests
bun test
```

---

## Name

OriJS is named after the Ori from Stargate SG-1.

## License

MIT
