# Chapter 5: Controllers & Routing

[Previous: The Provider Architecture &larr;](./04-the-provider-architecture.md)

Controllers are the entry points of your application. Every HTTP request that hits your server is dispatched to a controller, which decides what to do with it. In OriJS, controllers are plain TypeScript classes with a fluent API for defining routes -- no decorators, no magic strings in metadata, no reflection.

This chapter covers how to define controllers, register routes, handle request parameters, build responses, and work with the full `RequestContext` that every handler receives.

---

## The OriController Interface

Every controller implements the `OriController` interface, which has exactly one method: `configure()`.

```typescript
import type { OriController, RouteBuilder } from '@orijs/orijs';

class UserController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/me', this.getMe);
    r.get('/:uuid', this.getById);
  }

  private getMe = async (ctx) => {
    return Response.json({ user: 'Alice' });
  };

  private getById = async (ctx) => {
    const uuid = ctx.params.uuid;
    return Response.json({ uuid });
  };
}
```

The `configure()` method receives a `RouteBuilder` -- a fluent API for registering routes, guards, and interceptors. Think of it as a routing table declaration. When the application boots, OriJS calls `configure()` once per controller to build an internal route map. After that, `configure()` is never called again.

**Why a method instead of decorators?** In NestJS, routes are declared with decorators like `@Get('/users')` and `@Post('/users')`. This has two problems. First, decorators run at class definition time, not instantiation time -- they modify the prototype, which makes testing harder. Second, decorators scatter routing information across individual methods, making it impossible to see the full route table at a glance. With `configure()`, the entire route table is in one place, reads top-to-bottom, and executes at a predictable time.

### Registering Controllers

Controllers are registered on the application with a base path:

```typescript
import { Ori } from '@orijs/orijs';

Ori.create()
  .controller('/users', UserController)
  .controller('/monitors', MonitorController, [MonitorClientService])
  .listen(3000);
```

The first argument is the controller prefix. All routes defined inside `configure()` are relative to this prefix. So if `UserController` defines `r.get('/me', ...)`, the full route is `GET /users/me`.

The optional third argument is the dependency array -- the constructor parameters for the controller, in order. OriJS's DI container resolves these at boot time.

---

## The RouteBuilder Fluent API

The `RouteBuilder` provides methods for every HTTP verb:

```typescript
class ArticleController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/', this.listArticles);        // GET /articles
    r.get('/:uuid', this.getArticle);     // GET /articles/:uuid
    r.post('/', this.createArticle);      // POST /articles
    r.put('/:uuid', this.replaceArticle); // PUT /articles/:uuid
    r.patch('/:uuid', this.updateArticle);// PATCH /articles/:uuid
    r.delete('/:uuid', this.deleteArticle); // DELETE /articles/:uuid
    r.head('/', this.checkArticles);      // HEAD /articles
    r.options('/', this.articleOptions);   // OPTIONS /articles
  }
}
```

Each route method takes:
1. **A path** -- relative to the controller prefix, with `:param` syntax for path parameters
2. **A handler** -- a function (or arrow function property) that receives a `RequestContext` and returns a `Response`
3. **An optional schema** -- for request validation (covered in [Chapter 6](./06-validation.md))

### Controller-Level Configuration

Before defining routes, you can set controller-wide configuration that applies to all routes:

```typescript
class MonitorController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) {
    // These apply to ALL routes in this controller
    r.guard(AuthGuard);
    r.intercept(TimingInterceptor);
    r.param('uuid', UuidParam);

    // Routes inherit the guard, interceptor, and param validator
    r.get('/', this.listMonitors);
    r.get('/:uuid', this.getMonitor);
    r.post('/', this.createMonitor);
    r.delete('/:uuid', this.deleteMonitor);
  }
}
```

Anything called on the `RouteBuilder` before the first route method is controller-level configuration.

### Route-Level Configuration

You can also add guards and interceptors to individual routes by calling them after a route method:

