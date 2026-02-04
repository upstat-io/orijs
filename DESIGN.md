# OriJS Design Document

This document tracks design decisions, pending discussions, and architectural choices for OriJS.

## Philosophy

OriJS is a NestJS-inspired framework for Bun that prioritizes:

1. **Testability** - Services are plain classes, trivially mockable
2. **Explicitness** - No decorator magic, no reflect-metadata
3. **Simplicity** - Minimal runtime overhead, clear data flow
4. **Type Safety** - Full TypeScript support without ceremony

We are **not** creating a 1:1 NestJS clone. We're improving on the design where NestJS falls short.

---

## Current State

### Implemented Features

| Feature                       | Status  | Notes                                                  |
| ----------------------------- | ------- | ------------------------------------------------------ |
| Controllers                   | ✅ Done | Interface-based with RouteBuilder                      |
| DI Container                  | ✅ Done | Explicit deps, singleton caching, startup validation   |
| DI Validation                 | ✅ Done | Missing deps, constructor mismatch, circular detection |
| Provider Organization         | ✅ Done | Extension method pattern, app-local wiring             |
| Guards                        | ✅ Done | `canActivate()` interface                              |
| Interceptors                  | ✅ Done | Onion model wrapping                                   |
| Context                       | ✅ Done | Request, params, query, body, state, log               |
| Guard/Interceptor inheritance | ✅ Done | Global → Controller → Route                            |
| Logging                       | ✅ Done | Pino-inspired, AsyncLocalStorage context               |
| Validation                    | ✅ Done | TypeBox, Standard Schema, custom validators            |

### Planned Features

| Feature            | Priority | Notes                   |
| ------------------ | -------- | ----------------------- |
| Exception Filters  | High     | Custom error handling   |
| Resource Lifecycle | High     | See discussion below    |
| WebSockets         | Medium   | Room-based broadcasting |
| Event System       | Medium   | Async pub/sub           |

---

## Implemented Designs

### Logging ✅

**Status:** Implemented

Pino-inspired structured logging with transport-based separation and AsyncLocalStorage for request context.

**Key Features:**

- Child loggers with `.with()` for context
- Request-scoped logger via `ctx.log` and `requestContext()`
- Built-in transports: `transports.pretty()`, `transports.json()`
- Automatic request ID propagation
- Fallback to console.log in unit tests

**Usage:**

```typescript
// Controller - use ctx.log
r.get('/:id', (ctx) => {
	ctx.log.info('Fetching user', { id: ctx.params.id });
	return this.users.findById(ctx.params.id);
});

// Service - use requestContext()
class UserService {
	findById(id: string) {
		const { log } = requestContext();
		log.info('Looking up user', { id });
		return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
	}
}

// Configuration
Ori.create()
	.logger({
		level: 'info',
		transports: [transports.pretty()]
	})
	.listen(3000);
```

**File Structure:**

```
src/logging/
├── logger.ts       # Logger class with child logger support
├── context.ts      # AsyncLocalStorage for request context
├── transports.ts   # Built-in transports (pretty, json)
└── index.ts
```

---

### Validation ✅

**Status:** Implemented

Two validation approaches: TypeBox (default) and custom validators.

**Key Features:**

- TypeBox as default with `Type` and `t` exports
- Custom sync/async validators for business logic (database lookups, etc.)
- Built-in helpers: `Params.uuid()`, `Query.pagination()`, etc.
- Validation runs before handler, returns 400 on failure

**Usage:**

```typescript
import { Type, Params, Query } from 'orijs';

class UsersController implements OriController {
	configure(r: RouteBuilder) {
		// TypeBox schema
		r.get('/:id', (ctx) => this.findById(ctx), {
			params: Params.uuid('id')
		});

		// Query validation with helpers
		r.get('/', (ctx) => this.list(ctx), {
			query: Query.pagination({ maxLimit: 50 })
		});

		// Body validation
		r.post('/', (ctx) => this.create(ctx), {
			body: Type.Object({
				name: Type.String({ minLength: 1 }),
				email: Type.String({ pattern: '^[^@]+@[^@]+\\.[^@]+$' })
			})
		});

		// Custom async validator
		r.post('/register', (ctx) => this.register(ctx), {
			body: async (data) => {
				const { email } = data as { email: string };
				if (await this.users.emailExists(email)) {
					throw new Error('Email already registered');
				}
				return data;
			}
		});
	}
}
```

**Built-in Helpers:**

