# Chapter 7: Interceptors

Interceptors handle cross-cutting concerns that need to run both **before** and **after** a request handler. While guards answer "should this request proceed?", interceptors answer "what should happen around this request?"

## The Onion Model

Interceptors follow the **onion model** (also known as the middleware pattern or Russian doll model). Each interceptor wraps around the next, creating layers:

```
Request → Interceptor A (before) → Interceptor B (before) → Handler → Interceptor B (after) → Interceptor A (after) → Response
```

This is the same pattern used by Koa's middleware, ASP.NET Core's middleware pipeline, and Python's ASGI middleware. It's powerful because each interceptor can:

1. Run code **before** the handler (pre-processing)
2. Run code **after** the handler (post-processing)
3. **Short-circuit** the chain by not calling `next()`
4. **Transform** the response returned by the handler
5. **Catch and handle** errors thrown by the handler

## The Interceptor Interface

```typescript
import type { OriInterceptor, RequestContext } from '@orijs/orijs';

class TimingInterceptor implements OriInterceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const start = performance.now();

    // Call the next interceptor (or handler if this is the last interceptor)
    const response = await next();

    const duration = Math.round(performance.now() - start);
    ctx.log.info('Request completed', { durationMs: duration });

    // Return the response (optionally modified)
    return response;
  }
}
```

The `intercept` method receives:
- `ctx`: The `RequestContext` with full access to request data, logging, and state
- `next`: A function that calls the next interceptor in the chain (or the handler)

It must return a `Response`. The `next()` function returns the response from the handler (or the next interceptor), which you can inspect, modify, or replace.

## Applying Interceptors

Like guards, interceptors can be applied at three levels:

### Global Interceptors

```typescript
Ori.create()
  .globalInterceptor(TimingInterceptor)
  .globalInterceptor(ErrorLoggingInterceptor, [Logger])
  .controller(UserController, [UserService])
  .listen(3000);
```

### Controller-Level Interceptors

```typescript
class ApiController implements OriController {
  configure(r: RouteBuilder) {
    r.interceptor(CacheInterceptor);

    r.get('/data').handle(this.getData);
    r.get('/stats').handle(this.getStats);
  }
}
```

### Route-Level Interceptors

```typescript
configure(r: RouteBuilder) {
  r.get('/data')
    .interceptor(CacheInterceptor)
    .handle(this.getData);

  r.post('/data')
    .handle(this.createData);  // No interceptor
}
```

### Execution Order

Interceptors execute in order: **Global → Controller → Route**, wrapping inward:

```
Global Interceptor A (before)
  → Global Interceptor B (before)
    → Controller Interceptor (before)
      → Route Interceptor (before)
        → Handler
      → Route Interceptor (after)
    → Controller Interceptor (after)
  → Global Interceptor B (after)
→ Global Interceptor A (after)
```

The first interceptor registered is the **outermost** layer. This means:
- It's the first to see the request
- It's the last to see the response
- It wraps everything else, including other interceptors

## Common Interceptor Patterns

### Request/Response Logging

```typescript
class LoggingInterceptor implements OriInterceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    ctx.log.info('Incoming request', {
      method: ctx.request.method,
      path: new URL(ctx.request.url).pathname,
    });

    const response = await next();

    ctx.log.info('Outgoing response', {
      status: response.status,
    });

    return response;
  }
}
```

### Response Timing Headers

```typescript
class TimingHeaderInterceptor implements OriInterceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const start = performance.now();
    const response = await next();
    const duration = performance.now() - start;

    // Clone the response to add a header
    const headers = new Headers(response.headers);
    headers.set('X-Response-Time', `${Math.round(duration)}ms`);

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }
}
```

### Error Transformation

```typescript
class ErrorTransformInterceptor implements OriInterceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    try {
      return await next();
    } catch (error) {
      // Transform domain errors into HTTP responses
      if (error instanceof EntityNotFoundError) {
        return Response.json(
          { error: 'Not Found', message: error.message },
          { status: 404 },
        );
      }
      if (error instanceof ValidationError) {
        return Response.json(
          { error: 'Bad Request', message: error.message, details: error.details },
          { status: 400 },
        );
      }
      // Re-throw unexpected errors for the framework to handle
      throw error;
    }
  }
}
```