```typescript
class AdminController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);  // All routes require auth

    r.get('/dashboard', this.getDashboard);  // Uses AuthGuard only

    r.post('/settings', this.updateSettings);
    r.guard(AdminRoleGuard);  // This route ALSO requires admin role

    r.delete('/dangerous', this.dangerousAction);
    r.guard(AdminRoleGuard);
    r.guard(TwoFactorGuard);  // This route requires admin AND 2FA
  }
}
```

When you call `.guard()` after a route method, it adds the guard to that specific route. The route still inherits all controller-level and global guards -- route-level guards are additive.

### Overriding Inherited Guards

Sometimes a specific route needs different guards than the controller default. Use `.guards()` (plural) to replace all guards:

```typescript
class AccountController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);

    r.get('/me', this.getProfile);         // Has AuthGuard

    r.post('/login', this.login);
    r.guards([]);                           // No guards at all

    r.post('/register', this.register);
    r.guards([RateLimitGuard]);             // Only rate limiting, no auth
  }
}
```

Use `.clearGuards()` to remove all inherited guards, or `.clear()` to remove both guards and interceptors.

---

## Why Arrow Functions for Handlers

Handlers in OriJS are defined as arrow function properties, not regular methods:

```typescript
class UserController implements OriController {
  constructor(private readonly userService: UserService) {}

  configure(r: RouteBuilder) {
    r.get('/me', this.getMe);     // this.getMe is an arrow function
  }

  // Arrow function property -- 'this' is bound to the instance
  private getMe = async (ctx: RequestContext) => {
    const users = await this.userService.findAll();
    return Response.json(users);
  };
}
```

If `getMe` were a regular method, `this.getMe` in `configure()` would lose its `this` binding when the route builder stores the reference. When the framework later calls the handler, `this.userService` would be `undefined`. Arrow function properties capture `this` lexically, so the binding survives storage and later invocation.

This is the same pattern used by React class components (`handleClick = () => {...}`) and for the same reason. OriJS makes this an explicit convention rather than letting developers discover the problem at runtime.

---

## Path Parameters

Path parameters use the `:name` syntax:

```typescript
r.get('/:uuid', this.getUser);           // /users/abc-123
r.get('/:orgId/members/:userId', this.getMember);  // /orgs/o1/members/u1
```

Parameters are available on `ctx.params`:

```typescript
private getUser = async (ctx: RequestContext) => {
  const uuid = ctx.params.uuid;  // "abc-123"
  const user = await this.userService.findByUuid(uuid);
  return Response.json(user);
};
```

### Parameter Validators

OriJS provides built-in parameter validators that reject invalid parameters before your handler runs:

```typescript
import { UuidParam, NumberParam, StringParam } from '@orijs/orijs';

class MonitorController implements OriController {
  configure(r: RouteBuilder) {
    r.param('uuid', UuidParam);  // Validates RFC 4122 UUID format

    r.get('/:uuid', this.getMonitor);      // Only valid UUIDs reach the handler
    r.delete('/:uuid', this.deleteMonitor); // Same validation
    r.get('/', this.listMonitors);          // No UUID in path, validator skipped
  }
}
```

When you register `r.param('uuid', UuidParam)`, the framework automatically applies that validator to every route that contains `:uuid` in its path. Routes without that parameter are unaffected.

Each `r.param()` call also accumulates type information on the `RouteBuilder`. After registering `r.param('uuid', UuidParam)`, all handlers receive a `ctx.params` object where `uuid` is a known key, providing type-safe access without manual assertions.

Built-in validators:
- **`UuidParam`** -- validates RFC 4122 UUID format (`8-4-4-4-12` hex with dashes)
- **`StringParam`** -- validates non-empty string
- **`NumberParam`** -- validates numeric string (digits only)

Invalid parameters return a `422 Unprocessable Entity` response with structured error details.

#### Custom Parameter Validators

You can create your own validators by implementing the `ParamValidator` interface:

```typescript
import type { ParamValidator } from '@orijs/orijs';

class SlugParam implements ParamValidator {
  validate(value: string): boolean {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
  }
}

// Usage
r.param('slug', SlugParam);
r.get('/:slug', this.getBySlug);
```

### Manual Parameter Validation