```typescript
// Params helpers
Params.uuid('id'); // UUID validation
Params.uuid('orgId', 'userId'); // Multiple UUIDs
Params.string('slug', { minLength: 1, maxLength: 100 });
Params.number('id', { min: 1 });

// Query helpers
Query.pagination({ maxLimit: 100 }); // { page?, limit? }
Query.search({ minLength: 2 }); // { q? }
Query.sort({ allowed: ['createdAt', 'name'] }); // { sortBy?, order? }
```

**File Structure:**

```
src/validation/
├── types.ts        # Schema types, validate function, Standard Schema interface
├── params.ts       # Params.uuid(), Params.string(), Params.number()
├── query.ts        # Query.pagination(), Query.search(), Query.sort()
└── index.ts
```

---

### DI Container & Validation ✅

**Status:** Implemented

The DI container validates the dependency graph at startup, catching configuration errors before any HTTP requests are handled.

**Key Features:**

- **Singleton-only scope** - All services are singletons by design (no request/transient scopes)
- Missing dependency detection with exact parameter names
- Constructor parameter count validation
- Circular dependency detection using DFS (O(V+E))
- Clear error messages showing exactly what's wrong
- Skip validation for pre-instantiated services (`providerInstance`)

**Why singleton-only?**

NestJS offers `DEFAULT` (singleton), `REQUEST`, and `TRANSIENT` scopes. In practice:

- 99% of backend services are stateless and work fine as singletons
- Request-scoped data (current user, tenant, request ID) is better passed through method parameters via context objects
- Transient scope is rarely needed and adds complexity

OriJS takes the opinionated stance: singletons + context passing. This is simpler, easier to test, and covers real-world needs without the complexity of scope management.

**Startup Validation:**

```typescript
// This will fail at startup with a clear error:
Ori.create()
	.provider(UserService, [DatabaseService]) // DatabaseService not registered!
	.listen(3000);

// Error output:
// Dependency injection validation failed:
//
//   1. UserService depends on DatabaseService, but DatabaseService is not registered
//
// Fix: Register missing providers with .provider(ServiceClass, [Dep1, Dep2, ...])
```

**Missing Constructor Parameters:**

```typescript
class IdentityService {
  constructor(
    private userRepo: UserRepository,
    private accountRepo: AccountRepository,
    private events: EventSystemService
  ) {}
}

// Missing dependencies in registration:
.provider(IdentityService, [UserRepository])  // Missing 2 deps!

// Error output:
// IdentityService has missing dependencies:
//    Constructor: (userRepo, accountRepo, events)
//    Declared:    [UserRepository]
//    Missing:     accountRepo, events
```

**Circular Dependency Detection:**

```typescript
.provider(ServiceA, [ServiceB])
.provider(ServiceB, [ServiceA])  // Circular!

// Error: Circular dependency: ServiceA -> ServiceB -> ServiceA
```

**Pre-instantiated Services:**

```typescript
// For services that need external config (DB connections, etc.)
const sql = new SQL({ url: process.env.DATABASE_URL });

Ori.create()
	.providerInstance(DbSqlService, new DbSqlService(sql)) // Skips constructor validation
	.provider(UserService, [DbSqlService]);
```

---

### Provider Organization ✅

**Status:** Implemented

Inspired by .NET Core's `IServiceCollection` extension method pattern. Provider wiring is an **app concern**, not a package concern.

**The Problem:**

NestJS couples services to the framework via decorators and modules:

```typescript
// NestJS way - service is coupled to framework
@Injectable()
export class UserService {
	constructor(@Inject(DATABASE) private db: Database) {}
}

// Testing requires framework machinery
const module = await Test.createTestingModule({
	providers: [UserService, { provide: DATABASE, useValue: mockDb }]
}).compile();
```

**The OriJS Way:**

Services are plain TypeScript classes. Packages export classes, apps wire them:

```
packages/                           # Zero framework coupling
  ori-db-shared/
    src/
      db-user.service.ts           # Plain TypeScript class
      index.ts                     # Just exports classes

apps/                              # App-local wiring
  backend-public-server/
    src/
      providers.ts                 # Only what THIS app needs
      app.ts
```

**Package exports plain classes:**

```typescript
// packages/ori-db-shared/src/db-user.service.ts
export class DbUserService {
	constructor(
		private dbSql: DbSqlService,
		private userMapper: UserMapperService
	) {}

	async findByUuid(uuid: string): Promise<User | undefined> {
		// ...
	}
}

// packages/ori-db-shared/src/index.ts
export { DbUserService } from './db-user.service';
export { DbSqlService } from './db-sql.service';
export { UserMapperService } from './services/mapper/user-mapper.service';
// ... just class exports, no framework code
```

**App defines its wiring locally:**