### Response Caching

```typescript
class CacheInterceptor implements OriInterceptor {
  constructor(private cacheService: CacheService) {}

  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    // Only cache GET requests
    if (ctx.request.method !== 'GET') {
      return next();
    }

    const cacheKey = `response:${new URL(ctx.request.url).pathname}`;
    const cached = await this.cacheService.get(cacheKey);

    if (cached) {
      ctx.log.debug('Cache hit', { key: cacheKey });
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }

    const response = await next();

    // Cache successful responses
    if (response.status === 200) {
      const body = await response.text();
      await this.cacheService.set(cacheKey, body, { ttl: 60 });
      return new Response(body, {
        status: response.status,
        headers: { ...Object.fromEntries(response.headers), 'X-Cache': 'MISS' },
      });
    }

    return response;
  }
}
```

### Request ID Propagation

```typescript
class RequestIdInterceptor implements OriInterceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const response = await next();

    // Add the request ID to the response for tracing
    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', ctx.requestId);

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }
}
```

### Rate Limiting

```typescript
class RateLimitInterceptor implements OriInterceptor {
  constructor(private rateLimiter: RateLimiter) {}

  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const clientId = ctx.headers.get('x-api-key') ?? ctx.request.headers.get('x-forwarded-for') ?? 'anonymous';

    const allowed = await this.rateLimiter.check(clientId);
    if (!allowed.ok) {
      return Response.json(
        { error: 'Too Many Requests', retryAfter: allowed.retryAfterSeconds },
        {
          status: 429,
          headers: { 'Retry-After': String(allowed.retryAfterSeconds) },
        },
      );
    }

    return next();
  }
}
```

## Guards vs Interceptors

A common question is when to use a guard versus an interceptor. Here's the guideline:

| Use a Guard when... | Use an Interceptor when... |
|---------------------|---------------------------|
| You need a yes/no access decision | You need pre AND post processing |
| Authentication / authorization | Logging / timing / metrics |
| Input validation at the access level | Response transformation |
| Rate limiting (simple allow/deny) | Error transformation |
| The logic is "should this request proceed?" | Caching |
| | The logic is "what should wrap this request?" |

Guards are simpler (boolean return), interceptors are more powerful (full request/response control). When in doubt, prefer guards for access control and interceptors for everything else.

## Short-Circuiting

An interceptor can short-circuit the chain by returning a response without calling `next()`:

```typescript
class MaintenanceModeInterceptor implements OriInterceptor {
  constructor(private configService: ConfigService) {}

  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const isMaintenanceMode = this.configService.get('MAINTENANCE_MODE');

    if (isMaintenanceMode) {
      return Response.json(
        { error: 'Service Unavailable', message: 'The system is under maintenance' },
        { status: 503 },
      );
    }

    return next();
  }
}
```

When an interceptor doesn't call `next()`, no subsequent interceptors or the handler will execute. The response returned by the interceptor is sent directly to the client. Use this sparingly — it can make debugging difficult if overused.

## Testing Interceptors

Interceptors are testable as plain classes:

```typescript
describe('TimingInterceptor', () => {
  it('should log request duration', async () => {
    const interceptor = new TimingInterceptor();
    const ctx = createMockRequestContext();
    const logSpy = vi.spyOn(ctx.log, 'info');

    const mockNext = async () => Response.json({ ok: true });

    const response = await interceptor.intercept(ctx, mockNext);

    expect(response.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(
      'Request completed',
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });
});
```

The `next` parameter in tests is just an async function that returns a Response. You control what the "inner" handler returns, making it easy to test both the pre-processing and post-processing logic.

[Previous: Guards & Authentication ←](./06-guards-and-authentication.md) | [Next: Configuration →](./08-configuration.md)
