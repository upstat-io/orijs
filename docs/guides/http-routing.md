# HTTP & Routing

This guide covers HTTP routing in OriJS: controllers, route definitions, guards, interceptors, pipes, validation, and request/response handling.

---

## Controllers

Controllers group related routes and their handlers.

### Basic Controller

```typescript
import { RouteBuilder, RequestContext, OriController } from '@upstat/orijs';

class UserController implements OriController {
	configure(r: RouteBuilder) {
		r.get('/list', this.list);
		r.get('/:id', this.findById);
		r.post('/create', this.create);
		r.put('/:id', this.update);
		r.delete('/:id', this.remove);
	}

	// Use arrow functions to preserve 'this' binding
	private list = async (ctx: RequestContext) => {
		return ctx.json([{ id: '1', name: 'Alice' }]);
	};

	private findById = async (ctx: RequestContext) => {
		const { id } = ctx.params;
		return ctx.json({ id, name: 'Alice' });
	};

	private create = async (ctx: RequestContext) => {
		const data = await ctx.json();
		return ctx.json(data, 201);
	};

	private update = async (ctx: RequestContext) => {
		const { id } = ctx.params;
		const data = await ctx.json();
		return ctx.json({ id, ...data });
	};

	private remove = async (ctx: RequestContext) => {
		return new Response(null, { status: 204 });
	};
}
```

### Registering Controllers

```typescript
Ori.create().provider(UserService).controller('/api/users', UserController, [UserService]).listen(3000);
```

The first argument is the base path for all routes in the controller.

### Controller with Dependencies

```typescript
class UserController implements OriController {
  constructor(
    private userService: UserService,
    private ctx: AppContext
  ) {}

  configure(r: RouteBuilder) {
    r.get('/list', this.list);
  }

  private list = async (ctx: RequestContext) => {
    this.ctx.log.info('Listing users');
    const users = await this.userService.list();
    return ctx.json(users);
  };
}

// Register with dependencies
.controller('/api/users', UserController, [UserService, AppContext])
```

---

## RouteBuilder

The `RouteBuilder` provides a fluent API for defining routes.

### HTTP Methods

```typescript
configure(r: RouteBuilder) {
  r.get('/path', handler);      // GET
  r.post('/path', handler);     // POST
  r.put('/path', handler);      // PUT
  r.patch('/path', handler);    // PATCH
  r.delete('/path', handler);   // DELETE
  r.head('/path', handler);     // HEAD
  r.options('/path', handler);  // OPTIONS
}
```

### Path Parameters

```typescript
r.get('/users/:id', this.findUser);
r.get('/projects/:projectId/monitors/:monitorId', this.findMonitor);

private findUser = async (ctx: RequestContext) => {
  const { id } = ctx.params;  // { id: 'abc123' }
  return ctx.json({ id });
};

private findMonitor = async (ctx: RequestContext) => {
  const { projectId, monitorId } = ctx.params;
  return ctx.json({ projectId, monitorId });
};
```

### Static Responses (Zero-Allocation)

For high-performance static routes, pass a `Response` directly:

```typescript
configure(r: RouteBuilder) {
  // Static response - no handler allocation per request
  r.get('/health', Response.json({ status: 'ok' }));

  // Or use a pre-created response
  const notImplemented = Response.json({ error: 'Not implemented' }, { status: 501 });
  r.get('/legacy', notImplemented);
}
```

### Route-Level Guards and Interceptors

```typescript
configure(r: RouteBuilder) {
  // Apply guard to specific route
  r.get('/admin', this.adminOnly).guard(AdminGuard);

  // Apply interceptor to specific route
  r.get('/cached', this.getData).intercept(CacheInterceptor);

  // Chain multiple
  r.post('/sensitive', this.sensitiveOp)
    .guard(AdminGuard)
    .guard(AuditGuard)
    .intercept(LoggingInterceptor);
}
```

### Clear Guards

Remove inherited guards for public routes:

```typescript
configure(r: RouteBuilder) {
  // Inherit controller-level auth guard
  r.guard(AuthGuard);

  // Protected routes
  r.get('/profile', this.getProfile);

  // Public route - remove auth requirement
  r.get('/public', this.publicEndpoint).clearGuards();
}
```