```typescript
// apps/backend-public-server/src/providers.ts
import { Application } from '@upstat/orijs';
import { SQL } from 'bun';
import {
	DbSqlService,
	DbUserService,
	UserMapperService
	// ... only import what this app needs
} from '@upstat/ori-db-shared';

export function addDatabase(app: Application, sql: SQL): Application {
	return app
		.providerInstance(DbSqlService, new DbSqlService(sql))
		.provider(UserMapperService)
		.provider(DbUserService, [DbSqlService, UserMapperService]);
}

export function addRepositories(app: Application): Application {
	return app.provider(UserRepository, [DbUserService]).provider(AccountRepository, [DbAccountService]);
}

export function addServices(app: Application): Application {
	return app
		.provider(EventSystemService)
		.provider(IdentityService, [UserRepository, AccountRepository, EventSystemService]);
}
```

**App.ts stays clean:**

```typescript
// apps/backend-public-server/src/app.ts
import { Ori } from '@upstat/orijs';
import { SQL } from 'bun';
import { addDatabase, addRepositories, addServices } from './providers';
import { HealthController } from './controllers/health.controller';
import { IdentityController } from './controllers/identity.controller';

const sql = new SQL({ url: process.env.DATABASE_URL });

Ori.create()
	.use((app) => addDatabase(app, sql))
	.use(addRepositories)
	.use(addServices)
	.controller('/internal', HealthController, [])
	.controller('/internal/identity', IdentityController, [IdentityService])
	.listen(8001);
```

**Benefits:**

| Aspect       | NestJS                               | OriJS                               |
| ------------ | ------------------------------------ | ----------------------------------- |
| Services     | Coupled to framework (`@Injectable`) | Plain TypeScript classes            |
| Testing      | Requires `TestingModule`             | Just `new Service(mock1, mock2)`    |
| Package deps | Depends on `@nestjs/common`          | Zero framework dependencies         |
| Wiring       | Distributed across modules           | Centralized in app's `providers.ts` |
| Flexibility  | Module re-exports constrain usage    | Each app wires only what it needs   |

**Testing is trivial:**

```typescript
// No framework machinery needed
describe('DbUserService', () => {
	it('should find user by uuid', async () => {
		const mockSql = { sql: jest.fn() };
		const mockMapper = { mapUser: jest.fn() };

		const service = new DbUserService(mockSql, mockMapper);

		await service.findByUuid('abc-123');

		expect(mockSql.sql).toHaveBeenCalled();
	});
});
```

**Why app-local, not package-local?**

1. **Packages stay dependency-free** - No orijs import in shared packages
2. **Each app wires only what it needs** - No unused providers
3. **Full control** - Apps can wire the same classes differently
4. **No circular deps** - Packages don't depend on framework, framework doesn't depend on packages

---

## Pending Design Discussions

### 1. Lifecycle & Resource Management

**Problem:** NestJS pollutes services with lifecycle interfaces (`OnModuleInit`, `OnApplicationBootstrap`). This makes services framework-aware and harder to test.

**Current Leaning:** Resource Pattern for resources that need lifecycle (DB, cache connections). Regular providers for stateless services.

```typescript
Ori.create()
	.resource(Database, {
		create: () => Database.connect(),
		destroy: (db) => db.close()
	})
	.provider(UserService, [Database]);
```

**Decision:** TBD

---

### 2. Exception Handling

**Problem:** Currently returns generic JSON errors. Real apps need:

- Custom error payloads
- Different error formats (API vs HTML)
- Error logging/tracking
- Status code mapping

**Options:**

#### Option A: Exception Filters (NestJS-style)

```typescript
class HttpExceptionFilter implements ExceptionFilter {
	catch(error: Error, ctx: Context): Response {
		return new Response(JSON.stringify({ error: error.message }), {
			status: 500
		});
	}
}
```

#### Option B: Error Handler Function

```typescript
Ori.create().onError((error, ctx) => {
	if (error instanceof ValidationError) {
		return Response.json({ errors: error.issues }, { status: 400 });
	}
	return Response.json({ error: 'Internal Error' }, { status: 500 });
});
```

#### Option C: Typed Exceptions with Auto-Mapping

```typescript
throw new HttpException(400, { code: 'VALIDATION_ERROR', issues });
// Automatically serialized to JSON response
```

**Decision:** TBD

---

### 3. Modules

**Status:** ✅ Resolved - No modules needed

**Decision:** Use the Provider Organization pattern (see Implemented Designs above) instead of modules.

**Rationale:**

- NestJS modules couple services to the framework
- The `.use()` extension method pattern provides the same organization benefits
- App-local `providers.ts` files give full control without framework complexity
- Services stay as plain TypeScript classes, trivially testable

