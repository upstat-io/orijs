# Chapter 7: Guards & Authentication

[Previous: Validation &larr;](./06-validation.md)

Authentication and authorization are the first things you need to get right in any API. Get them wrong and nothing else matters -- not your beautiful domain model, not your caching strategy, not your event system. In OriJS, these concerns are handled by **guards**: small, focused classes that decide whether a request should proceed or be rejected.

This chapter covers the guard interface, how guards compose across three levels (global, controller, route), how to build type-safe guard state, and common authentication patterns you will encounter in production.

---

## The Guard Interface

A guard is a class that implements the `Guard` interface with a single method: `canActivate()`.

```typescript
import type { Guard, RequestContext } from '@orijs/orijs';

class AuthGuard implements Guard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.request.headers.get('authorization');
    if (!token) return false;

    const user = await verifyToken(token);
    if (!user) return false;

    ctx.set('user', user);
    return true;
  }
}
```

The method receives the `RequestContext` and returns a boolean:
- **`true`** -- the request proceeds to the next guard or the handler
- **`false`** -- the framework immediately returns `403 Forbidden`

That is the entire contract. No configuration objects, no decorator metadata, no abstract base classes. A guard is a function that says yes or no.

### Why Guards Instead of Middleware

If you have used Express or Koa, you are used to middleware functions for authentication. Guards are better for several reasons.

**Single responsibility.** A middleware function can do anything -- read the body, modify headers, set response cookies, call next or not. A guard does exactly one thing: decide if the request is allowed. This constraint makes guards predictable and easy to reason about.

**Testable in isolation.** To test a guard, you create a mock `RequestContext`, call `canActivate()`, and assert the result. You do not need to set up an HTTP server, a middleware chain, or worry about `next()` being called. Guards are pure decision functions.

**Composable.** Guards compose declaratively. You list them on a controller or route and they run in order. In Express, middleware ordering is implicit and depends on the order of `app.use()` calls, which can be in a completely different file from the route definition.

**Type-safe state.** Guards set typed state on the context that handlers can access with full TypeScript inference. Express middleware typically sets properties on `req` (like `req.user`), which requires manual type declarations or `@types` extensions.

---

## Three Levels of Guards

Guards can be registered at three levels, and they compose through inheritance:

### Global Guards

Global guards apply to every route in the application:

```typescript
Ori.create()
  .guard(RequestIdGuard)          // Runs on every request
  .guard(RateLimitGuard)          // Runs on every request
  .controller('/users', UserController, [UserService])
  .controller('/posts', PostController, [PostService])
  .listen(3000);
```

Global guards are useful for cross-cutting concerns that affect the entire application: rate limiting, request ID propagation, IP allowlisting.

### Controller Guards

Controller guards apply to all routes within a controller:

```typescript
class UserController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);           // All routes in this controller

    r.get('/me', this.getProfile);
    r.get('/:uuid', this.getUser);
    r.post('/', this.createUser);
  }
}
```

### Route Guards

Route guards apply to a single route:

```typescript
class AdminController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);            // All routes require auth

    r.get('/dashboard', this.getDashboard);   // AuthGuard only

    r.post('/settings', this.updateSettings);
    r.guard(AdminRoleGuard);                  // AuthGuard + AdminRoleGuard

    r.delete('/data', this.deleteAllData);
    r.guard(AdminRoleGuard);
    r.guard(TwoFactorGuard);                  // AuthGuard + AdminRoleGuard + TwoFactorGuard
  }
}
```

Route guards are additive: they add to the guards inherited from the controller and global levels.

---

## Execution Order

Guards execute in a predictable order: **Global, then Controller, then Route**. Within each level, guards run in the order they were registered.

```
Request
  |
  v
Global Guard 1 (RequestIdGuard)
  |
  v
Global Guard 2 (RateLimitGuard)
  |
  v
Controller Guard (AuthGuard)
  |
  v
Route Guard 1 (AdminRoleGuard)
  |
  v
Route Guard 2 (TwoFactorGuard)
  |
  v
Handler
```

If any guard returns `false`, execution stops immediately. The guards after it never run, and the handler never runs.

This ordering is intentional. Global guards handle infrastructure concerns (rate limiting, request IDs). Controller guards handle authentication (is this a valid user?). Route guards handle authorization (does this user have permission for this specific action?). The ordering matches the logical progression from "is this request allowed at all?" to "is this user allowed to do this specific thing?"

---

## Type-Safe Guard State

