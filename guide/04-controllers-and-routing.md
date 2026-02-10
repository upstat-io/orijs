# Chapter 4: Controllers & Routing

Controllers are where HTTP requests meet your application logic. In OriJS, a controller is a class that implements the `OriController` interface and uses the `RouteBuilder` to define routes.

## Defining a Controller

Every controller implements one method: `configure(r: RouteBuilder)`.

```typescript
import type { OriController, RouteBuilder, RequestContext } from '@orijs/orijs';

class UserController implements OriController {
  constructor(private userService: UserService) {}

  configure(r: RouteBuilder) {
    r.get('/users').handle(this.listUsers);
    r.get('/users/:id').handle(this.getUser);
    r.post('/users').handle(this.createUser);
    r.put('/users/:id').handle(this.updateUser);
    r.delete('/users/:id').handle(this.deleteUser);
  }

  private listUsers = async (ctx: RequestContext) => {
    const users = await this.userService.findAll();
    return users;
  };

  private getUser = async (ctx: RequestContext) => {
    const user = await this.userService.findById(ctx.params.id);
    if (!user) return ctx.response.notFound();
    return user;
  };

  private createUser = async (ctx: RequestContext) => {
    const user = await this.userService.create(ctx.body);
    return ctx.response.created(user);
  };

  private updateUser = async (ctx: RequestContext) => {
    const user = await this.userService.update(ctx.params.id, ctx.body);
    return user;
  };

  private deleteUser = async (ctx: RequestContext) => {
    await this.userService.delete(ctx.params.id);
    return ctx.response.noContent();
  };
}
```

Register it with the application:

```typescript
Ori.create()
  .provider(UserService, [UserRepository])
  .controller(UserController, [UserService])
  .listen(3000);
```

### Why Arrow Functions for Handlers?

Notice that handlers are defined as **arrow function class properties** (`private getUser = async (ctx) => {}`), not regular methods. This is deliberate:

```typescript
// Correct — arrow function preserves `this`
private getUser = async (ctx: RequestContext) => {
  return this.userService.findById(ctx.params.id);  // `this` works
};

// Incorrect — regular method loses `this` when passed as callback
private async getUser(ctx: RequestContext) {
  return this.userService.findById(ctx.params.id);  // `this` is undefined!
}
```

When you write `r.get('/users/:id').handle(this.getUser)`, you're passing a reference to the function. Arrow functions capture `this` from the enclosing scope (the class instance), while regular methods would lose their `this` binding when extracted and called later by the framework.

This is a conscious design choice. NestJS uses decorators to bind method references internally, but OriJS opts for the standard JavaScript solution — arrow functions — which is explicit, well-understood, and doesn't require framework magic.

## Route Builder API

The `RouteBuilder` supports all standard HTTP methods:

```typescript
configure(r: RouteBuilder) {
  r.get('/path')       // GET
  r.post('/path')      // POST
  r.put('/path')       // PUT
  r.patch('/path')     // PATCH
  r.delete('/path')    // DELETE
}
```

Each method returns a `RouteDefinition` that provides a fluent API for configuring the route:

```typescript
r.get('/users/:id')
  .guard(AuthGuard)                          // Authentication/authorization
  .interceptor(LoggingInterceptor)           // Pre/post processing
  .validate({ params: UserIdParams })        // Input validation
  .handle(this.getUser);                     // Request handler
```

### Controller-Level Prefix

Set a base path for all routes in a controller:

```typescript
configure(r: RouteBuilder) {
  r.prefix('/api/v1/users');  // All routes prefixed with /api/v1/users

  r.get('/').handle(this.listUsers);          // GET /api/v1/users
  r.get('/:id').handle(this.getUser);         // GET /api/v1/users/:id
  r.post('/').handle(this.createUser);        // POST /api/v1/users
}
```

### Controller-Level Guards and Interceptors

Apply guards or interceptors to all routes in a controller:

```typescript
configure(r: RouteBuilder) {
  r.prefix('/api/v1/users');
  r.guard(AuthGuard);                        // Applied to ALL routes
  r.interceptor(RequestTimingInterceptor);   // Applied to ALL routes

  r.get('/').handle(this.listUsers);
  r.get('/:id').handle(this.getUser);

  // This route has an additional guard on top of the controller-level one
  r.delete('/:id')
    .guard(AdminGuard)
    .handle(this.deleteUser);
}
```

The execution order for guards is: **Global → Controller → Route**. All three levels must pass for the handler to execute. If any guard denies access, the request is rejected immediately.

## Path Parameters

Path parameters use the `:paramName` syntax:

```typescript
r.get('/users/:userId/posts/:postId').handle(this.getUserPost);

private getUserPost = async (ctx: RequestContext) => {
  const { userId, postId } = ctx.params;
  // userId and postId are strings from the URL
};
```

For type-safe parameters, use validation:

```typescript
import { Params } from '@orijs/validation';

const UserPostParams = Type.Object({
  userId: Params.uuid(),
  postId: Params.uuid(),
});

r.get('/users/:userId/posts/:postId')
  .validate({ params: UserPostParams })
  .handle(this.getUserPost);
```

Now `ctx.params` is typed as `{ userId: string; postId: string }` and validates that both parameters are valid UUIDs.

## Query Parameters

Access query parameters through `ctx.query`:

```typescript
// GET /users?page=2&limit=20&sort=name
private listUsers = async (ctx: RequestContext) => {
  const page = ctx.query.page;    // "2" (string)
  const limit = ctx.query.limit;  // "20" (string)
  const sort = ctx.query.sort;    // "name"
};
```

For type-safe query parameters with automatic coercion:

```typescript
import { Query, Type } from '@orijs/validation';

const ListUsersQuery = Type.Object({
  page: Query.integer({ minimum: 1, default: 1 }),
  limit: Query.integer({ minimum: 1, maximum: 100, default: 20 }),
  sort: Type.Optional(Type.Union([
    Type.Literal('name'),
    Type.Literal('createdAt'),
  ])),
  search: Type.Optional(Type.String({ minLength: 1 })),
});

r.get('/users')
  .validate({ query: ListUsersQuery })
  .handle(this.listUsers);

private listUsers = async (ctx: RequestContext) => {
  // ctx.query is typed as { page: number; limit: number; sort?: 'name' | 'createdAt'; search?: string }
  // page and limit are automatically coerced from strings to numbers
  const users = await this.userService.findAll(ctx.query);
  return users;
};
```

`Query.integer()` and `Query.number()` are OriJS helpers that handle the string-to-number coercion that query parameters require (since all URL query values are strings).

## Request Body

The request body is available on `ctx.body`:

```typescript
r.post('/users')
  .validate({ body: CreateUserBody })
  .handle(this.createUser);

private createUser = async (ctx: RequestContext) => {
  // ctx.body is typed based on the TypeBox schema
  const user = await this.userService.create(ctx.body);
  return ctx.response.created(user);
};
```

Without validation, `ctx.body` is `unknown` and you must handle parsing yourself. **Always use validation for POST/PUT/PATCH endpoints** — it provides type safety, input sanitization, and automatic error responses.

## RequestContext

The `RequestContext` is the main object passed to every handler, guard, and interceptor. It provides access to request data and response utilities:

```typescript
private handleRequest = async (ctx: RequestContext) => {
  // Request data
  ctx.params           // Path parameters
  ctx.query            // Query parameters
  ctx.body             // Parsed request body
  ctx.headers          // Request headers
  ctx.request          // Raw Bun Request object

  // Logging (with automatic request context)
  ctx.log.info('Processing request');
  ctx.log.warn('Something unusual', { detail: 'value' });

  // Response helpers
  return ctx.response.ok(data);        // 200
  return ctx.response.created(data);   // 201
  return ctx.response.noContent();     // 204
  return ctx.response.notFound();      // 404
  return ctx.response.badRequest();    // 400
  return ctx.response.unauthorized();  // 401
  return ctx.response.forbidden();     // 403

  // Type-safe state (set by guards)
  const user = ctx.state.user;

  // Request metadata
  ctx.requestId        // Unique request ID (UUID)
};
```

### Response Handling

Handlers can return values in several ways:

```typescript
// Return a plain object → 200 OK, JSON serialized
return { name: 'Alice', email: 'alice@example.com' };

// Return a string → 200 OK, text/plain
return 'Hello, World!';

// Return a Response → passed through directly
return new Response('Custom response', {
  status: 200,
  headers: { 'X-Custom': 'value' },
});

// Return via ctx.response → specific status codes
return ctx.response.created({ id: '123' });       // 201 Created
return ctx.response.noContent();                   // 204 No Content
return ctx.response.notFound('User not found');    // 404 Not Found
return ctx.response.badRequest({ errors: [...] }); // 400 Bad Request

// Return null/undefined → 204 No Content
return;
```

The automatic serialization means you rarely need to construct `Response` objects manually. Just return the data from your handler and OriJS handles the rest.

### Type-Safe State

Guards can attach data to the request state, which downstream handlers can access in a type-safe way:

```typescript
// Define the state shape
interface AuthState {
  user: { id: string; name: string; role: 'admin' | 'member' };
}

// Guard sets the state
class AuthGuard implements OriGuard<AuthState> {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const user = await this.authService.validateToken(ctx.headers.authorization);
    if (!user) return false;
    ctx.state.user = user;
    return true;
  }
}

// Handler reads the state (typed!)
private getProfile = async (ctx: RequestContext<AuthState>) => {
  const user = ctx.state.user;  // Typed as { id: string; name: string; role: 'admin' | 'member' }
  return { profile: user };
};
```

This pattern replaces NestJS's custom decorators like `@CurrentUser()`. Instead of hiding the data source behind a decorator, OriJS makes it explicit: the guard sets state, the handler reads state.

## Server-Sent Events (SSE)

OriJS supports Server-Sent Events for real-time streaming:

```typescript
r.get('/events/stream').handle(this.streamEvents);

private streamEvents = async (ctx: RequestContext) => {
  return ctx.response.sse(async function* () {
    while (true) {
      const event = await getNextEvent();
      yield { data: JSON.stringify(event) };
      // Or with event name:
      // yield { event: 'update', data: JSON.stringify(event) };
    }
  });
};
```

The `ctx.response.sse()` method returns a streaming response with the correct `Content-Type: text/event-stream` header. The async generator pattern lets you yield events as they become available, and the connection is automatically cleaned up when the client disconnects.

## Error Handling

OriJS provides built-in HTTP error handling:

```typescript
import { HttpException } from '@orijs/orijs';

private getUser = async (ctx: RequestContext) => {
  const user = await this.userService.findById(ctx.params.id);

  if (!user) {
    throw new HttpException(404, 'User not found');
  }

  return user;
};
```

When an `HttpException` is thrown, OriJS catches it and returns the appropriate HTTP response. For unhandled errors, OriJS returns a generic 500 response and logs the error with full context.

You can also use the response helpers for cleaner error responses:

```typescript
// These are equivalent
throw new HttpException(404, 'User not found');
return ctx.response.notFound('User not found');
```

The response helpers are preferred for expected error conditions (not found, bad request, unauthorized), while throwing `HttpException` is useful when you need to abort execution from deep within a call stack.

## Complete Example

Here's a full controller demonstrating multiple features together:

```typescript
import { Type } from '@orijs/validation';
import type { OriController, RouteBuilder, RequestContext } from '@orijs/orijs';

interface AuthState {
  user: { id: string; accountId: string; role: string };
}

const CreateProjectBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});

const ProjectIdParams = Type.Object({
  projectId: Type.String({ format: 'uuid' }),
});

const ListProjectsQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
});

class ProjectController implements OriController {
  constructor(private projectService: ProjectService) {}

  configure(r: RouteBuilder) {
    r.prefix('/api/v1/projects');
    r.guard(AuthGuard);  // All routes require authentication

    r.get('/')
      .validate({ query: ListProjectsQuery })
      .handle(this.listProjects);

    r.get('/:projectId')
      .validate({ params: ProjectIdParams })
      .handle(this.getProject);

    r.post('/')
      .validate({ body: CreateProjectBody })
      .handle(this.createProject);

    r.delete('/:projectId')
      .guard(AdminGuard)  // Additional admin check
      .validate({ params: ProjectIdParams })
      .handle(this.deleteProject);
  }

  private listProjects = async (ctx: RequestContext<AuthState>) => {
    const { page, limit } = ctx.query;
    return this.projectService.findByAccount(ctx.state.user.accountId, { page, limit });
  };

  private getProject = async (ctx: RequestContext<AuthState>) => {
    const project = await this.projectService.findById(
      ctx.params.projectId,
      ctx.state.user.accountId,
    );
    if (!project) return ctx.response.notFound();
    return project;
  };

  private createProject = async (ctx: RequestContext<AuthState>) => {
    const project = await this.projectService.create({
      ...ctx.body,
      accountId: ctx.state.user.accountId,
    });
    return ctx.response.created(project);
  };

  private deleteProject = async (ctx: RequestContext<AuthState>) => {
    await this.projectService.delete(
      ctx.params.projectId,
      ctx.state.user.accountId,
    );
    return ctx.response.noContent();
  };
}
```

This controller demonstrates:
- Controller-level prefix and guard
- Route-level guards (admin-only delete)
- TypeBox validation for body, params, and query
- Type-safe auth state from guards
- Proper use of response helpers for different status codes
- Arrow function handlers for correct `this` binding

[Previous: Core Concepts ←](./03-core-concepts.md) | [Next: Validation →](./05-validation.md)