---

## Route Validation

OriJS supports declarative route validation using TypeBox schemas. Define schemas for params, query, and body to automatically validate incoming requests.

### Route Schema Options

```typescript
interface RouteSchemaOptions {
	params?: Schema; // URL path parameters
	query?: Schema; // Query string parameters
	body?: Schema; // Request body
}
```

### Body Validation

```typescript
import { Type } from '@sinclair/typebox';

const CreateUserSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  email: Type.String({ format: 'email' }),
  role: Type.Optional(Type.Union([
    Type.Literal('admin'),
    Type.Literal('user'),
  ])),
});

configure(r: RouteBuilder) {
  r.post('/users', this.createUser, {
    body: CreateUserSchema,
  });
}

private createUser = async (ctx: RequestContext) => {
  // Body is already validated by the time handler runs
  const data = await ctx.json<typeof CreateUserSchema>();
  return ctx.json(await this.userService.create(data), 201);
};
```

### Params Validation

```typescript
import { Params } from '@orijs/validation';

// Single UUID parameter
const UserParams = Params.uuid('id');

// Multiple parameters
const MonitorParams = Type.Object({
  projectId: Type.String({ format: 'uuid' }),
  monitorId: Type.String({ format: 'uuid' }),
});

configure(r: RouteBuilder) {
  r.get('/users/:id', this.findUser, {
    params: UserParams,
  });

  r.get('/projects/:projectId/monitors/:monitorId', this.findMonitor, {
    params: MonitorParams,
  });
}
```

### Query Validation

```typescript
import { Query } from '@orijs/validation';

// Pagination with defaults
const ListQuery = Query.pagination();  // { page?: number, limit?: number }

// Custom query schema
const SearchQuery = Type.Object({
  q: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.Union([
    Type.Literal('active'),
    Type.Literal('inactive'),
  ])),
  page: Query.int({ default: 1 }),
  limit: Query.int({ default: 20, maximum: 100 }),
});

configure(r: RouteBuilder) {
  r.get('/users', this.listUsers, {
    query: ListQuery,
  });

  r.get('/search', this.search, {
    query: SearchQuery,
  });
}
```

### Combined Validation

```typescript
const UpdateUserSchema = {
  params: Params.uuid('id'),
  body: Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })),
    email: Type.Optional(Type.String({ format: 'email' })),
  }),
};

configure(r: RouteBuilder) {
  r.put('/users/:id', this.updateUser, UpdateUserSchema);
}
```

---

## RequestContext

Every route handler receives a `RequestContext` with request details and utilities.

### Properties

```typescript
private handler = async (ctx: RequestContext) => {
  // Native Web Request
  ctx.request;              // Request object
  ctx.request.method;       // 'GET', 'POST', etc.
  ctx.request.url;          // Full URL string
  ctx.request.headers;      // Headers object

  // Parsed values
  ctx.params;               // Path parameters { id: '123' }
  ctx.query;                // Query parameters (lazy parsed)

  // State from guards
  ctx.state;                // Type-safe state object

  // Utilities
  ctx.log;                  // Request-scoped logger
  ctx.event;                // Event system (if configured)
  ctx.requestId;            // Unique request ID (from header or generated)
  ctx.signal;               // AbortSignal for cancellation
  ctx.app;                  // AppContext reference
};
```

### Query Parameters

Query parameters are lazily parsed on first access:

```typescript
// GET /search?q=hello&page=2&tags=a&tags=b

private search = async (ctx: RequestContext) => {
  const { q, page, tags } = ctx.query;
  // q = 'hello'
  // page = '2' (string, not number)
  // tags = ['a', 'b'] (array for repeated params)
};
```

### Body Parsing

```typescript
// JSON body (with prototype pollution protection)
const data = await ctx.json<CreateUserDto>();

// Text body
const text = await ctx.text();

// Note: Body can only be parsed once per request
// Calling json() after text() or vice versa throws an error
```

### Validated Path Parameters

Use built-in validators for common parameter patterns:

```typescript
// Get validated alphanumeric param (a-z, A-Z, 0-9, -, _)
private findBySlug = async (ctx: RequestContext) => {
  const slug = ctx.getValidatedParam('slug');  // throws if invalid
  // Valid: "my-project", "user_123", "ABC"
  // Invalid: "../etc", "foo bar", "a;DROP TABLE"
};

// Get validated UUID param
private findById = async (ctx: RequestContext) => {
  const id = ctx.getValidatedUUID('id');  // throws if not UUID format
  // Valid: "550e8400-e29b-41d4-a716-446655440000"
  // Invalid: "not-a-uuid", "123"
};
```

**Security Note**: These validators prevent path traversal and injection attacks. Always use them for params that will be used in queries or file operations.

### AbortSignal for Cancellation

Handle client disconnects gracefully:

```typescript
private processLongTask = async (ctx: RequestContext) => {
  // Pass signal to database queries
  const result = await db.query('...', { signal: ctx.signal });

  // Or check manually in loops
  for (const item of items) {
    if (ctx.signal.aborted) {
      throw new Error('Request cancelled');
    }
    await processItem(item);
  }

  return ctx.json(result);
};
```

### Creating Responses

```typescript
// JSON response (helper method)
return ctx.json({ success: true });

// JSON with status code
return ctx.json({ error: 'Not found' }, 404);

// Native Response
return new Response('Hello', { status: 200 });
return Response.json({ data: 'value' });

// No content
return new Response(null, { status: 204 });
```

---

## Type-Safe State

Use generics to type the state passed from guards:

```typescript
interface AuthState {
	user: User;
	tenantId: string;
}

class UserController implements OriController<AuthState> {
	configure(r: RouteBuilder<AuthState>) {
		r.guard(AuthGuard);
		r.get('/me', this.getMe);
	}

	private getMe = async (ctx: RequestContext<AuthState>) => {
		// ctx.state is typed as AuthState
		const { user, tenantId } = ctx.state;
		return ctx.json({ user, tenantId });
	};
}
```

### Setting State in Guards

```typescript
class AuthGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		const user = await validateToken(ctx);
		if (!user) return false;

		// Set individual state properties
		ctx.set('user', user);
		ctx.set('tenantId', user.tenantId);

		return true;
	}
}
```

---

## Guards

Guards run before the route handler and can reject requests.

### Creating a Guard

```typescript
import { Guard, RequestContext } from '@upstat/orijs';

class AuthGuard implements Guard {
	constructor(private jwtService: JwtService) {}

	async canActivate(ctx: RequestContext): Promise<boolean> {
		const token = ctx.request.headers.get('Authorization')?.replace('Bearer ', '');

		if (!token) {
			ctx.log.warn('Missing auth token');
			return false; // Rejects with 403
		}

		try {
			const payload = await this.jwtService.verify(token);
			const user = await this.userService.findById(payload.sub);

			if (!user) {
				return false;
			}

			// Set state for downstream handlers
			ctx.set('user', user);
			ctx.set('tenantId', user.tenantId);
			return true;
		} catch (error) {
			ctx.log.error('Auth failed', { error });
			return false;
		}
	}
}
```

### Registering Guards

```typescript
// Global guard (all routes)
Ori.create().guard(AuthGuard).controller('/api', MyController);

// Controller-level guard
class MyController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard); // All routes in this controller
		r.get('/data', this.getData);
	}
}

// Route-level guard
r.get('/admin', this.adminOnly).guard(AdminGuard);
```

### Guard Dependencies

Guards can have dependencies:

```typescript
Ori.create().provider(JwtService).provider(UserService).guard(AuthGuard); // Will be instantiated with JwtService
```

### Guard Execution Order

```
Global Guards → Controller Guards → Route Guards → Handler
```

All guards must pass for the handler to execute.

### Role-Based Guard Example

