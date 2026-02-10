# Chapter 6: Guards & Authentication

Guards are the mechanism for protecting routes in OriJS. They run before the handler and determine whether a request should proceed. If a guard denies access, the handler is never called.

## The Guard Interface

A guard is a class that implements the `OriGuard` interface:

```typescript
import type { OriGuard, RequestContext } from '@orijs/orijs';

class AuthGuard implements OriGuard {
  constructor(private authService: AuthService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return false;

    const user = await this.authService.verifyToken(token);
    if (!user) return false;

    // Attach the user to the request state for downstream handlers
    ctx.state.user = user;
    return true;
  }
}
```

The `canActivate` method receives the `RequestContext` and returns:
- `true` — the request proceeds to the next guard or handler
- `false` — the request is rejected with a `403 Forbidden` response

### Why Guards Instead of Middleware?

If you're coming from Express or Fastify, you might wonder why OriJS uses guards instead of middleware for authentication. The distinction is intentional:

**Middleware** (in Express) has a `next()` function and can do anything — modify the request, modify the response, short-circuit the chain, or call `next()` to continue. This flexibility makes middleware hard to reason about and test.

**Guards** have a single responsibility: decide yes or no. They can read the request and attach state, but they can't modify the response or do post-processing. This constraint makes guards:

1. **Easy to test**: Input is a request context, output is a boolean. No mocking `next()` callbacks.
2. **Easy to compose**: Multiple guards compose with AND logic — all must pass.
3. **Easy to reason about**: Reading `r.guard(AuthGuard).guard(AdminGuard)` tells you exactly what happens: authenticate first, then check admin role.

For cross-cutting concerns that need pre/post processing (like logging, timing, or caching), OriJS provides **interceptors** (covered in the next chapter).

## Applying Guards

Guards can be applied at three levels:

### Global Guards

Applied to every route in the application:

```typescript
Ori.create()
  .provider(AuthService)
  .globalGuard(AuthGuard, [AuthService])
  .controller(UserController, [UserService])
  .listen(3000);
```

### Controller-Level Guards

Applied to all routes within a controller:

```typescript
class AdminController implements OriController {
  configure(r: RouteBuilder) {
    r.guard(AdminGuard);  // All routes in this controller

    r.get('/admin/users').handle(this.listUsers);
    r.post('/admin/users').handle(this.createUser);
  }
}
```

### Route-Level Guards

Applied to a specific route:

```typescript
configure(r: RouteBuilder) {
  r.get('/public/health').handle(this.health);  // No guard

  r.get('/users')
    .guard(AuthGuard)
    .handle(this.listUsers);  // Auth required

  r.delete('/users/:id')
    .guard(AuthGuard)
    .guard(AdminGuard)
    .handle(this.deleteUser);  // Auth + admin required
}
```

### Execution Order

Guards execute in a specific order: **Global → Controller → Route**.

```
Request arrives
  ↓
Global guards (in registration order)
  ↓ all pass?
Controller guards (in registration order)
  ↓ all pass?
Route guards (in registration order)
  ↓ all pass?
Handler executes
```

If any guard returns `false`, the chain stops immediately. This means:

1. Global guards run first — use them for application-wide checks (rate limiting, API key validation).
2. Controller guards run next — use them for feature-area access (this section requires authentication).
3. Route guards run last — use them for specific permissions (only admins can delete).

Within each level, guards run in the order they were registered. A guard at a later level can read state set by a guard at an earlier level:

```typescript
// Global guard sets the user
class AuthGuard implements OriGuard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const user = await this.authService.verify(ctx.headers);
    if (!user) return false;
    ctx.state.user = user;
    return true;
  }
}

// Route guard reads the user set by the global guard
class AdminGuard implements OriGuard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    return ctx.state.user?.role === 'admin';
  }
}
```

## Type-Safe Guard State

OriJS supports typed state that flows from guards to handlers:

```typescript
// Define the state interface
interface AuthState {
  user: {
    id: string;
    email: string;
    role: 'admin' | 'member' | 'viewer';
    accountId: string;
  };
}

// Guard sets typed state
class AuthGuard implements OriGuard<AuthState> {
  constructor(private authService: AuthService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return false;

    const user = await this.authService.verifyToken(token);
    if (!user) return false;

    ctx.state.user = user;  // TypeScript enforces the shape
    return true;
  }
}

// Handler reads typed state
private getProfile = async (ctx: RequestContext<AuthState>) => {
  // ctx.state.user is fully typed
  const { id, email, role } = ctx.state.user;
  return { id, email, role };
};
```

The generic parameter on `OriGuard<AuthState>` and `RequestContext<AuthState>` ensures that:
- The guard sets all required properties on `ctx.state`
- The handler can access `ctx.state.user` with full type information
- TypeScript catches mismatches between what the guard provides and what the handler expects

## Common Guard Patterns

### Bearer Token Authentication

```typescript
class BearerAuthGuard implements OriGuard<AuthState> {
  constructor(private authService: AuthService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const authHeader = ctx.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) return false;

    const token = authHeader.slice(7);
    const user = await this.authService.verifyToken(token);
    if (!user) return false;

    ctx.state.user = user;
    return true;
  }
}
```

### API Key Authentication