If you prefer validating inside the handler, `RequestContext` provides helper methods:

```typescript
private getUser = async (ctx: RequestContext) => {
  // Validates UUID format (O(1) -- fixed length)
  const uuid = ctx.getValidatedUUID('uuid');

  // Validates alphanumeric + hyphens + underscores
  const slug = ctx.getValidatedParam('slug');

  const user = await this.userService.findByUuid(uuid);
  return Response.json(user);
};
```

These throw an error if the parameter is missing or invalid, which the framework catches and converts to a 500 response. For most cases, declarative validators with `r.param()` are cleaner.

---

## Query Parameters

Query parameters are accessed via `ctx.query`:

```typescript
// GET /articles?page=2&limit=10&tag=typescript&tag=bun
private listArticles = async (ctx: RequestContext) => {
  const query = ctx.query;
  // query.page = "2"         (string)
  // query.limit = "10"       (string)
  // query.tag = ["typescript", "bun"]  (array for repeated keys)
};
```

Query parameters are always strings (or arrays of strings for repeated keys). This is important -- `ctx.query.page` is `"2"`, not `2`. You need to parse them yourself or use validation schemas (covered in [Chapter 6](./06-validation.md)).

Query parsing is lazy: OriJS does not parse the query string until you access `ctx.query`. If your handler does not use query parameters, no parsing occurs.

---

## Request Body

The request body is accessed through async methods on the context:

```typescript
// JSON body
private createUser = async (ctx: RequestContext) => {
  const body = await ctx.json<CreateUserInput>();
  // body is typed as CreateUserInput
  const user = await this.userService.create(body);
  return OriResponse.created(user, `/users/${user.uuid}`);
};

// Text body
private receiveWebhook = async (ctx: RequestContext) => {
  const raw = await ctx.text();
  const signature = ctx.request.headers.get('x-webhook-signature');
  // Verify signature against raw text...
};
```

**Security note:** `ctx.json()` uses safe JSON parsing with prototype pollution protection. The `__proto__`, `constructor`, and `prototype` keys are stripped from parsed objects before they reach your handler. This is defense-in-depth -- even if your validation schema does not set `additionalProperties: false`, dangerous keys are removed.

Body parsing is also lazy: the body is only read and parsed on the first call to `ctx.json()` or `ctx.text()`. Subsequent calls return the cached result. You cannot call `ctx.json()` after `ctx.text()` on the same request, or vice versa -- the body can only be parsed once.

---

## RequestContext in Depth

Every handler receives a `RequestContext` that provides access to everything about the current request. Here is the full surface area:

### Core Properties

| Property | Type | Description |
|----------|------|-------------|
| `ctx.request` | `Request` | The raw Bun `Request` object |
| `ctx.params` | `TParams` | URL path parameters (typed via `r.param()`) |
| `ctx.query` | `Record<string, string \| string[]>` | Query string parameters (lazy) |
| `ctx.state` | `TState` | Type-safe state set by guards |
| `ctx.correlationId` | `string` | Unique request ID for tracing (lazy) |
| `ctx.signal` | `AbortSignal` | Fires when client disconnects |
| `ctx.app` | `AppContext` | Application-level context |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ctx.json<T>()` | `Promise<T>` | Parse body as JSON (safe, cached) |
| `ctx.text()` | `Promise<string>` | Parse body as text (cached) |
| `ctx.set(key, value)` | `void` | Set a state variable (used by guards) |
| `ctx.get(key)` | `TState[K]` | Get a state variable |
| `ctx.getValidatedUUID(key)` | `string` | Validate UUID path parameter |
| `ctx.getValidatedParam(key)` | `string` | Validate alphanumeric path parameter |

### Logger

| Property | Type | Description |
|----------|------|-------------|
| `ctx.log` | `Logger` | Request-scoped structured logger |

The logger is pre-configured with the request's correlation ID. Any log message automatically includes the correlation ID for distributed tracing.

```typescript
private createUser = async (ctx: RequestContext) => {
  ctx.log.info('Creating user', { email: body.email });
  // Output: { level: "info", msg: "Creating user", email: "...", correlationId: "abc-123" }
};
```

### Events and Workflows

| Property | Type | Description |
|----------|------|-------------|
| `ctx.events` | `EventEmitter` | Emit type-safe events |
| `ctx.workflows` | `WorkflowExecutor` | Execute type-safe workflows |
| `ctx.socket` | `SocketEmitter` | Send WebSocket messages |

These are request-bound: events and workflows emitted from a handler automatically inherit the request's correlation ID for distributed tracing.

### Performance Characteristics

Almost everything on `RequestContext` is lazy:
- **Query parsing** -- only on first `ctx.query` access
- **Logger creation** -- only on first `ctx.log` access
- **Request ID generation** -- only on first `ctx.correlationId` access
- **State allocation** -- only when first accessed or set
- **Body parsing** -- only on first `ctx.json()` or `ctx.text()` call

If your handler does not use the logger or query parameters, they are never created. This matters at high request rates where per-request allocations add up.

---

## Type-Safe State from Guards

Guards can set typed state on the context, and handlers can access it with full type safety. This is one of the most powerful patterns in OriJS.

```typescript
// Define the state shape
interface AuthState {
  user: { id: string; email: string; role: string };
}

