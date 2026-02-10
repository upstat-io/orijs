# Chapter 18: Migration from NestJS

This chapter provides a step-by-step guide for teams migrating from NestJS to OriJS. The frameworks share many architectural concepts — dependency injection, controllers, guards, interceptors — but differ in how they express them. The migration is largely mechanical: removing decorators, making dependencies explicit, and replacing modules with extension functions.

## Conceptual Mapping

Before diving into code, here is how NestJS concepts map to OriJS:

| NestJS Concept | OriJS Equivalent | Notes |
|---|---|---|
| `@Module()` | Extension function | Plain function that registers providers |
| `@Controller('path')` | `app.controller('/path', MyController, [deps])` | Class implements `OriController` |
| `@Injectable()` | Nothing needed | All classes can be providers |
| `@Inject()` | Explicit dependency array | `app.provider(Service, [Dep1, Dep2])` |
| `@Get()`, `@Post()`, etc. | `r.get()`, `r.post()`, etc. | RouteBuilder fluent API |
| `@Param()`, `@Query()`, `@Body()` | `ctx.params`, `ctx.query`, `ctx.json()` | Direct context access |
| `@UseGuards()` | `r.guard(GuardClass)` | RouteBuilder method |
| `@UseInterceptors()` | `r.intercept(InterceptorClass)` | RouteBuilder method |
| `@UsePipes()` | `r.pipe(PipeClass)` | RouteBuilder method |
| `CanActivate` | `Guard` interface | `canActivate(ctx: RequestContext)` |
| `NestInterceptor` | `Interceptor` interface | `intercept(ctx, next)` |
| `PipeTransform` | `Pipe` interface | `transform(value, metadata)` |
| `ExecutionContext` | `RequestContext` | Request-scoped context |
| `class-validator` DTOs | TypeBox schemas | `Type.Object({ ... })` |
| `class-transformer` | `@orijs/mapper` | SQL result mapping |
| `@nestjs/config` | `@orijs/config` | `EnvConfigProvider`, `ValidatedConfig` |
| `EventEmitter2` | `Event.define()` + consumers | Type-safe event system |
| `@nestjs/bull` | `@orijs/bullmq` | BullMQ event/workflow providers |
| `@nestjs/cache-manager` | `@orijs/cache` | Entity-based caching |
| `@nestjs/websockets` | `@orijs/websocket` | Native Bun WebSockets |
| `TestingModule` | `new MyClass(deps)` | Plain class instantiation |
| `ConfigService` | `AppContext.config` / `ValidatedConfig` | Validated config provider |
| `Logger` (NestJS) | `Logger` (`@orijs/logging`) | Pino-inspired structured logging |
| `ModuleRef` | `AppContext.resolve()` | Dynamic resolution (use sparingly) |
| `DynamicModule` | Parameterized extension function | Function with config args |
| `forRoot()` / `forFeature()` | Extension function with parameters | `addDatabase(app, config)` |

## Step 1: Convert Services

NestJS services use `@Injectable()` and implicit DI via reflect-metadata. OriJS services are plain classes with explicit dependency registration.

### Before (NestJS)

```typescript
// user.service.ts
import { Injectable } from '@nestjs/common';
import { UserRepository } from './user.repository';
import { EmailService } from '../email/email.service';

@Injectable()
export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly emailService: EmailService,
  ) {}

  async createUser(data: CreateUserDto): Promise<User> {
    const user = await this.userRepository.create(data);
    await this.emailService.sendWelcome(user.email);
    return user;
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findById(id);
  }
}
```

### After (OriJS)

```typescript
// user-service.ts
import type { UserRepository } from './user-repository';
import type { EmailService } from '../email/email-service';

class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly emailService: EmailService,
  ) {}

  public async createUser(data: CreateUserInput): Promise<User> {
    const user = await this.userRepository.create(data);
    await this.emailService.sendWelcome(user.email);
    return user;
  }

  public async findById(id: string): Promise<User | null> {
    return this.userRepository.findById(id);
  }
}
```

**What changed:**