**The pattern that replaced modules:**

```typescript
// providers.ts - app-local wiring functions
export function addDatabase(app: Application, sql: SQL): Application { ... }
export function addRepositories(app: Application): Application { ... }
export function addServices(app: Application): Application { ... }

// app.ts - clean composition
Ori.create()
  .use(app => addDatabase(app, sql))
  .use(addRepositories)
  .use(addServices)
  .listen(8001);
```

---

### 4. WebSockets

**Problem:** Real-time features need WebSocket support.

**Requirements:**

- Room-based broadcasting
- Redis adapter for horizontal scaling
- Authentication on connection
- Rate limiting connections

**Options:**

#### Option A: Built-in WebSocket Support

```typescript
class ChatGateway implements WebSocketGateway {
	onMessage(client: WebSocket, data: unknown) {}
}
```

#### Option B: Bun.serve WebSocket Integration

```typescript
Ori.create().websocket('/ws', {
	open(ws) {},
	message(ws, message) {},
	close(ws) {}
});
```

#### Option C: Separate Package

- Keep core HTTP-only
- `@orijs/websocket` package for WS support

**Decision:** TBD

---

### 5. Watch Mode / Hot Reload

**Problem:** Developer experience requires auto-restart on file changes.

**Current State:** Using `bun --watch run example/src/app.ts`.

**Options:**

- Bun's built-in `--watch` (current approach)
- Built-in file watcher
- Hot Module Replacement (HMR)
- CLI tool (`ori dev`)

**Decision:** TBD - Start with `bun --watch`, evaluate if more is needed

---

### 6. Event System

**Problem:** Async event pub/sub for decoupled processing.

**Options:**

#### Option A: Simple EventEmitter

```typescript
class AlertService {
	constructor(private events: EventBus) {}

	async create(alert: Alert) {
		await this.save(alert);
		this.events.emit('alert.created', alert);
	}
}
```

#### Option B: Typed Events

```typescript
type AppEvents = {
	'alert.created': Alert;
	'user.updated': User;
};

class AlertService {
	constructor(private events: EventBus<AppEvents>) {}

	async create(alert: Alert) {
		this.events.emit('alert.created', alert); // type-safe
	}
}
```

**Decision:** TBD

---

## Reference: Upstat Backend Complexity

Target application for framework validation:

- 25,174 lines of TypeScript
- 31 controllers, 34 services
- ~223 HTTP routes
- 6 guards (auth, permissions, rate-limiting)
- 3 interceptors (ETag, ID removal, chaos)
- WebSocket gateway with Redis rooms
- Event-driven architecture (113 event publish calls)
- TypeBox validation throughout
- Multi-tenant with dual-level RBAC

---

## Principles

When making design decisions, prefer:

1. **Explicit over implicit** - No magic, clear data flow
2. **Composition over inheritance** - Small pieces that combine
3. **Pure services** - No framework interfaces in business logic
4. **Easy testing** - Unit tests without framework machinery
5. **Progressive complexity** - Simple by default, opt-in to advanced features

---

## Open Questions

- [ ] How should resource lifecycle work?
- [x] Validation: TypeBox default, Standard Schema compatible, custom validators
- [ ] Exception filters vs error handler function?
- [x] Do we need modules or can we stay flat? → **No modules, use Provider Organization pattern**
- [x] DI validation at startup? → **Yes, validates missing deps, constructor mismatch, circular deps**
- [ ] Built-in WebSocket or separate package?
- [x] Logging: Pino-inspired with AsyncLocalStorage context
- [ ] Watch mode: use Bun's --watch or build our own?
- [ ] Event system design?

---

## Changelog

| Date       | Decision                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------- |
| 2024-01-02 | Created design document                                                                      |
| 2024-01-02 | Researched lifecycle patterns across frameworks                                              |
| 2024-01-02 | Leaning toward Resource Pattern for lifecycle                                                |
| 2024-01-02 | Finalized logging design: Pino-inspired, transport-based, AsyncLocalStorage for context      |
| 2024-01-02 | Finalized validation design: TypeBox default, Standard Schema support, Elysia-style options  |
| 2025-01-02 | Implemented logging system with pretty/json transports                                       |
| 2025-01-02 | Implemented validation with TypeBox and custom validators                                    |
| 2025-01-02 | Implemented DI validation: missing deps, constructor mismatch, circular dependency detection |
| 2025-01-02 | Resolved modules question: No modules needed, use Provider Organization pattern instead      |
| 2025-01-02 | Documented Provider Organization pattern inspired by .NET Core IServiceCollection extensions |
| 2025-01-02 | Decided singleton-only DI scope - no request/transient scopes needed                         |