// Guard sets state
class AuthGuard implements Guard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.request.headers.get('authorization');
    const user = await verifyToken(token);
    if (!user) return false;

    ctx.set('user', user);  // Type-safe set
    return true;
  }
}

// Controller declares state type
class ProfileController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);
    r.get('/me', this.getProfile);
  }

  private getProfile = async (ctx: RequestContext<AuthState>) => {
    // ctx.state.user is fully typed: { id: string, email: string, role: string }
    const { user } = ctx.state;
    return Response.json({ email: user.email, role: user.role });
  };
}
```

The `OriController<AuthState>` generic flows through to `RouteBuilder<AuthState>` and into every handler's `RequestContext<AuthState>`. TypeScript ensures you cannot access `ctx.state.user` without the guard that sets it.

Note: `RequestContext` is also exported as `Context` for brevity. `Context` takes two generics: `TState` for guard state, and `TParams` for typed path parameters:

```typescript
import type { Context } from '@orijs/orijs';

private getProfile = async (ctx: Context<AuthState>) => {
  // Same thing, shorter name
};
```

---

## Response Helpers

OriJS provides the `OriResponse` utility for creating typed HTTP responses.

### JSON Responses

```typescript
import { OriResponse } from '@orijs/orijs';

// 200 OK with JSON body
return OriResponse.json({ users: [...] });

// 200 with explicit type (catches mismatches at compile time)
return OriResponse.json<UserResponse>({ id: user.id, email: user.email });

// Custom status
return OriResponse.json<ErrorResponse>({ error: 'Not found' }, { status: 404 });
```

### Created (201)

```typescript
// 201 Created with optional Location header
return OriResponse.created(newUser, `/users/${newUser.uuid}`);
```

### No Content (204)

```typescript
// 204 No Content (for successful DELETE operations)
return OriResponse.noContent();
```

### Text Responses

```typescript
return OriResponse.text('Hello, World!');
return OriResponse.text('Created', { status: 201 });
```

### Redirects

```typescript
return OriResponse.redirect('/login');           // 302 Found
return OriResponse.redirect('/new-url', 301);    // 301 Moved Permanently
return OriResponse.redirect('/other', 307);      // 307 Temporary Redirect
```

### Direct Response Construction

Handlers can also return standard `Response` objects:

```typescript
// You can always use the standard Response API
return Response.json({ data: 'hello' });
return new Response('ok', { status: 200 });
return new Response(null, { status: 204 });
```

`OriResponse` is a convenience layer -- it adds type parameters and common patterns, but it is not required.

### Handler Return Value Conventions

OriJS handlers must return a `Response` object. This is an intentional design choice: explicit responses make it clear exactly what HTTP status, headers, and body each route returns.

```typescript
// Return Response directly
return Response.json(data);

// Return OriResponse helper
return OriResponse.json(data);
return OriResponse.noContent();
return OriResponse.created(data, '/path');