```typescript
class RoleGuard implements Guard {
	constructor(private allowedRoles: string[]) {}

	async canActivate(ctx: RequestContext<AuthState>): Promise<boolean> {
		const { user } = ctx.state;

		if (!user) {
			ctx.log.warn('RoleGuard: No user in state (AuthGuard must run first)');
			return false;
		}

		const hasRole = this.allowedRoles.some((role) => user.roles.includes(role));

		if (!hasRole) {
			ctx.log.warn('Access denied: insufficient role', {
				required: this.allowedRoles,
				actual: user.roles
			});
			return false;
		}

		return true;
	}
}

// Usage with factory function
function RequireRole(...roles: string[]) {
	return class extends RoleGuard {
		constructor() {
			super(roles);
		}
	};
}

r.get('/admin', this.adminDashboard).guard(RequireRole('admin', 'super-admin'));
```

---

## Interceptors

Interceptors wrap route handlers, allowing pre/post processing.

### Creating an Interceptor

```typescript
import { Interceptor, RequestContext } from '@upstat/orijs';

class TimingInterceptor implements Interceptor {
	async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
		const start = Date.now();

		// Pre-processing
		ctx.log.info('Request started');

		try {
			// Call the handler
			const response = await next();

			// Post-processing
			const duration = Date.now() - start;
			ctx.log.info('Request completed', { duration, status: response.status });

			return response;
		} catch (error) {
			const duration = Date.now() - start;
			ctx.log.error('Request failed', { duration, error });
			throw error;
		}
	}
}
```

### Response Transformation Interceptor

```typescript
class WrapResponseInterceptor implements Interceptor {
	async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
		const response = await next();

		// Only wrap JSON responses
		const contentType = response.headers.get('content-type');
		if (!contentType?.includes('application/json')) {
			return response;
		}

		// Wrap data in envelope
		const data = await response.json();
		return Response.json(
			{
				success: true,
				data,
				requestId: ctx.requestId
			},
			{ status: response.status }
		);
	}
}
```

### Caching Interceptor Example

```typescript
class CacheInterceptor implements Interceptor {
	constructor(private cache: CacheService) {}

	async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
		// Only cache GET requests
		if (ctx.request.method !== 'GET') {
			return next();
		}

		const cacheKey = `http:${ctx.request.url}`;
		const cached = await this.cache.get(cacheKey);

		if (cached) {
			ctx.log.debug('Cache hit', { cacheKey });
			return Response.json(cached);
		}

		const response = await next();

		if (response.status === 200) {
			const data = await response.clone().json();
			await this.cache.set(cacheKey, data, { ttl: '5m' });
		}

		return response;
	}
}
```

### Registering Interceptors

```typescript
// Global interceptor
Ori.create().intercept(TimingInterceptor).controller('/api', MyController);

// Controller-level interceptor
class MyController implements OriController {
	configure(r: RouteBuilder) {
		r.intercept(LoggingInterceptor);
		r.get('/data', this.getData);
	}
}

// Route-level interceptor
r.get('/cached', this.getData).intercept(CacheInterceptor);
```

### Interceptor Execution Order

```
Global Interceptors → Controller Interceptors → Route Interceptors → Handler
```

Each interceptor wraps the next, creating an onion-like structure:

```
TimingInterceptor (pre)
  └─ LoggingInterceptor (pre)
       └─ CacheInterceptor (pre)
            └─ Handler
       └─ CacheInterceptor (post)
  └─ LoggingInterceptor (post)
└─ TimingInterceptor (post)
```

---

## Pipes

Pipes transform request data before it reaches the handler.

### Creating a Pipe

```typescript
import { Pipe, RequestContext } from '@upstat/orijs';
import { Type, Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const CreateUserSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	email: Type.String({ format: 'email' })
});

class ValidationPipe implements Pipe {
	constructor(private schema: TSchema) {}

	async transform(ctx: RequestContext): Promise<void> {
		const body = await ctx.json();

		if (!Value.Check(this.schema, body)) {
			const errors = [...Value.Errors(this.schema, body)];
			throw new ValidationError('Validation failed', errors);
		}

		// Attach validated data to context
		ctx.validatedBody = body;
	}
}
```

### Using Pipes

```typescript
r.post('/create', this.create).pipe(new ValidationPipe(CreateUserSchema));
```

---

## Error Handling

