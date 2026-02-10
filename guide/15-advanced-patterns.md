# Chapter 15: Advanced Patterns

This chapter covers patterns and techniques for building production-grade OriJS applications: extension functions for modular architecture, multi-tenancy, error handling strategies, and performance optimization.

## Extension Functions in Depth

Extension functions are OriJS's answer to NestJS modules. They're the primary mechanism for organizing large applications into cohesive, composable units.

### Anatomy of an Extension Function

```typescript
import type { OriApplication } from '@orijs/orijs';

export function useMonitors(app: OriApplication) {
  // 1. Register providers (bottom-up: db → repo → service)
  app
    .provider(MonitorDbService, [AppContext])
    .provider(MonitorRepository, [MonitorDbService, CacheService])
    .provider(MonitorClientService, [MonitorRepository]);

  // 2. Register controllers
  app.controller(MonitorController, [MonitorClientService]);

  // 3. Register event consumers
  app.consumer(MonitorCheckConsumer, [MonitorClientService]);

  // 4. Register lifecycle hooks
  app.context.onStartup(async () => {
    const service = app.getContainer().resolve(MonitorClientService);
    await service.initializeScheduler();
  });

  app.context.onShutdown(async () => {
    const service = app.getContainer().resolve(MonitorClientService);
    await service.stopScheduler();
  });
}
```

### Extension Dependencies

Extensions can depend on providers registered by other extensions. Since they all operate on the same DI container, the order of `.use()` calls matters:

```typescript
// Infrastructure extensions (no domain dependencies)
function useDatabase(app: OriApplication) {
  app.provider(DatabaseService);
  app.context.onStartup(async () => {
    const db = app.getContainer().resolve(DatabaseService);
    await db.connect();
  });
}

function useCaching(app: OriApplication) {
  app.provider(CacheService, [RedisClient]);
}

// Domain extensions (depend on infrastructure)
function useAuth(app: OriApplication) {
  app
    .provider(AuthService, [DatabaseService])
    .globalGuard(AuthGuard, [AuthService]);
}

function useMonitors(app: OriApplication) {
  app
    .provider(MonitorRepository, [DatabaseService, CacheService])
    .provider(MonitorService, [MonitorRepository])
    .controller(MonitorController, [MonitorService]);
}

// Compose — infrastructure first, then domain
Ori.create()
  .use(useDatabase)
  .use(useCaching)
  .use(useAuth)
  .use(useMonitors)
  .listen(3000);
```

### Parameterized Extensions

Extensions can accept configuration:

```typescript
interface CorsOptions {
  origins: string[];
  credentials?: boolean;
}

function useCors(options: CorsOptions) {
  return (app: OriApplication) => {
    app.cors({
      origin: options.origins,
      credentials: options.credentials ?? true,
    });
  };
}

// Usage
Ori.create()
  .use(useCors({
    origins: ['http://localhost:3000', 'https://myapp.com'],
    credentials: true,
  }))
  .listen(3000);
```

### Testing Extensions

Extensions are testable in isolation:

```typescript
describe('useMonitors', () => {
  it('should register all monitor providers', async () => {
    const app = Ori.create().disableSignalHandling();

    // Apply prerequisites
    useDatabase(app);
    useCaching(app);

    // Apply the extension under test
    useMonitors(app);

    await app.listen(0);

    // Verify providers are registered
    const controller = app.getContainer().resolve(MonitorController);
    expect(controller).toBeDefined();

    const service = app.getContainer().resolve(MonitorService);
    expect(service).toBeDefined();

    await app.stop();
  });
});
```

## Multi-Tenancy

Multi-tenant applications serve multiple organizations from a single deployment. OriJS supports this through guards, typed state, and consistent filtering patterns.

### Tenant Resolution Guard

```typescript
interface TenantState {
  user: AuthenticatedUser;
  tenant: {
    accountUuid: string;
    projectUuid: string;
  };
}

class TenantGuard implements OriGuard<TenantState> {
  constructor(private tenantService: TenantService) {}

  async canActivate(ctx: RequestContext<{ user: AuthenticatedUser }>): Promise<boolean> {
    const accountUuid = ctx.params.accountUuid ?? ctx.headers.get('x-account-id');
    const projectUuid = ctx.params.projectUuid ?? ctx.headers.get('x-project-id');

    if (!accountUuid || !projectUuid) return false;

    const hasAccess = await this.tenantService.verifyAccess(
      ctx.state.user.id,
      accountUuid,
      projectUuid,
    );

    if (!hasAccess) return false;

    ctx.state.tenant = { accountUuid, projectUuid };
    return true;
  }
}
```

