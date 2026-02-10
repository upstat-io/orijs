# Chapter 8: Interceptors

[Previous: Guards & Authentication &larr;](./07-guards-and-authentication.md)

Interceptors handle the cross-cutting concerns that surround your handler logic: logging, timing, caching, error transformation, rate limiting. They are the "around advice" of your request pipeline -- they wrap handler execution and can observe, modify, or replace both the request and the response.

If guards decide whether a request is allowed, interceptors decide *how* it is processed.

---

## The Onion Model

Interceptors follow an **onion model** (also called the middleware pipeline or Russian doll pattern). Each interceptor wraps around the next one, and the handler is at the center:

```
Request arrives
  |
  v
+-------------------------------------------+
| Interceptor A (before)                     |
|   +---------------------------------------+|
|   | Interceptor B (before)                ||
|   |   +-----------------------------------+|
|   |   | Interceptor C (before)            ||
|   |   |                                   ||
|   |   |   +-------------------------------+|
|   |   |   |         Handler               ||
|   |   |   +-------------------------------+|
|   |   |                                   ||
|   |   | Interceptor C (after)             ||
|   |   +-----------------------------------+|
|   |                                        |
|   | Interceptor B (after)                  |
|   +----------------------------------------+
|                                             |
| Interceptor A (after)                       |
+---------------------------------------------+
  |
  v
Response sent
```

Each interceptor receives a `next()` function. Calling `next()` passes execution to the next interceptor in the chain (or to the handler if there are no more interceptors). The response flows back through the chain in reverse order.

This model is powerful because each interceptor can:
- Run code **before** the handler (pre-processing)
- Run code **after** the handler (post-processing)
- Modify the response
- Catch and handle errors
- Short-circuit the chain by not calling `next()`
- Measure the time taken by everything inside it

---

## The Interceptor Interface

An interceptor implements the `Interceptor` interface with a single method: `intercept()`.

```typescript
import type { Interceptor, RequestContext } from '@orijs/orijs';

class LoggingInterceptor implements Interceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const start = performance.now();
    ctx.log.info('Request started', { method: ctx.request.method, url: ctx.request.url });

    const response = await next();  // Call the next interceptor or handler

    const duration = Math.round(performance.now() - start);
    ctx.log.info('Request completed', {
      method: ctx.request.method,
      status: response.status,
      durationMs: duration
    });

    return response;
  }
}
```

The method receives:
- **`ctx`** -- the `RequestContext`, same as handlers and guards
- **`next`** -- an async function that calls the next interceptor or handler in the chain

The method must return a `Response`. It can return the response from `next()` unchanged, modify it, or return a completely different response.

---

## Three Levels of Interceptors

Like guards, interceptors can be registered at three levels:

### Global Interceptors

Apply to every route in the application:

```typescript
Ori.create()
  .intercept(RequestIdInterceptor)
  .intercept(TimingInterceptor)
  .controller('/users', UserController, [UserService])
  .listen(3000);
```

### Controller Interceptors

Apply to all routes in a controller:

```typescript
class UserController implements OriController {
  configure(r: RouteBuilder) {
    r.intercept(AuditLogInterceptor);  // All routes in this controller

    r.get('/', this.listUsers);
    r.post('/', this.createUser);
  }
}
```

### Route Interceptors

Apply to a single route:

```typescript
class ReportController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/quick', this.quickReport);

    r.get('/full', this.fullReport);
    r.intercept(CacheInterceptor);      // Only cache the full report
  }
}
```

---

## Execution Order with Wrapping

When multiple interceptors are registered, they wrap in order: the first registered interceptor is the outermost layer, the last is closest to the handler.

```typescript
Ori.create()
  .intercept(TimingInterceptor)         // Outermost (A)
  .intercept(ErrorTransformInterceptor) // Middle (B)
  .controller('/api', ApiController)
  .listen(3000);

// In ApiController.configure():
r.intercept(CacheInterceptor);          // Innermost (C)
r.get('/data', this.getData);
```

Execution order for `GET /api/data`:

```
1. TimingInterceptor.intercept()         -- before next()
2.   ErrorTransformInterceptor.intercept() -- before next()
3.     CacheInterceptor.intercept()         -- before next()
4.       Handler (getData)
3.     CacheInterceptor.intercept()         -- after next()
2.   ErrorTransformInterceptor.intercept() -- after next()
1. TimingInterceptor.intercept()         -- after next()
```

The `TimingInterceptor` measures the total time for everything inside it, including all other interceptors and the handler. The `CacheInterceptor`, being closest to the handler, can cache the handler's raw response without the timing and error transformation headers.

---

## Common Patterns

### Request Timing Headers

Add a header that tells the client how long the server took to process the request:

```typescript
class TimingInterceptor implements Interceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const start = performance.now();
    const response = await next();
    const duration = performance.now() - start;

    // Clone headers and add timing
    const headers = new Headers(response.headers);
    headers.set('X-Response-Time', `${Math.round(duration)}ms`);
    headers.set('Server-Timing', `total;dur=${duration.toFixed(2)}`);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
}
```

### Request Logging

Log every request with structured context:

```typescript
class RequestLogInterceptor implements Interceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const method = ctx.request.method;
    const url = new URL(ctx.request.url).pathname;

    try {
      const response = await next();

      ctx.log.info('HTTP Request', {
        method,
        path: url,
        status: response.status,
        correlationId: ctx.correlationId
      });

      return response;
    } catch (error) {
      ctx.log.error('HTTP Request Failed', {
        method,
        path: url,
        error: error instanceof Error ? error.message : String(error),
        correlationId: ctx.correlationId
      });
      throw error;  // Re-throw so the framework's error handler catches it
    }
  }
}
```

### Error Transformation

Transform internal errors into standardized API error responses:

```typescript
class ErrorTransformInterceptor implements Interceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    try {
      return await next();
    } catch (error) {
      // Domain errors get their own status codes
      if (error instanceof NotFoundError) {
        return Response.json(
          { error: 'Not Found', message: error.message, code: error.code },
          { status: 404 }
        );
      }

      if (error instanceof ConflictError) {
        return Response.json(
          { error: 'Conflict', message: error.message, code: error.code },
          { status: 409 }
        );
      }

      if (error instanceof ValidationError) {
        return Response.json(
          { error: 'Validation Failed', issues: error.issues },
          { status: 422 }
        );
      }

      // Unknown errors -- log and return generic 500
      ctx.log.error('Unhandled error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      return Response.json(
        {
          error: 'Internal Server Error',
          correlationId: ctx.correlationId
        },
        { status: 500 }
      );
    }
  }
}
```

This pattern lets your services throw domain-specific errors (`throw new NotFoundError('User not found')`) while the interceptor translates them into proper HTTP responses. Your service code stays clean -- it does not need to know about HTTP status codes.

### Response Caching

Cache GET responses to avoid redundant computation:

```typescript
class CacheInterceptor implements Interceptor {
  constructor(private readonly cache: CacheService) {}

  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    // Only cache GET requests
    if (ctx.request.method !== 'GET') {
      return next();
    }

    const cacheKey = `http:${ctx.request.url}`;
    const cached = await this.cache.get<{ body: string; status: number; headers: Record<string, string> }>(cacheKey);

    if (cached) {
      ctx.log.debug('Cache hit', { key: cacheKey });
      return new Response(cached.body, {
        status: cached.status,
        headers: { ...cached.headers, 'X-Cache': 'HIT' }
      });
    }

    const response = await next();

    // Only cache successful responses
    if (response.status >= 200 && response.status < 300) {
      const body = await response.text();
      const headers = Object.fromEntries(response.headers.entries());

      await this.cache.set(cacheKey, { body, status: response.status, headers }, { ttl: 60 });

      return new Response(body, {
        status: response.status,
        headers: { ...headers, 'X-Cache': 'MISS' }
      });
    }

    return response;
  }
}
```

### Correlation ID Propagation

Ensure every response includes the request's correlation ID for distributed tracing:

```typescript
class CorrelationIdInterceptor implements Interceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const response = await next();

    const headers = new Headers(response.headers);
    headers.set('X-Correlation-Id', ctx.correlationId);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
}
```

### Rate Limiting

Limit requests per client to prevent abuse:

```typescript
class RateLimitInterceptor implements Interceptor {
  private readonly windowMs = 60_000;  // 1 minute
  private readonly maxRequests = 100;
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const clientId = this.getClientId(ctx);
    const now = Date.now();

    let counter = this.counters.get(clientId);
    if (!counter || now > counter.resetAt) {
      counter = { count: 0, resetAt: now + this.windowMs };
      this.counters.set(clientId, counter);
    }

    counter.count++;

    if (counter.count > this.maxRequests) {
      const retryAfter = Math.ceil((counter.resetAt - now) / 1000);
      return new Response(
        JSON.stringify({ error: 'Too Many Requests', retryAfter }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(this.maxRequests),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(counter.resetAt / 1000))
          }
        }
      );
    }

    const response = await next();

    // Add rate limit headers to all responses
    const headers = new Headers(response.headers);
    headers.set('X-RateLimit-Limit', String(this.maxRequests));
    headers.set('X-RateLimit-Remaining', String(Math.max(0, this.maxRequests - counter.count)));
    headers.set('X-RateLimit-Reset', String(Math.ceil(counter.resetAt / 1000)));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  private getClientId(ctx: RequestContext): string {
    // Use authenticated user ID if available, otherwise IP
    const user = ctx.get('user') as { id: string } | undefined;
    if (user) return `user:${user.id}`;

    const forwarded = ctx.request.headers.get('x-forwarded-for');
    return `ip:${forwarded?.split(',')[0]?.trim() ?? 'unknown'}`;
  }
}
```