### Global Error Handler

```typescript
Ori.create()
	.onError((error, ctx) => {
		ctx.log.error('Unhandled error', { error });

		// Custom error response
		if (error instanceof ValidationError) {
			return Response.json(
				{
					type: 'validation_error',
					title: 'Validation Failed',
					status: 422,
					errors: error.details
				},
				{ status: 422 }
			);
		}

		if (error instanceof NotFoundError) {
			return Response.json(
				{
					type: 'not_found',
					title: 'Not Found',
					status: 404,
					detail: error.message
				},
				{ status: 404 }
			);
		}

		// Generic error (hide details in production)
		return Response.json(
			{
				type: 'internal_error',
				title: 'Internal Server Error',
				status: 500,
				detail: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : error.message
			},
			{ status: 500 }
		);
	})
	.controller('/api', MyController)
	.listen(3000);
```

### Controller-Level Error Handling

```typescript
private create = async (ctx: RequestContext) => {
  try {
    const data = await ctx.json<CreateDto>();
    const result = await this.service.create(data);
    return ctx.json(result, 201);
  } catch (error) {
    if (error instanceof DuplicateError) {
      return ctx.json({ error: 'Already exists' }, 409);
    }
    throw error;  // Let global handler deal with it
  }
};
```

---

## ResponseFactory

The `ResponseFactory` provides helper methods for common responses.

### Using ResponseFactory

```typescript
import { ResponseFactory } from '@upstat/orijs';

const rf = new ResponseFactory();

// Success responses
rf.ok({ data: 'value' }); // 200
rf.created({ id: '123' }); // 201
rf.noContent(); // 204

// Error responses
rf.badRequest('Invalid input'); // 400
rf.unauthorized('Token expired'); // 401
rf.forbidden('Access denied'); // 403
rf.notFound('User not found'); // 404
rf.conflict('Already exists'); // 409
rf.unprocessableEntity('Validation failed'); // 422
rf.internalServerError('Unexpected error'); // 500

// Custom JSON response
rf.json({ custom: 'data' }, 418);
```

### SSE (Server-Sent Events)

```typescript
private streamUpdates = async (ctx: RequestContext) => {
  const rf = new ResponseFactory();

  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue({
          event: 'update',
          data: JSON.stringify({ count: i }),
        });
        await Bun.sleep(1000);
      }
      controller.close();
    },
  });

  return rf.sse(stream, { retry: 3000 });
};
```

---

## Complete Example

```typescript
import { Ori, RouteBuilder, RequestContext, OriController, Guard, Interceptor } from '@upstat/orijs';
import { Type } from '@sinclair/typebox';
import { Params, Query } from '@orijs/validation';

// Types
interface AuthState {
	user: { id: string; role: string };
}

// Schemas
const CreateUserSchema = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 100 }),
	email: Type.String({ format: 'email' })
});

const UserParams = Params.uuid('id');

const ListQuery = Type.Object({
	page: Query.int({ default: 1 }),
	limit: Query.int({ default: 20, maximum: 100 }),
	role: Type.Optional(Type.String())
});

// Guard
class AuthGuard implements Guard {
	async canActivate(ctx: RequestContext<AuthState>): Promise<boolean> {
		const token = ctx.request.headers.get('Authorization');
		if (!token) return false;

		// Simplified - real implementation would validate token
		ctx.set('user', { id: '1', role: 'admin' });
		return true;
	}
}

// Interceptor
class LoggingInterceptor implements Interceptor {
	async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
		const start = Date.now();
		ctx.log.info('Request', { method: ctx.request.method, url: ctx.request.url });
		const response = await next();
		ctx.log.info('Response', { status: response.status, duration: Date.now() - start });
		return response;
	}
}

// Service
class UserService {
	private users = [
		{ id: '1', name: 'Alice', email: 'alice@example.com' },
		{ id: '2', name: 'Bob', email: 'bob@example.com' }
	];

	list(page: number, limit: number) {
		const start = (page - 1) * limit;
		return this.users.slice(start, start + limit);
	}

	findById(id: string) {
		return this.users.find((u) => u.id === id);
	}

	create(data: { name: string; email: string }) {
		const user = { id: crypto.randomUUID(), ...data };
		this.users.push(user);
		return user;
	}
}

// Controller
class UserController implements OriController<AuthState> {
	constructor(private userService: UserService) {}

	configure(r: RouteBuilder<AuthState>) {
		// Controller-level auth
		r.guard(AuthGuard);
		r.intercept(LoggingInterceptor);

		// Routes with validation
		r.get('/list', this.list, { query: ListQuery });
		r.get('/:id', this.findById, { params: UserParams });
		r.post('/create', this.create, { body: CreateUserSchema });

		// Public endpoint - remove auth
		r.get('/health', Response.json({ status: 'ok' })).clearGuards();
	}

	private list = async (ctx: RequestContext<AuthState>) => {
		const { page, limit } = ctx.query as { page: number; limit: number };
		ctx.log.info('User requested list', { userId: ctx.state.user.id });
		return ctx.json(this.userService.list(page, limit));
	};

	private findById = async (ctx: RequestContext<AuthState>) => {
		const id = ctx.getValidatedUUID('id');
		const user = this.userService.findById(id);
		if (!user) {
			return ctx.json({ error: 'Not found' }, 404);
		}
		return ctx.json(user);
	};

	private create = async (ctx: RequestContext<AuthState>) => {
		const data = await ctx.json<typeof CreateUserSchema>();
		const user = this.userService.create(data);
		return ctx.json(user, 201);
	};
}

// Application
Ori.create()
	.logger({ level: 'info' })
	.provider(UserService)
	.controller('/api/users', UserController, [UserService])
	.listen(3000, () => console.log('Server running'));
```