### Tenant-Scoped Queries

Every database query filters by tenant:

```typescript
class MonitorDbService {
  public async findByProject(accountUuid: string, projectUuid: string): Promise<Monitor[]> {
    return sql`
      SELECT m.*
      FROM monitors m
      JOIN projects p ON p.id = m.project_id
      JOIN accounts a ON a.id = p.account_id
      WHERE a.uuid = ${accountUuid}
        AND p.uuid = ${projectUuid}
      ORDER BY m.name
    `;
  }
}
```

The `accountUuid + projectUuid` filter ensures that tenants can never access each other's data — even if there's a bug in the application layer, the query-level filter prevents data leaks.

### Tenant-Scoped Cache Keys

Include tenant identifiers in cache keys:

```typescript
class MonitorRepository {
  public async listMonitors(tenant: TenantContext): Promise<Monitor[]> {
    const cacheKey = `${tenant.accountUuid}:${tenant.projectUuid}`;
    return this.cache.getOrSet(
      'monitor', 'listByProject', cacheKey,
      async () => this.dbService.findByProject(tenant.accountUuid, tenant.projectUuid),
    );
  }
}
```

## Error Handling Strategy

### Domain Errors

Define domain-specific error classes for predictable error handling:

```typescript
// In types-shared
class MonitorNotFoundError extends Error {
  public readonly code = 'MONITOR_NOT_FOUND';

  constructor(public readonly monitorUuid: string) {
    super(`Monitor not found: ${monitorUuid}`);
    this.name = 'MonitorNotFoundError';
  }
}

class MonitorLimitExceededError extends Error {
  public readonly code = 'MONITOR_LIMIT_EXCEEDED';

  constructor(
    public readonly currentCount: number,
    public readonly maxAllowed: number,
  ) {
    super(`Monitor limit exceeded: ${currentCount}/${maxAllowed}`);
    this.name = 'MonitorLimitExceededError';
  }
}
```

### Error Mapping Interceptor

Map domain errors to HTTP responses in a single place:

```typescript
class DomainErrorInterceptor implements OriInterceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    try {
      return await next();
    } catch (error) {
      if (error instanceof MonitorNotFoundError) {
        return ctx.response.notFound(error.message);
      }
      if (error instanceof MonitorLimitExceededError) {
        return Response.json(
          { error: error.code, message: error.message, limit: error.maxAllowed },
          { status: 422 },
        );
      }
      if (error instanceof UnauthorizedError) {
        return ctx.response.unauthorized(error.message);
      }
      // Unknown error — let the framework handle it (500)
      throw error;
    }
  }
}

// Register globally
Ori.create()
  .globalInterceptor(DomainErrorInterceptor)
  // ...
```

This pattern keeps error handling out of individual controllers and provides a consistent error response format across the entire API.

### Error Wrapping at Boundaries

Wrap third-party errors at the boundary where they enter your system:

```typescript
class StripePaymentService {
  constructor(private stripe: StripeClient) {}

  public async charge(customerId: string, amount: number): Promise<PaymentResult> {
    try {
      const intent = await this.stripe.paymentIntents.create({
        customer: customerId,
        amount: Math.round(amount * 100),
        currency: 'usd',
      });
      return { id: intent.id, status: intent.status };
    } catch (error) {
      // Wrap Stripe error — don't let it leak upstream
      if (error instanceof Stripe.errors.StripeCardError) {
        throw new PaymentDeclinedError(error.message, { cause: error });
      }
      throw new PaymentProcessingError('Payment processing failed', { cause: error });
    }
  }
}
```

Using `{ cause: error }` preserves the original error for debugging while presenting a domain-appropriate error to callers.

## Structured Logging

OriJS's logger (inspired by Pino) provides structured logging with automatic context propagation:

### Log Levels

```typescript
ctx.log.trace('Detailed debug info');   // Level 10 — very verbose
ctx.log.debug('Debug information');      // Level 20
ctx.log.info('Normal operation');        // Level 30
ctx.log.warn('Unusual but not broken'); // Level 40
ctx.log.error('Something went wrong');  // Level 50
ctx.log.fatal('Unrecoverable error');   // Level 60
```