1. Removed `@Injectable()` decorator
2. Removed NestJS import
3. Added explicit `public`/`private` visibility modifiers (OriJS convention)
4. File renamed to kebab-case (OriJS convention: `user-service.ts` not `user.service.ts`)

**Registration** (in your extension function or app setup):

```typescript
app.provider(UserService, [UserRepository, EmailService]);
```

The dependency array `[UserRepository, EmailService]` must match the constructor parameter order exactly. TypeScript enforces this at compile time.

## Step 2: Convert Controllers

NestJS controllers use class-level and method-level decorators. OriJS controllers implement the `OriController` interface and use the `RouteBuilder` fluent API.

### Before (NestJS)

```typescript
// user.controller.ts
import { Controller, Get, Post, Body, Param, UseGuards, HttpCode } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('users')
@UseGuards(AuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateUserDto): Promise<User> {
    return this.userService.createUser(body);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<User> {
    const user = await this.userService.findById(id);
    if (!user) throw new NotFoundException();
    return user;
  }

  @Get()
  async findAll(): Promise<User[]> {
    return this.userService.findAll();
  }
}
```

### After (OriJS)

```typescript
// user-controller.ts
import type { OriController, RouteBuilder, RequestContext } from '@orijs/orijs';
import { Type } from '@orijs/validation';
import { AuthGuard } from '../auth/auth-guard';
import type { UserService } from './user-service';

const CreateUserBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  email: Type.String({ format: 'email' }),
});

interface AuthState {
  user: AuthenticatedUser;
}

class UserController implements OriController<AuthState> {
  constructor(private readonly userService: UserService) {}

  public configure(r: RouteBuilder<AuthState>): void {
    r.guard(AuthGuard);

    r.post('/', this.create, { body: CreateUserBody });
    r.get('/:id', this.findOne);
    r.get('/', this.findAll);
  }

  private create = async (ctx: RequestContext<AuthState>): Promise<Response> => {
    const body = await ctx.json<{ name: string; email: string }>();
    const user = await this.userService.createUser(body);
    return Response.json(user, { status: 201 });
  };

  private findOne = async (ctx: RequestContext<AuthState>): Promise<Response> => {
    const id = ctx.params.id;
    const user = await this.userService.findById(id);
    if (!user) {
      return Response.json({ error: 'Not Found' }, { status: 404 });
    }
    return Response.json(user);
  };

  private findAll = async (_ctx: RequestContext<AuthState>): Promise<Response> => {
    const users = await this.userService.findAll();
    return Response.json(users);
  };
}
```

**Registration:**

```typescript
app.controller('/users', UserController, [UserService]);
```

**Key differences:**

1. No `@Controller()` decorator — path is provided at registration
2. No `@Get()`, `@Post()` — use `r.get()`, `r.post()` in `configure()`
3. No `@Body()`, `@Param()` — use `ctx.json()`, `ctx.params`
4. No `@UseGuards()` — use `r.guard()` in `configure()`
5. Handlers are **arrow function properties** (not methods) to preserve `this` binding
6. Handlers return `Response` objects directly
7. Validation schemas defined with TypeBox (not class-validator DTOs)

## Step 3: Convert DTOs to TypeBox

NestJS uses `class-validator` with decorator-based DTOs. OriJS uses TypeBox schemas that provide both runtime validation and compile-time types from a single definition.

### Before (NestJS)

```typescript
// create-user.dto.ts
import { IsString, IsEmail, MinLength, MaxLength, IsOptional, IsEnum } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsEmail()
  email: string;

  @IsEnum(['admin', 'member'])
  role: 'admin' | 'member';

  @IsOptional()
  @IsString()
  bio?: string;
}
```

### After (OriJS)

```typescript
// user-schemas.ts
import { Type, type Static } from '@orijs/validation';

export const CreateUserBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  email: Type.String({ format: 'email' }),
  role: Type.Union([Type.Literal('admin'), Type.Literal('member')]),
  bio: Type.Optional(Type.String()),
});

// TypeScript type is derived from the schema — no duplication
export type CreateUserInput = Static<typeof CreateUserBody>;
// CreateUserInput = { name: string; email: string; role: 'admin' | 'member'; bio?: string }
```