---

## Best Practices

### 1. Use Arrow Functions for Handlers

```typescript
// CORRECT - arrow function preserves 'this'
private list = async (ctx: RequestContext) => {
  return ctx.json(this.userService.list());
};

// WRONG - 'this' will be undefined
private list(ctx: RequestContext) {
  return ctx.json(this.userService.list());  // Error!
}
```

### 2. Type Your State

```typescript
interface AuthState {
  user: User;
  permissions: string[];
}

class MyController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) { ... }
}
```

### 3. Use Guards for Auth, Interceptors for Cross-Cutting Concerns

- **Guards**: Authentication, authorization, rate limiting
- **Interceptors**: Logging, timing, caching, response transformation

### 4. Validate All User Input

Always validate user input with TypeBox schemas:

```typescript
// Route-level validation
r.post('/users', this.create, { body: CreateUserSchema });

// Or use validated param helpers
const id = ctx.getValidatedUUID('id');
const slug = ctx.getValidatedParam('slug');
```

### 5. Use Proper HTTP Status Codes

| Code | Usage                     |
| ---- | ------------------------- |
| 200  | Success (GET, PUT, PATCH) |
| 201  | Created (POST)            |
| 204  | No Content (DELETE)       |
| 400  | Malformed request         |
| 401  | Unauthenticated           |
| 403  | Unauthorized              |
| 404  | Not found                 |
| 422  | Validation errors         |
| 409  | Conflict (duplicate)      |
| 500  | Server error              |

### 6. Handle Cancellation

Use `ctx.signal` for long-running operations:

```typescript
private export = async (ctx: RequestContext) => {
  const data = await this.service.fetchLargeDataset({ signal: ctx.signal });
  return ctx.json(data);
};
```

### 7. Configure Method Is Routing Table Only

Keep `configure()` clean - it's a routing declaration, not a place for logic:

```typescript
// CORRECT - routing table only
configure(r: RouteBuilder) {
  r.guard(AuthGuard);
  r.get('/users', this.list);
  r.post('/users', this.create);
}

// WRONG - logic in configure
configure(r: RouteBuilder) {
  if (process.env.ENABLE_ADMIN) {
    r.get('/admin', this.admin);  // Don't do this
  }
}
```

---

## Next Steps

- [Validation](./validation.md) - TypeBox schemas and validation patterns
- [Events](./events.md) - Emit events from your controllers
- [Testing](./testing.md) - Test your controllers and guards