Guards do not just accept or reject requests. They also extract information and make it available to handlers through typed state. This is one of the most powerful patterns in OriJS.

### Defining State

```typescript
// The state shape -- what the guard provides
interface AuthState {
  user: {
    id: string;
    email: string;
    accountUuid: string;
    role: 'admin' | 'member' | 'viewer';
  };
}
```

### Setting State in Guards

```typescript
class AuthGuard implements Guard {
  constructor(
    private readonly authService: AuthService,
    private readonly userRepository: UserRepository
  ) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = this.extractBearerToken(ctx);
    if (!token) return false;

    try {
      const decoded = await this.authService.verifyToken(token);
      const user = await this.userRepository.findByAuthId(decoded.uid);
      if (!user) return false;

      // Set typed state -- available to all handlers
      ctx.set('user', user);

      // Enrich the logger with user context for all subsequent log messages
      ctx.log.setMeta({ userId: user.id, accountUuid: user.accountUuid });

      return true;
    } catch {
      return false;
    }
  }

  private extractBearerToken(ctx: RequestContext): string | undefined {
    const header = ctx.request.headers.get('authorization');
    if (!header) return undefined;
    const [type, token] = header.split(' ');
    return type === 'Bearer' && token ? token : undefined;
  }
}
```

### Accessing State in Handlers

```typescript
class UserController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);
    r.get('/me', this.getProfile);
  }

  private getProfile = async (ctx: RequestContext<AuthState>) => {
    // ctx.state.user is fully typed
    const { user } = ctx.state;
    return Response.json({
      id: user.id,
      email: user.email,
      role: user.role     // TypeScript knows this is 'admin' | 'member' | 'viewer'
    });
  };
}
```

The generic parameter flows through the entire chain:
1. `OriController<AuthState>` declares what state this controller expects
2. `RouteBuilder<AuthState>` ensures handlers receive the right context type
3. `RequestContext<AuthState>` provides `ctx.state` with full type inference

If a handler accesses `ctx.state.user.email` but the guard does not set `user`, TypeScript catches the mismatch at compile time, not at runtime.

---

## Common Guard Patterns

### Bearer Token Authentication

The most common authentication pattern for APIs:

```typescript
class BearerAuthGuard implements Guard {
  constructor(private readonly authService: AuthService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const header = ctx.request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return false;

    const token = header.slice(7);  // Remove "Bearer " prefix
    try {
      const payload = await this.authService.verifyToken(token);
      ctx.set('user', payload);
      return true;
    } catch {
      return false;
    }
  }
}
```

### API Key Authentication

For service-to-service communication or public API clients:

```typescript
class ApiKeyGuard implements Guard {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const apiKey = ctx.request.headers.get('x-api-key');
    if (!apiKey) return false;

    const client = await this.apiKeyService.validate(apiKey);
    if (!client) return false;

    ctx.set('client', client);
    ctx.log.setMeta({ clientId: client.id });
    return true;
  }
}
```

### Role-Based Authorization

Authorization guards check what an authenticated user is allowed to do:

```typescript
interface AuthState {
  user: { id: string; role: 'admin' | 'member' | 'viewer' };
}

class AdminGuard implements Guard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const user = ctx.get('user') as AuthState['user'] | undefined;
    if (!user) return false;  // No user set -- auth guard did not run
    return user.role === 'admin';
  }
}
```

This guard depends on `AuthGuard` running first to set the `user` state. The execution order guarantees this: controller-level `AuthGuard` runs before route-level `AdminGuard`.

### Tenant Isolation

In multi-tenant applications, every data query must be scoped to the current tenant:

```typescript
interface TenantState {
  user: { id: string; accountUuid: string; projectUuid: string };
}

class TenantGuard implements Guard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const user = ctx.get('user') as TenantState['user'] | undefined;
    if (!user) return false;

    // Ensure the user has a valid account and project
    if (!user.accountUuid || !user.projectUuid) {
      ctx.log.warn('User missing tenant context', { userId: user.id });
      return false;
    }

    return true;
  }
}
```

Controllers that access tenant-scoped data use both guards:

```typescript
class MonitorController implements OriController<TenantState> {
  configure(r: RouteBuilder<TenantState>) {
    r.guard(AuthGuard);
    r.guard(TenantGuard);

    r.get('/', this.listMonitors);
  }

  private listMonitors = async (ctx: RequestContext<TenantState>) => {
    const { accountUuid, projectUuid } = ctx.state.user;
    const monitors = await this.monitorService.list(accountUuid, projectUuid);
    return Response.json(monitors);
  };
}
```