**Common TypeBox patterns:**

```typescript
// Required string with constraints
Type.String({ minLength: 1, maxLength: 255 })

// Optional field
Type.Optional(Type.String())

// Enum / union
Type.Union([Type.Literal('active'), Type.Literal('inactive')])

// Number with range
Type.Number({ minimum: 0, maximum: 100 })

// Integer
Type.Integer({ minimum: 1 })

// Boolean
Type.Boolean()

// Array
Type.Array(Type.String())

// Nested object
Type.Object({
  address: Type.Object({
    street: Type.String(),
    city: Type.String(),
  }),
})

// UUID
Type.String({ format: 'uuid' })

// Date string
Type.String({ format: 'date-time' })

// Email
Type.String({ format: 'email' })

// Nullable
Type.Union([Type.String(), Type.Null()])
```

## Step 4: Convert Guards

NestJS guards implement `CanActivate` and receive an `ExecutionContext`. OriJS guards implement `Guard` and receive a `RequestContext`.

### Before (NestJS)

```typescript
// auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    const user = await this.authService.validateToken(token);
    if (!user) {
      throw new UnauthorizedException('Invalid token');
    }

    request.user = user;
    return true;
  }
}
```

### After (OriJS)

```typescript
// auth-guard.ts
import type { Guard, RequestContext } from '@orijs/orijs';
import type { AuthService } from './auth-service';

class AuthGuard implements Guard {
  constructor(private readonly authService: AuthService) {}

  public async canActivate(ctx: RequestContext): Promise<boolean> {
    const header = ctx.request.headers.get('authorization');
    const token = header?.replace('Bearer ', '');

    if (!token) return false;

    const user = await this.authService.validateToken(token);
    if (!user) return false;

    ctx.set('user', user);
    return true;
  }
}
```

**Key differences:**

1. No `@Injectable()` — guards are plain classes
2. No `ExecutionContext.switchToHttp()` — direct access to `RequestContext`
3. No exceptions for denial — return `false` (framework returns 403)
4. No `request.user = user` — use `ctx.set('user', user)` for type-safe state
5. Guard dependencies are registered explicitly: `.provider(AuthGuard, [AuthService])`

## Step 5: Convert Modules to Extension Functions

NestJS modules organize providers, controllers, and imports. OriJS replaces them with extension functions.

### Before (NestJS)

```typescript
// user.module.ts
@Module({
  imports: [DatabaseModule, AuthModule, EmailModule],
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService],
})
export class UserModule {}

// app.module.ts
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    UserModule,
    ProductModule,
    OrderModule,
  ],
})
export class AppModule {}

// main.ts
const app = await NestFactory.create(AppModule);
await app.listen(3000);
```

### After (OriJS)

```typescript
// extensions/add-users.ts
import type { OriApplication } from '@orijs/orijs';

export function addUsers(app: OriApplication): OriApplication {
  return app
    .provider(UserRepository, [DbService])
    .provider(UserService, [UserRepository, EmailService])
    .controller('/users', UserController, [UserService]);
}

// extensions/add-products.ts
export function addProducts(app: OriApplication): OriApplication {
  return app
    .provider(ProductRepository, [DbService])
    .provider(ProductService, [ProductRepository, CacheService])
    .controller('/products', ProductController, [ProductService]);
}

// app.ts
import { Ori } from '@orijs/orijs';

Ori.create()
  .use(app => addConfig(app))
  .use(app => addDatabase(app, sql))
  .use(addAuth)
  .use(addUsers)
  .use(addProducts)
  .use(addOrders)
  .listen(3000);
```

**Key differences:**

1. No module classes — extension functions are plain functions
2. No `imports` / `exports` — all providers are globally available
3. No `forRoot()` / `forFeature()` — use parameterized extension functions
4. No circular module dependencies — extension functions have no dependency graph
5. Conditional modules are trivial: `if (isDev) app.use(addDevTools)`

### Converting Dynamic Modules

NestJS `DynamicModule` patterns (like `ConfigModule.forRoot()`) become parameterized extension functions:

```typescript
// NestJS
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: 'DATABASE_OPTIONS', useValue: options },
        DatabaseService,
      ],
      exports: [DatabaseService],
      global: true,
    };
  }
}

// OriJS
export function addDatabase(app: OriApplication, options: DatabaseOptions): OriApplication {
  const sql = new SQL(options);
  return app
    .providerInstance(SQL, sql)
    .provider(DatabaseService, [SQL]);
}
```

## Step 6: Convert Events

NestJS typically uses `@nestjs/event-emitter` (EventEmitter2) or `@nestjs/microservices` for events. OriJS uses `Event.define()` with type-safe consumers.

### Before (NestJS)

```typescript
// events/user-created.event.ts
export class UserCreatedEvent {
  constructor(
    public readonly userId: string,
    public readonly email: string,
  ) {}
}

// user.service.ts
@Injectable()
export class UserService {
  constructor(private eventEmitter: EventEmitter2) {}

  async createUser(data: CreateUserDto): Promise<User> {
    const user = await this.repo.create(data);
    this.eventEmitter.emit('user.created', new UserCreatedEvent(user.id, user.email));
    return user;
  }
}

// listeners/user-created.listener.ts
@Injectable()
export class UserCreatedListener {
  constructor(private emailService: EmailService) {}

  @OnEvent('user.created')
  async handleUserCreated(event: UserCreatedEvent): Promise<void> {
    await this.emailService.sendWelcome(event.email);
  }
}
```

### After (OriJS)

```typescript
// events/user-events.ts
import { Event } from '@orijs/orijs';
import { Type } from '@orijs/validation';

export const UserCreated = Event.define({
  name: 'user.created',
  data: Type.Object({
    userId: Type.String(),
    email: Type.String(),
  }),
  result: Type.Object({
    welcomeEmailSent: Type.Boolean(),
  }),
});

// consumers/user-created-consumer.ts
import type { EventConsumer } from '@orijs/orijs';
import type { UserCreated } from '../events/user-events';

class UserCreatedConsumer implements EventConsumer<typeof UserCreated> {
  constructor(private readonly emailService: EmailService) {}

  onEvent = async (ctx) => {
    await this.emailService.sendWelcome(ctx.data.email);
    return { welcomeEmailSent: true };
  };
}

// In controller handler — emit via ctx.events
private createUser = async (ctx: RequestContext) => {
  const body = await ctx.json<CreateUserInput>();
  const user = await this.userService.createUser(body);

  // Type-safe emit — payload validated at compile time
  await ctx.events.emit(UserCreated, {
    userId: user.id,
    email: user.email,
  });

  return Response.json(user, { status: 201 });
};

// Registration in app.ts
Ori.create()
  .event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
  .controller('/users', UserController, [UserService])
  .listen(3000);
```

**Key differences:**

1. Events are defined with TypeBox schemas — type-safe at compile time
2. No `EventEmitter2` — events are emitted via `ctx.events.emit()`
3. No `@OnEvent()` decorator — consumers implement `EventConsumer<typeof MyEvent>`
4. Consumers use arrow function properties (not methods) for `this` binding
5. Events are registered on the application, not discovered via decorators
6. Built-in support for BullMQ (persistent, retryable) via provider swap

## Step 7: Convert Tests

NestJS tests require `TestingModule` for DI. OriJS tests use plain class instantiation.

### Before (NestJS)

```typescript
// user.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from './user.service';
import { UserRepository } from './user.repository';
import { EmailService } from '../email/email.service';

describe('UserService', () => {
  let service: UserService;
  let mockRepo: Partial<UserRepository>;
  let mockEmail: Partial<EmailService>;

  beforeEach(async () => {
    mockRepo = {
      create: jest.fn().mockResolvedValue({ id: '123', name: 'Alice' }),
      findById: jest.fn().mockResolvedValue({ id: '123', name: 'Alice' }),
    };

    mockEmail = {
      sendWelcome: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: UserRepository, useValue: mockRepo },
        { provide: EmailService, useValue: mockEmail },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should create a user', async () => {
    const result = await service.createUser({ name: 'Alice', email: 'alice@example.com' });
    expect(result).toEqual({ id: '123', name: 'Alice' });
    expect(mockRepo.create).toHaveBeenCalled();
    expect(mockEmail.sendWelcome).toHaveBeenCalledWith('alice@example.com');
  });
});
```