Note: This is an in-memory rate limiter suitable for single-instance deployments. For horizontal scaling, use a Redis-backed rate limiter.

---

## Guards vs Interceptors: Comparison

| Feature | Guard | Interceptor |
|---------|-------|-------------|
| **Purpose** | Allow/deny access | Wrap handler execution |
| **Return type** | `boolean` | `Response` |
| **Can access response?** | No | Yes |
| **Can modify response?** | No | Yes |
| **Can measure timing?** | No | Yes |
| **Can short-circuit?** | Yes (return `false`) | Yes (skip `next()`) |
| **Runs before handler?** | Yes | Yes (before `next()`) |
| **Runs after handler?** | No | Yes (after `next()`) |
| **Has `next()` function?** | No | Yes |
| **Default rejection** | 403 Forbidden | N/A (must return Response) |
| **State setting** | Via `ctx.set()` | Via `ctx.set()` (rarely used) |

**Choose a guard when:**
- You need to decide if the request is allowed (authentication, authorization)
- You need to set request state (user identity, permissions)
- The decision is binary: allow or deny

**Choose an interceptor when:**
- You need to modify the response (add headers, transform body)
- You need to measure performance (timing, metrics)
- You need to handle errors (transform errors to API responses)
- You need to cache responses
- You need both before and after behavior

---

## Short-Circuiting

An interceptor can skip the handler entirely by returning a response without calling `next()`:

### Maintenance Mode

```typescript
class MaintenanceModeInterceptor implements Interceptor {
  constructor(private readonly configService: ConfigService) {}

  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const isMaintenanceMode = await this.configService.get('maintenance.enabled');

    if (isMaintenanceMode === 'true') {
      // Short-circuit: return response without calling next()
      return Response.json(
        {
          error: 'Service Unavailable',
          message: 'The system is under maintenance. Please try again later.',
          retryAfter: 300
        },
        {
          status: 503,
          headers: { 'Retry-After': '300' }
        }
      );
    }

    return next();  // Normal execution
  }
}
```

### Feature Flags

```typescript
class FeatureFlagInterceptor implements Interceptor {
  constructor(private readonly featureFlags: FeatureFlagService) {}

  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const url = new URL(ctx.request.url);

    // Check if the feature behind this route is enabled
    if (url.pathname.startsWith('/api/v2/') && !await this.featureFlags.isEnabled('api-v2')) {
      return Response.json(
        { error: 'Not Found', message: 'This endpoint is not available' },
        { status: 404 }
      );
    }

    return next();
  }
}
```

Short-circuiting is powerful but should be used carefully. When an interceptor does not call `next()`, no other interceptors or the handler will execute. Make sure this is the intended behavior.

---

## Overriding and Clearing Interceptors

Like guards, interceptors can be overridden or cleared at the route level:

```typescript
class ApiController implements OriController {
  configure(r: RouteBuilder) {
    r.intercept(LoggingInterceptor);    // All routes log

    r.get('/data', this.getData);        // Has LoggingInterceptor

    r.get('/health', this.healthCheck);
    r.clearInterceptors();               // No interceptors at all

    r.get('/metrics', this.getMetrics);
    r.interceptors([MetricsInterceptor]); // Only MetricsInterceptor (replaces all)
  }
}
```

- **`.intercept(Cls)`** -- adds an interceptor (additive)
- **`.interceptors([...])`** -- replaces all interceptors for this route
- **`.clearInterceptors()`** -- removes all interceptors for this route
- **`.clear()`** -- removes both guards and interceptors

---

## Testing Interceptors

Interceptors are tested by providing a mock `RequestContext` and a mock `next()` function:

```typescript
import { describe, it, expect, mock } from 'bun:test';

describe('TimingInterceptor', () => {
  it('should add X-Response-Time header', async () => {
    const interceptor = new TimingInterceptor();

    const ctx = createMockContext({});
    const mockResponse = new Response('ok', { status: 200 });
    const next = mock(() => Promise.resolve(mockResponse));

    const response = await interceptor.intercept(ctx, next);

    expect(response.status).toBe(200);
    expect(response.headers.has('X-Response-Time')).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorTransformInterceptor', () => {
  it('should transform NotFoundError to 404', async () => {
    const interceptor = new ErrorTransformInterceptor();
    const ctx = createMockContext({});
    const next = mock(() => Promise.reject(new NotFoundError('User not found')));

    const response = await interceptor.intercept(ctx, next);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Not Found');
    expect(body.message).toBe('User not found');
  });

  it('should return 500 for unknown errors', async () => {
    const interceptor = new ErrorTransformInterceptor();
    const ctx = createMockContext({});
    const next = mock(() => Promise.reject(new Error('database connection lost')));

    const response = await interceptor.intercept(ctx, next);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Internal Server Error');
    // Error details should NOT be in the response (security)
    expect(body.message).toBeUndefined();
  });
});

describe('CacheInterceptor', () => {
  it('should return cached response on cache hit', async () => {
    const cache = {
      get: mock(() => Promise.resolve({ body: '{"cached":true}', status: 200, headers: {} })),
      set: mock(() => Promise.resolve())
    };
    const interceptor = new CacheInterceptor(cache);

    const ctx = createMockContext({ method: 'GET', url: 'http://localhost/data' });
    const next = mock(() => Promise.resolve(new Response('fresh')));

    const response = await interceptor.intercept(ctx, next);

    expect(response.headers.get('X-Cache')).toBe('HIT');
    expect(next).not.toHaveBeenCalled();  // Handler was NOT called
  });

  it('should call handler and cache on miss', async () => {
    const cache = {
      get: mock(() => Promise.resolve(null)),
      set: mock(() => Promise.resolve())
    };
    const interceptor = new CacheInterceptor(cache);

    const ctx = createMockContext({ method: 'GET', url: 'http://localhost/data' });
    const handlerResponse = new Response('fresh data', { status: 200 });
    const next = mock(() => Promise.resolve(handlerResponse));

    const response = await interceptor.intercept(ctx, next);

    expect(response.headers.get('X-Cache')).toBe('MISS');
    expect(next).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('should skip cache for POST requests', async () => {
    const cache = { get: mock(), set: mock() };
    const interceptor = new CacheInterceptor(cache);

    const ctx = createMockContext({ method: 'POST' });
    const next = mock(() => Promise.resolve(new Response('ok')));

    await interceptor.intercept(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(cache.get).not.toHaveBeenCalled();
  });
});
```

Testing interceptors is straightforward because:
1. Create a mock context with the relevant request properties
2. Create a mock `next()` that returns a known response (or throws)
3. Call `interceptor.intercept(ctx, next)`
4. Assert the returned response and whether `next()` was called

You can test the "before" behavior by asserting on context state before `next()` runs. You can test the "after" behavior by asserting on the returned response. You can test error handling by making `next()` throw. You can test short-circuiting by checking that `next()` was not called.

---

## Real-World Interceptor Stack

A production application might use this interceptor stack:

```typescript
Ori.create()
  // Outermost: correlation ID on every response
  .intercept(CorrelationIdInterceptor)

  // Timing: measures everything inside (including error handling)
  .intercept(TimingInterceptor)

  // Error transform: catches domain errors and returns proper HTTP responses
  .intercept(ErrorTransformInterceptor)

  // Controllers with their own interceptors
  .controller('/api/reports', ReportController, [ReportService])
  // ReportController adds CacheInterceptor on expensive endpoints

  .listen(3000);
```

The ordering matters. `CorrelationIdInterceptor` is outermost because you want the correlation ID on every response, including error responses. `TimingInterceptor` is next because you want to measure the total time including error handling. `ErrorTransformInterceptor` is innermost so it can catch errors from the handler and transform them before timing and correlation are applied.

When the handler throws a `NotFoundError`:

```
CorrelationIdInterceptor (before)  -- no-op
  TimingInterceptor (before)       -- records start time
    ErrorTransformInterceptor (before) -- no-op
      Handler throws NotFoundError
    ErrorTransformInterceptor (after)  -- catches error, returns 404 Response
  TimingInterceptor (after)        -- adds X-Response-Time header to 404 Response
CorrelationIdInterceptor (after)   -- adds X-Correlation-Id header to 404 Response
```

The client receives a `404 Not Found` response with timing and correlation headers. Clean, predictable, and testable.

---

## Key Takeaways

1. **Interceptors follow the onion model** -- each interceptor wraps around the next, with the handler at the center
2. **`intercept(ctx, next)`** is the entire interface. Call `next()` to proceed, or return a response to short-circuit
3. **Three levels**: global, controller, route. Global is outermost, route is closest to the handler
4. **Before and after**: code before `next()` runs on the request path, code after `next()` runs on the response path
5. **Error handling**: wrap `next()` in try/catch to transform errors into proper HTTP responses
6. **Short-circuiting**: return a response without calling `next()` to skip all remaining interceptors and the handler
7. **Guards vs interceptors**: guards decide access (yes/no), interceptors modify processing (wrap handler execution)
8. **Ordering matters**: outermost interceptors see every response, innermost interceptors are closest to the raw handler response
9. **Interceptors are singletons** -- one instance per class, resolved through the DI container
10. **Easy to test** -- mock the context and `next()`, assert the returned response

---

[Next: Configuration &rarr;](./09-configuration.md)