// Static responses for health checks and similar
r.get('/health', new Response('ok'));  // Zero allocation
```

---

## Server-Sent Events

OriJS has built-in support for Server-Sent Events (SSE), which allow the server to push real-time updates to clients over HTTP.

```typescript
import { responseFactory } from '@orijs/orijs';

class NotificationController implements OriController<AuthState> {
  constructor(private readonly notificationService: NotificationService) {}

  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);
    r.get('/stream', this.streamNotifications);
  }

  private streamNotifications = async (ctx: RequestContext<AuthState>) => {
    const userId = ctx.state.user.id;

    return responseFactory.sseStream(async function* () {
      // Send initial connection event
      yield { data: { status: 'connected' } };

      // Stream updates as they arrive
      const source = ctx.app.resolve(NotificationService).subscribe(userId);
      for await (const notification of source) {
        yield {
          event: 'notification',
          data: notification,
          id: notification.id  // Client can reconnect from this ID
        };
      }
    });
  };
}
```

The `sseStream()` method accepts an async generator function or any `AsyncIterable`. Each yielded object becomes an SSE event with these optional fields:

| Field | Type | Description |
|-------|------|-------------|
| `data` | `unknown` | Event data (objects are JSON-serialized) |
| `event` | `string` | Event type (default: `'message'`) |
| `id` | `string` | Event ID for client reconnection |
| `retry` | `number` | Retry timeout in milliseconds |

SSE streams include automatic keep-alive (a comment sent every 15 seconds by default) to prevent proxy timeouts:

```typescript
return responseFactory.sseStream(source, {
  keepAliveMs: 30000,              // Send keep-alive every 30s
  keepAliveComment: ':heartbeat'   // Custom keep-alive comment
});
```

The response includes appropriate headers for SSE: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `X-Accel-Buffering: no` (to disable nginx buffering).

---

## Error Handling

### Returning Error Responses

The simplest way to handle errors is to return an error response directly:

```typescript
private getUser = async (ctx: RequestContext<AuthState>) => {
  const uuid = ctx.params.uuid;
  const user = await this.userService.findByUuid(uuid);

  if (!user) {
    return OriResponse.json(
      { status: 'error', message: 'User not found' },
      { status: 404 }
    );
  }

  return OriResponse.json(user);
};
```

### Throwing Errors

If a handler throws an error, OriJS catches it and returns a 500 response. In production (`NODE_ENV=production`), only a generic error message is returned to prevent leaking internal details. In development, the full error message is included.

```typescript
private createUser = async (ctx: RequestContext) => {
  const body = await ctx.json<CreateUserInput>();

  // If this throws, OriJS returns 500 with a generic message
  const user = await this.userService.create(body);

  return OriResponse.created(user);
};
```

### Guard Rejections

When a guard returns `false`, OriJS returns `403 Forbidden`. Guards can also throw errors or return custom responses for more control (see [Chapter 7](./07-guards-and-authentication.md)).

### Validation Errors

When schema validation fails (see [Chapter 6](./06-validation.md)), OriJS returns `422 Unprocessable Entity` with a structured error array:

```json
{
  "error": "Validation Error",
  "errors": [
    { "path": "body.email", "message": "Expected string" },
    { "path": "body.age", "message": "Expected integer" }
  ]
}
```

---

## Static Routes (Zero Allocation)

For routes that always return the same response -- health checks, version endpoints, static configuration -- you can pass a `Response` directly instead of a handler function:

```typescript
class HealthController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/health', new Response('ok'));
    r.get('/version', Response.json({ version: '2.1.0' }));
  }
}
```

When Bun receives a request for these routes, it returns the pre-built response with zero JavaScript execution and zero object allocation. This is the fastest possible response path.

---

## Complete Real-World Example

Here is a complete CRUD controller for a blog post API, demonstrating all the patterns covered in this chapter:

```typescript
import type { OriController, RouteBuilder, Context } from '@orijs/orijs';
import { OriResponse, UuidParam, Type } from '@orijs/orijs';