### After (OriJS)

```typescript
// user-service.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { UserService } from './user-service';
import type { UserRepository } from './user-repository';
import type { EmailService } from '../email/email-service';

describe('UserService', () => {
  let service: UserService;
  let mockRepo: UserRepository;
  let mockEmail: EmailService;

  beforeEach(() => {
    mockRepo = {
      create: mock(() => Promise.resolve({ id: '123', name: 'Alice' })),
      findById: mock(() => Promise.resolve({ id: '123', name: 'Alice' })),
    } as unknown as UserRepository;

    mockEmail = {
      sendWelcome: mock(() => Promise.resolve()),
    } as unknown as EmailService;

    // No TestingModule — just new
    service = new UserService(mockRepo, mockEmail);
  });

  test('should create a user', async () => {
    const result = await service.createUser({ name: 'Alice', email: 'alice@example.com' });
    expect(result).toEqual({ id: '123', name: 'Alice' });
    expect(mockRepo.create).toHaveBeenCalled();
    expect(mockEmail.sendWelcome).toHaveBeenCalledWith('alice@example.com');
  });
});
```

**What changed:**

1. No `Test.createTestingModule()` — just `new UserService(deps)`
2. No `module.get()` — you already have the instance
3. `jest.fn()` becomes `mock()` from `bun:test`
4. `it()` becomes `test()` (Bun convention, `it` also works)
5. No framework bootstrapping overhead — tests run faster

## Migration Checklist

### Phase 1: Setup

- [ ] Create OriJS project structure alongside NestJS
- [ ] Install OriJS packages: `@orijs/orijs`, `@orijs/validation`, `@orijs/config`
- [ ] Create `bunfig.toml` with test preload configuration
- [ ] Set up TypeBox schemas to replace class-validator DTOs

### Phase 2: Core Services

- [ ] Remove `@Injectable()` from all service classes
- [ ] Add explicit visibility modifiers (`public`, `private`)
- [ ] Create extension functions to replace `@Module()` declarations
- [ ] Register all providers with explicit dependency arrays
- [ ] Verify all dependency arrays match constructor parameter order

### Phase 3: Controllers

- [ ] Implement `OriController` interface on all controllers
- [ ] Add `configure(r: RouteBuilder)` method
- [ ] Convert `@Get/@Post/@Put/@Patch/@Delete` to `r.get/r.post/r.put/r.patch/r.delete`
- [ ] Convert `@Body()` to `ctx.json()`
- [ ] Convert `@Param()` to `ctx.params` or `ctx.getValidatedParam()`
- [ ] Convert `@Query()` to `ctx.query`
- [ ] Convert `@UseGuards()` to `r.guard()`
- [ ] Convert `@UseInterceptors()` to `r.intercept()`
- [ ] Change handler methods to arrow function properties
- [ ] Return `Response` objects from handlers

### Phase 4: Events and Queues

- [ ] Define events with `Event.define()` and TypeBox schemas
- [ ] Convert `@OnEvent()` listeners to consumer classes
- [ ] Replace `EventEmitter2.emit()` with `ctx.events.emit()`
- [ ] Install `@orijs/bullmq` if using persistent events/workflows
- [ ] Register event consumers with `.event(def).consumer(Class, [deps])`

### Phase 5: Testing

- [ ] Replace `@nestjs/testing` with plain class instantiation
- [ ] Replace Jest with Bun test (`bun:test`)
- [ ] Convert `jest.fn()` to `mock()` from `bun:test`
- [ ] Convert `it()` to `test()` (optional — both work)
- [ ] Remove all `TestingModule` setup code
- [ ] Add E2E tests with `Ori.create().disableSignalHandling().listen(0)`

### Phase 6: Cleanup