```typescript
class ApiKeyGuard implements OriGuard {
  constructor(private apiKeyService: ApiKeyService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const apiKey = ctx.headers.get('x-api-key');
    if (!apiKey) return false;

    const valid = await this.apiKeyService.validate(apiKey);
    return valid;
  }
}
```

### Role-Based Authorization

```typescript
// A guard factory that creates role-checking guards
function createRoleGuard(...allowedRoles: string[]) {
  return class RoleGuard implements OriGuard {
    async canActivate(ctx: RequestContext<AuthState>): Promise<boolean> {
      const userRole = ctx.state.user?.role;
      return userRole != null && allowedRoles.includes(userRole);
    }
  };
}

// Usage
const AdminGuard = createRoleGuard('admin');
const EditorGuard = createRoleGuard('admin', 'editor');

configure(r: RouteBuilder) {
  r.guard(AuthGuard);  // First: authenticate

  r.get('/articles').handle(this.listArticles);       // Any authenticated user
  r.post('/articles')
    .guard(EditorGuard)                                // Admin or editor
    .handle(this.createArticle);
  r.delete('/articles/:id')
    .guard(AdminGuard)                                 // Admin only
    .handle(this.deleteArticle);
}
```

### Tenant Isolation

For multi-tenant applications, a guard can ensure users only access their own data:

```typescript
interface TenantState extends AuthState {
  tenant: { accountId: string; projectId: string };
}

class TenantGuard implements OriGuard<TenantState> {
  constructor(private tenantService: TenantService) {}

  async canActivate(ctx: RequestContext<AuthState>): Promise<boolean> {
    const accountId = ctx.params.accountId ?? ctx.state.user.accountId;
    const projectId = ctx.params.projectId;

    if (!accountId) return false;

    // Verify the user has access to this tenant
    const hasAccess = await this.tenantService.checkAccess(
      ctx.state.user.id,
      accountId,
      projectId,
    );
    if (!hasAccess) return false;

    ctx.state.tenant = { accountId, projectId };
    return true;
  }
}
```

### Development Bypass Guard

For local development, you might want to bypass authentication:

```typescript
class DevAuthGuard implements OriGuard<AuthState> {
  constructor(private authService: AuthService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    // In development, accept a dev header
    if (process.env.DEV_MODE === 'true') {
      const devUserId = ctx.headers.get('x-dev-user-id');
      if (devUserId) {
        const user = await this.authService.findById(devUserId);
        if (user) {
          ctx.state.user = user;
          return true;
        }
      }
    }

    // Otherwise, use normal token auth
    const token = ctx.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return false;

    const user = await this.authService.verifyToken(token);
    if (!user) return false;

    ctx.state.user = user;
    return true;
  }
}
```

## Guard Dependencies

Guards are registered like providers — with explicit dependency arrays:

```typescript
Ori.create()
  .provider(AuthService, [UserRepository])
  .provider(TenantService, [AccountRepository])
  .globalGuard(AuthGuard, [AuthService])
  .controller(ProjectController, [ProjectService]);

// Controller-level guards get deps from the container
configure(r: RouteBuilder) {
  r.guard(TenantGuard);  // TenantGuard's deps are resolved from the container
}
```

For global guards, dependencies are listed explicitly in the `.globalGuard()` call. For controller and route-level guards, the guard class must already be registered as a provider, or its dependencies must be resolvable from the container.

## Rejecting with Custom Responses

By default, a guard returning `false` produces a `403 Forbidden` response. To return a different status code or error message, throw an `HttpException`:

```typescript
import { HttpException } from '@orijs/orijs';

class AuthGuard implements OriGuard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.headers.get('authorization');

    if (!token) {
      throw new HttpException(401, 'Authentication required');
    }

    const user = await this.authService.verifyToken(token);
    if (!user) {
      throw new HttpException(401, 'Invalid or expired token');
    }

    ctx.state.user = user;
    return true;
  }
}
```

This pattern lets you distinguish between "no credentials provided" (401) and "credentials invalid" (401 with a message) or "insufficient permissions" (403).

## Testing Guards

Guards are plain classes, making them straightforward to test:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { createMockRequestContext } from '@orijs/test-utils';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let authService: AuthService;

  beforeEach(() => {
    authService = {
      verifyToken: async (token: string) => {
        if (token === 'valid-token') {
          return { id: '1', email: 'user@test.com', role: 'member' };
        }
        return null;
      },
    } as AuthService;
    guard = new AuthGuard(authService);
  });

  it('should allow access with valid token', async () => {
    const ctx = createMockRequestContext({
      headers: { authorization: 'Bearer valid-token' },
    });

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(ctx.state.user.email).toBe('user@test.com');
  });

  it('should deny access without token', async () => {
    const ctx = createMockRequestContext();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(false);
  });

  it('should deny access with invalid token', async () => {
    const ctx = createMockRequestContext({
      headers: { authorization: 'Bearer invalid' },
    });

    const result = await guard.canActivate(ctx);
    expect(result).toBe(false);
  });
});
```

Because guards are just classes with a `canActivate` method, you don't need a testing framework or DI container to test them. Mock the dependencies, create a context, and assert the result.

[Previous: Validation ←](./05-validation.md) | [Next: Interceptors →](./07-interceptors.md)