// State from authentication guard
interface AuthState {
  user: { id: string; accountUuid: string; role: string };
}

// Validation schemas (covered in detail in Chapter 6)
const CreatePostSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ minLength: 1 }),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 10 }))
});

const UpdatePostSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  body: Type.Optional(Type.String({ minLength: 1 })),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 10 }))
});

const ListQuerySchema = Type.Object({
  page: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
  limit: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
  tag: Type.Optional(Type.String())
});

class PostController implements OriController<AuthState> {
  constructor(private readonly postService: PostService) {}

  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);
    r.param('uuid', UuidParam);

    r.get('/', this.listPosts, { query: ListQuerySchema });
    r.post('/', this.createPost, { body: CreatePostSchema });
    r.get('/:uuid', this.getPost);
    r.patch('/:uuid', this.updatePost, { body: UpdatePostSchema });
    r.delete('/:uuid', this.deletePost);
  }

  private listPosts = async (ctx: Context<AuthState>) => {
    const { accountUuid } = ctx.state.user;
    const q = ctx.query as Record<string, string | undefined>;
    const page = parseInt(q.page ?? '1', 10);
    const limit = Math.min(parseInt(q.limit ?? '20', 10), 100);
    const tag = q.tag;

    const result = await this.postService.list(accountUuid, { page, limit, tag });
    return OriResponse.json(result);
  };

  private createPost = async (ctx: Context<AuthState>) => {
    const { accountUuid } = ctx.state.user;
    const body = await ctx.json<{ title: string; body: string; tags?: string[] }>();

    const post = await this.postService.create(accountUuid, body);

    return OriResponse.created(
      { status: 'success', data: { uuid: post.uuid } },
      `/posts/${post.uuid}`
    );
  };

  private getPost = async (ctx: Context<AuthState>) => {
    const { accountUuid } = ctx.state.user;
    const postUuid = ctx.params.uuid;

    const post = await this.postService.findByUuid(accountUuid, postUuid);

    if (!post) {
      return OriResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    return OriResponse.json(post);
  };

  private updatePost = async (ctx: Context<AuthState>) => {
    const { accountUuid } = ctx.state.user;
    const postUuid = ctx.params.uuid;
    const body = await ctx.json<{ title?: string; body?: string; tags?: string[] }>();

    await this.postService.update(accountUuid, postUuid, body);

    return OriResponse.json({ status: 'success' });
  };

  private deletePost = async (ctx: Context<AuthState>) => {
    const { accountUuid } = ctx.state.user;
    const postUuid = ctx.params.uuid;

    await this.postService.delete(accountUuid, postUuid);

    return OriResponse.noContent();
  };
}

// Application setup
Ori.create()
  .provider(PostService, [PostRepository])
  .provider(PostRepository, [DatabaseService])
  .controller('/posts', PostController, [PostService])
  .listen(3000);
```

This controller demonstrates:
- Type-safe guard state with `OriController<AuthState>`
- Parameter validation with `r.param('uuid', UuidParam)`
- Schema validation for body and query parameters
- Arrow function handlers with proper `this` binding
- `OriResponse` helpers for different status codes
- Tenant isolation (filtering by `accountUuid`)
- Proper HTTP semantics (201 for create, 204 for delete, 404 for not found)

---

## Key Takeaways

1. **Controllers are plain classes** with a `configure()` method -- no decorators, no metadata
2. **RouteBuilder** provides a fluent API: configure guards/interceptors/validators, then define routes
3. **Arrow function properties** for handlers to preserve `this` binding
4. **RequestContext** is lazy -- nothing is allocated until you use it
5. **Path parameters** can be validated declaratively with `r.param()` or manually with `ctx.getValidatedUUID()`
6. **Query parameters** are always strings -- parse them yourself or use validation schemas
7. **Body parsing** uses safe JSON with prototype pollution protection
8. **OriResponse** provides typed response helpers, but standard `Response` works too
9. **Static routes** pass `Response` directly for zero-allocation dispatch
10. **Guard state** flows through generics for compile-time type safety

---

[Next: Validation &rarr;](./06-validation.md)