### Structured Context

Always log structured data, not string interpolation:

```typescript
// Bad — hard to parse, search, and aggregate
ctx.log.info(`User ${userId} created monitor ${monitorId} in project ${projectId}`);

// Good — structured, searchable, aggregatable
ctx.log.info('Monitor created', {
  userId,
  monitorId,
  projectId,
  monitorType: 'http',
});
```

### Automatic Request Context

Within request handlers, the logger automatically includes:
- `requestId`: Unique UUID for this request
- `method`: HTTP method
- `path`: Request path

This is powered by `AsyncLocalStorage` — the logger reads the current request context without any explicit passing.

```typescript
private createMonitor = async (ctx: RequestContext) => {
  ctx.log.info('Creating monitor', { url: ctx.body.url });
  // Log output includes: { requestId: "abc-123", method: "POST", path: "/monitors", url: "..." }
};
```

### Transport Configuration

```typescript
// Development — pretty-printed, colorized
Ori.create().logger({ level: 'debug', transport: 'pretty' });

// Production — JSON for log aggregation (ELK, Datadog, etc.)
Ori.create().logger({ level: 'info', transport: 'json' });
```

## CORS Configuration

```typescript
Ori.create()
  .cors({
    origin: ['http://localhost:3000', 'https://myapp.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,  // Cache preflight for 24 hours
  })
  .listen(3000);
```

OriJS pre-computes CORS headers at startup for static origins, so there's no per-request overhead. For array origins, it checks the request's `Origin` header against the allowed list.

## Performance Patterns

### Singleton Optimization

Since all providers are singletons, expensive initialization happens once:

```typescript
class GeoIpService {
  private database: MaxMindDatabase;

  constructor() {
    // Loaded once at bootstrap, shared across all requests
    this.database = MaxMind.open('./GeoLite2-City.mmdb');
  }

  public lookup(ip: string): GeoLocation {
    return this.database.get(ip);
  }
}
```

### Avoiding N+1 with DataLoader Pattern

When fetching related entities for a list:

```typescript
class MonitorService {
  public async listWithStatus(projectId: string): Promise<MonitorWithStatus[]> {
    // One query for monitors
    const monitors = await this.monitorRepo.listByProject(projectId);

    // One query for all statuses (not N queries)
    const monitorIds = monitors.map(m => m.uuid);
    const statuses = await this.statusRepo.findByMonitorIds(monitorIds);

    // Combine in memory
    const statusMap = new Map(statuses.map(s => [s.monitorId, s]));
    return monitors.map(m => ({
      ...m,
      status: statusMap.get(m.uuid) ?? null,
    }));
  }
}
```

### Connection Pooling

Manage database connections efficiently:

```typescript
function useDatabase(app: OriApplication) {
  const pool = createPool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeout: 30000,
  });

  app.providerWithToken(DB_POOL, { useFactory: () => pool });

  app.context.onShutdown(async () => {
    await pool.end();
  });
}
```

## Production Checklist

Before deploying an OriJS application to production:

### Configuration
- [ ] All required environment variables documented and validated
- [ ] Secrets stored in environment variables, not in code
- [ ] Different config for development, staging, and production
- [ ] Graceful shutdown timeout configured appropriately

### Security
- [ ] Authentication guard applied globally (or per-controller)
- [ ] Tenant filtering on all queries (accountUuid + projectUuid)
- [ ] CORS configured with specific origins (not `*`)
- [ ] Request validation on all POST/PUT/PATCH endpoints
- [ ] Error messages don't leak internal details in production

### Performance
- [ ] Caching configured for frequently-accessed data
- [ ] Singleflight enabled for high-traffic cache entries
- [ ] Database connection pooling configured
- [ ] No N+1 queries in list endpoints

### Observability
- [ ] Structured logging with JSON transport
- [ ] Request IDs propagated through event chains
- [ ] Health check endpoint available
- [ ] Log level configurable via environment variable

### Reliability
- [ ] Event consumers are idempotent
- [ ] Workflow steps have compensation handlers
- [ ] Graceful shutdown drains connections and queues
- [ ] Database migrations run before deployment

[Previous: Testing ←](./14-testing.md) | [Next: Migration from NestJS →](./16-migration-from-nestjs.md)