- [ ] Remove NestJS dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`
- [ ] Remove `reflect-metadata` and `class-validator`/`class-transformer`
- [ ] Remove `experimentalDecorators` and `emitDecoratorMetadata` from `tsconfig.json`
- [ ] Run `bun run typecheck` — fix all type errors
- [ ] Run `bun test` — verify all tests pass
- [ ] Remove NestJS-specific files (`main.ts` with `NestFactory`, `.module.ts` files)

## Common Gotchas

### 1. Handler `this` Binding

In NestJS, controller methods work as regular methods because NestJS handles binding internally. In OriJS, handler methods passed to the route builder lose their `this` context. **Always use arrow function properties:**

```typescript
// WRONG — this will be undefined in the handler
class UserController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/', this.findAll); // 'this' is lost when passed as reference
  }

  async findAll(ctx: RequestContext) {
    return this.userService.findAll(); // TypeError: Cannot read property 'findAll' of undefined
  }
}

// CORRECT — arrow function captures this
class UserController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/', this.findAll);
  }

  private findAll = async (ctx: RequestContext) => {
    return Response.json(await this.userService.findAll()); // Works correctly
  };
}
```

### 2. Dependency Array Order

The dependency array must match the constructor parameter order exactly. TypeScript will catch mismatches at compile time:

```typescript
class UserService {
  constructor(
    private readonly repo: UserRepository,    // First
    private readonly email: EmailService,     // Second
    private readonly cache: CacheService,     // Third
  ) {}
}

// CORRECT — matches constructor order
app.provider(UserService, [UserRepository, EmailService, CacheService]);

// WRONG — TypeScript error: type mismatch
app.provider(UserService, [EmailService, UserRepository, CacheService]);
```

### 3. No Request Scope

NestJS supports request-scoped providers via `@Injectable({ scope: Scope.REQUEST })`. OriJS does not have request-scoped providers — all providers are singletons.

Instead, use the `RequestContext` to pass request-specific data:

```typescript
// NestJS — request-scoped provider
@Injectable({ scope: Scope.REQUEST })
export class RequestScopedService {
  constructor(@Inject(REQUEST) private request: Request) {}
}

// OriJS — use RequestContext parameter instead
class MyService {
  public async doWork(accountUuid: string, projectUuid: string): Promise<Result> {
    // Receive tenant context as parameters, not from injected request
    return this.repo.findAll(accountUuid, projectUuid);
  }
}
```

### 4. No Module Imports/Exports

NestJS requires explicit `imports` and `exports` in module declarations. OriJS has no module system — all providers registered on the application are globally available.

This means:
- No "Nest can't resolve dependencies of X" errors from missing imports
- No need to export providers for other modules to use
- No circular module dependency issues

However, it also means you need to be intentional about your extension function organization. Group related providers in the same extension function, and use naming conventions to keep things organized.

### 5. Response Objects

NestJS controllers return data objects that are automatically serialized to JSON. OriJS handlers must return `Response` objects:

```typescript
// NestJS — return data, framework serializes
@Get()
async findAll(): Promise<User[]> {
  return this.userService.findAll();
}

// OriJS — return Response explicitly
private findAll = async (ctx: RequestContext): Promise<Response> => {
  const users = await this.userService.findAll();
  return Response.json(users);
};

// For specific status codes:
return Response.json(user, { status: 201 });
return Response.json({ error: 'Not found' }, { status: 404 });
```

### 6. Exception Filters vs. Interceptors

NestJS uses `@Catch()` exception filters. OriJS uses interceptors for error handling (the onion model wraps the handler, including error catching):

```typescript
// NestJS — exception filter
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    response.status(exception.getStatus()).json({ ... });
  }
}

// OriJS — error mapping interceptor
class ErrorMappingInterceptor implements Interceptor {
  async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    try {
      return await next();
    } catch (error) {
      if (error instanceof DomainError) {
        return Response.json({ error: error.message }, { status: error.statusCode });
      }
      return Response.json({ error: 'Internal Error' }, { status: 500 });
    }
  }
}
```

---

[Previous: Advanced Patterns ←](./17-advanced-patterns.md) | [Next: API Reference →](./19-api-reference.md)