### Dev Mode Bypass

During local development, you often want to bypass real authentication:

```typescript
class DevAuthGuard implements Guard {
  constructor(
    private readonly authService: AuthService,
    private readonly userRepository: UserRepository,
    private readonly devMode: boolean
  ) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    // DEV MODE: Accept X-Dev-User-Id header
    if (this.devMode) {
      const devUserId = ctx.request.headers.get('x-dev-user-id');
      if (devUserId) {
        const user = await this.userRepository.findById(devUserId);
        if (user) {
          ctx.set('user', user);
          ctx.log.debug('Dev mode auth bypass', { userId: devUserId });
          return true;
        }
      }
    }

    // Normal auth flow
    return this.verifyRealToken(ctx);
  }

  private async verifyRealToken(ctx: RequestContext): Promise<boolean> {
    const token = ctx.request.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return false;
    // ... real token verification
    return true;
  }
}
```

The `devMode` flag is injected through the DI container -- you control it through configuration, not environment variable checks scattered through your code.

---

## Guard Factories

When you need a family of similar guards with different parameters, create a factory function instead of separate classes:

```typescript
function createRoleGuard(requiredRole: string): new () => Guard {
  return class RoleGuard implements Guard {
    async canActivate(ctx: RequestContext): Promise<boolean> {
      const user = ctx.get('user') as { role: string } | undefined;
      return user?.role === requiredRole;
    }
  };
}

// Usage
const AdminGuard = createRoleGuard('admin');
const ManagerGuard = createRoleGuard('manager');

class AdminController implements OriController<AuthState> {
  configure(r: RouteBuilder<AuthState>) {
    r.guard(AuthGuard);
    r.guard(AdminGuard);           // Only admins
    r.get('/dashboard', this.getDashboard);
  }
}
```

A more flexible variant for permission-based authorization:

```typescript
function createPermissionGuard(...permissions: string[]): new () => Guard {
  return class PermissionGuard implements Guard {
    async canActivate(ctx: RequestContext): Promise<boolean> {
      const user = ctx.get('user') as { permissions: string[] } | undefined;
      if (!user) return false;
      return permissions.every((p) => user.permissions.includes(p));
    }
  };
}

const CanReadReports = createPermissionGuard('reports:read');
const CanManageUsers = createPermissionGuard('users:read', 'users:write');
```

---

## Guard Dependencies and Registration

Guards are resolved through the DI container, so they can have constructor dependencies:

```typescript
class AuthGuard implements Guard {
  constructor(
    private readonly authService: AuthService,
    private readonly userRepository: UserRepository
  ) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    // Use injected dependencies
  }
}
```

When you register a guard with `r.guard(AuthGuard)`, the framework automatically registers it with the container if it is not already registered. The container resolves its dependencies from the existing provider registrations.

**Important:** Guard dependencies must already be registered as providers before the guard is used. If `AuthGuard` depends on `AuthService`, make sure `AuthService` is registered:

```typescript
Ori.create()
  .provider(AuthService, [TokenVerifier])
  .provider(UserRepository, [DatabaseService])
  // AuthGuard's deps (AuthService, UserRepository) are registered above
  .controller('/users', UserController, [UserService])
  .listen(3000);
```

Guards are singletons -- one instance per guard class, shared across all requests. This is important: do not store per-request state on guard properties. Use `ctx.set()` for per-request data.

---

## Guard Responses

Guards support three return values from `canActivate()`:

- **`true`** -- the request proceeds to the next guard or the handler
- **`false`** -- the framework returns a generic `403 Forbidden` response
- **`Response`** -- the framework returns the custom response directly (useful for 401 Unauthorized, 429 Too Many Requests, etc.)

For simple guards, returning `true` or `false` is sufficient:

```typescript
class AuthGuard implements Guard {
  constructor(
    private readonly authService: AuthService
  ) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const header = ctx.request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return false;

    const token = header.slice(7);
    try {
      const user = await this.authService.verifyToken(token);
      ctx.set('user', user);
      return true;
    } catch {
      return false;  // Expired, invalid, or any other failure -> 403
    }
  }
}
```

When you need specific status codes or custom error bodies, return a `Response`:

```typescript
class ApiKeyGuard implements Guard {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  async canActivate(ctx: RequestContext): Promise<boolean | Response> {
    const apiKey = ctx.request.headers.get('x-api-key');
    if (!apiKey) {
      return Response.json(
        { statusCode: 401, message: 'Missing API key', error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const result = await this.subscriptionService.validate(apiKey);
    if (!result.allowed) {
      return Response.json(
        { statusCode: 401, message: result.reason, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    ctx.set('client', result);
    return true;
  }
}
```

If a guard throws an error, the framework's outer error handler catches it and returns a `500 Internal Server Error` (in production, without error details). Guards should not throw to control the response -- use a `Response` return instead.

---

## Testing Guards

Guards are straightforward to test because they are plain classes with a single method. You need a mock `RequestContext` and your guard's dependencies.

```typescript
import { describe, test, expect } from 'bun:test';

describe('AuthGuard', () => {
  test('should reject requests without a token', async () => {
    const authService = { verifyToken: async () => null };
    const userRepo = { findByAuthId: async () => null };
    const guard = new AuthGuard(authService, userRepo);

    const ctx = createMockContext({
      headers: {}  // No authorization header
    });

    const result = await guard.canActivate(ctx);
    expect(result).toBe(false);
  });

  test('should accept valid tokens and set user state', async () => {
    const mockUser = { id: '123', email: 'alice@example.com', role: 'admin' };
    const authService = {
      verifyToken: async () => ({ uid: 'auth-123' })
    };
    const userRepo = {
      findByAuthId: async () => mockUser
    };
    const guard = new AuthGuard(authService, userRepo);

    const ctx = createMockContext({
      headers: { authorization: 'Bearer valid-token' }
    });

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(ctx.get('user')).toEqual(mockUser);
  });

  test('should reject expired tokens', async () => {
    const authService = {
      verifyToken: async () => { throw new TokenExpiredError(); }
    };
    const userRepo = { findByAuthId: async () => null };
    const guard = new AuthGuard(authService, userRepo);

    const ctx = createMockContext({
      headers: { authorization: 'Bearer expired-token' }
    });

    const result = await guard.canActivate(ctx);
    expect(result).toBe(false);
  });
});

// Helper to create a mock RequestContext
function createMockContext(options: {
  headers?: Record<string, string>;
  params?: Record<string, string>;
}): RequestContext {
  const headers = new Headers(options.headers);
  const request = new Request('http://localhost/test', { headers });

  // Use RequestContextFactory or build manually
  const ctx = new RequestContext(
    {} as any,      // AppContext (mock)
    request,
    options.params ?? {},
    'http://localhost/test',
    -1,              // No query string
    { level: 'silent' }
  );

  return ctx;
}
```

Guards are pure decision functions, which makes them some of the easiest code in your application to test. Each test creates a context with specific inputs, calls `canActivate()`, and asserts the result.

---

## Guard vs Interceptor: When to Use Which

Guards and interceptors both run before your handler, but they serve different purposes:

| Concern | Guard | Interceptor |
|---------|-------|-------------|
| Authentication | Yes | No |
| Authorization | Yes | No |
| Rate limiting | Yes | No |
| Logging | No | Yes |
| Timing | No | Yes |
| Response transformation | No | Yes |
| Caching | No | Yes |
| Error wrapping | No | Yes |

**The rule:** if the decision is "should this request proceed at all?", use a guard. If the concern is "how should this request be processed?", use an interceptor.

Guards make a binary decision (allow/deny). Interceptors wrap the handler execution and can modify both the request and the response (see [Chapter 8](./08-interceptors.md)).

---

## Key Takeaways

1. **Guards are decision functions** -- they return `true` (allow), `false` (deny, 403 Forbidden), or a `Response` (custom HTTP response, e.g. 401 Unauthorized)
2. **Three levels**: global, controller, route. They compose through inheritance: global runs first, then controller, then route
3. **Type-safe state**: guards set state with `ctx.set()`, handlers access it with `ctx.state` -- fully typed through generics
4. **Guards are singletons** -- one instance per class, resolved through the DI container. Do not store per-request state on properties
5. **Flexible responses**: return `false` for generic 403, or return a `Response` for custom status codes and error bodies (401, 429, etc.)
6. **Guard factories** (`createRoleGuard`, `createPermissionGuard`) are useful for parameterized authorization
7. **Dev mode bypass** guards let you skip real authentication during local development
8. **Guards are easy to test** -- create a mock context, call `canActivate()`, assert the result

---

[Next: Interceptors &rarr;](./08-interceptors.md)
