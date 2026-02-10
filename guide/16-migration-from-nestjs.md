# Chapter 16: Migration from NestJS

If you're coming from NestJS, this chapter provides a step-by-step guide for converting your application to OriJS. The architectural concepts are similar — controllers, services, guards, interceptors — but the syntax and patterns differ.

## Conceptual Mapping

| NestJS Concept | OriJS Equivalent |
|----------------|-----------------|
| `@Module()` | Extension function (`function useX(app)`) |
| `@Controller()` | `implements OriController` |
| `@Injectable()` | No decorator needed (just a class) |
| `@Get()`, `@Post()` | `r.get()`, `r.post()` in `configure()` |
| `@UseGuards()` | `.guard()` on route builder |
| `@UseInterceptors()` | `.interceptor()` on route builder |
| `@Body()`, `@Param()`, `@Query()` | `ctx.body`, `ctx.params`, `ctx.query` |
| `@Inject()` + providers array | `app.provider(Class, [Dep1, Dep2])` |
| `ConfigModule` | `EnvConfig` or `ValidatedConfig` |
| `@nestjs/event-emitter` | `Event.define()` + consumers |
| `@nestjs/cache-manager` | `CacheService` with entity registry |
| class-validator DTOs | TypeBox schemas |
| Jest | Bun test |

## Step 1: Convert Services

NestJS services use `@Injectable()`:

```typescript
// NestJS
@Injectable()
export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    @Inject('CACHE_MANAGER') private cacheManager: Cache,
  ) {}

  async findById(id: string): Promise<User> {
    const cached = await this.cacheManager.get<User>(`user:${id}`);
    if (cached) return cached;

    const user = await this.userRepository.findOne({ where: { id } });
    if (user) await this.cacheManager.set(`user:${id}`, user, 300);
    return user;
  }
}
```

```typescript
// OriJS
class UserService {
  constructor(
    private userRepository: UserRepository,
    private cache: CacheService,
  ) {}

  public async findById(id: string): Promise<User> {
    return this.cache.getOrSet('user', 'byId', id, async () => {
      return this.userRepository.findById(id);
    });
  }
}

// Registration
app.provider(UserService, [UserRepository, CacheService]);
```

Key differences:
- No `@Injectable()` decorator
- No `@Inject()` — dependencies listed at registration time
- Explicit visibility modifiers (`public`, `private`)
- Cache uses `getOrSet` pattern instead of manual get/set

## Step 2: Convert Controllers

NestJS controllers use decorators extensively:

```typescript
// NestJS
@Controller('users')
@UseGuards(AuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  async findAll(@Query('page') page: number): Promise<User[]> {
    return this.userService.findAll({ page });
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<User> {
    const user = await this.userService.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateUserDto): Promise<User> {
    return this.userService.create(dto);
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.userService.remove(id);
  }
}
```

```typescript
// OriJS
class UserController implements OriController {
  constructor(private userService: UserService) {}

  configure(r: RouteBuilder) {
    r.prefix('/users');
    r.guard(AuthGuard);

    r.get('/')
      .validate({ query: ListUsersQuery })
      .handle(this.findAll);

    r.get('/:id')
      .validate({ params: UserIdParams })
      .handle(this.findOne);

    r.post('/')
      .validate({ body: CreateUserBody })
      .handle(this.create);

    r.delete('/:id')
      .guard(AdminGuard)
      .validate({ params: UserIdParams })
      .handle(this.remove);
  }

  private findAll = async (ctx: RequestContext) => {
    return this.userService.findAll({ page: ctx.query.page });
  };

  private findOne = async (ctx: RequestContext) => {
    const user = await this.userService.findById(ctx.params.id);
    if (!user) return ctx.response.notFound('User not found');
    return user;
  };

  private create = async (ctx: RequestContext) => {
    const user = await this.userService.create(ctx.body);
    return ctx.response.created(user);
  };

  private remove = async (ctx: RequestContext) => {
    await this.userService.remove(ctx.params.id);
    return ctx.response.noContent();
  };
}

// Registration
app.controller(UserController, [UserService]);
```

Key differences:
- Route definitions in `configure()` method instead of decorators
- Handlers are arrow function properties (for correct `this` binding)
- Request data comes from `ctx` (params, query, body) instead of parameter decorators
- Response status via `ctx.response` helpers instead of `@HttpCode()`
- Validation schemas replace DTOs and pipes

## Step 3: Convert DTOs to TypeBox

NestJS uses class-validator DTOs:

```typescript
// NestJS
import { IsString, IsEmail, IsOptional, MinLength, MaxLength } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  phone?: string;
}
```

```typescript
// OriJS
import { Type } from '@orijs/validation';

const CreateUserBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  email: Type.String({ format: 'email' }),
  phone: Type.Optional(Type.String()),
});

// Type is automatically inferred:
// { name: string; email: string; phone?: string }
```

Advantages:
- No class instantiation overhead
- JSON Schema compatible (for OpenAPI docs)
- Type inference is automatic (no `type CreateUserInput = Static<typeof CreateUserBody>` needed in most cases)
- Schemas are composable JavaScript objects

## Step 4: Convert Guards

```typescript
// NestJS
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) return false;

    const user = await this.authService.verify(token);
    if (!user) return false;

    request.user = user;
    return true;
  }
}
```

```typescript
// OriJS
class AuthGuard implements OriGuard<AuthState> {
  constructor(private authService: AuthService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return false;

    const user = await this.authService.verify(token);
    if (!user) return false;

    ctx.state.user = user;
    return true;
  }
}
```

Key differences:
- No `ExecutionContext` — just `RequestContext` (simpler API)
- No `switchToHttp().getRequest()` — direct access to request data
- User attached to typed `ctx.state` instead of untyped `request.user`

## Step 5: Convert Modules to Extension Functions

```typescript
// NestJS
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService],
})
export class UserModule {}
```

```typescript
// OriJS
export function useUsers(app: OriApplication) {
  app
    .provider(UserRepository, [DatabaseService])
    .provider(UserService, [UserRepository])
    .controller(UserController, [UserService]);
}

// Usage
Ori.create()
  .use(useDatabase)
  .use(useAuth)
  .use(useUsers)
  .listen(3000);
```

No imports/exports to manage. No module metadata. Extension functions just register what they need.

## Step 6: Convert Events

```typescript
// NestJS with @nestjs/event-emitter
@Injectable()
export class UserService {
  constructor(private eventEmitter: EventEmitter2) {}

  async create(input: CreateUserInput) {
    const user = await this.repo.save(input);
    this.eventEmitter.emit('user.created', new UserCreatedEvent(user));
    return user;
  }
}

@Injectable()
export class NotificationListener {
  @OnEvent('user.created')
  async handleUserCreated(event: UserCreatedEvent) {
    await this.emailService.sendWelcome(event.user.email);
  }
}
```

```typescript
// OriJS
const UserCreated = Event.define({
  name: 'user.created',
  schema: Type.Object({
    userId: Type.String(),
    email: Type.String(),
    name: Type.String(),
  }),
});

class UserService {
  constructor(private ctx: AppContext, private repo: UserRepository) {}

  public async create(input: CreateUserInput) {
    const user = await this.repo.create(input);
    await this.ctx.events.emit(UserCreated, {
      userId: user.uuid,
      email: user.email,
      name: user.name,
    });
    return user;
  }
}

class NotificationConsumer implements OriConsumer<typeof UserCreated> {
  event = UserCreated;

  constructor(private emailService: EmailService) {}

  async handle(ctx: EventContext<typeof UserCreated>) {
    await this.emailService.sendWelcome(ctx.data.email);
  }
}

// Registration
app
  .events({ provider: bullmqProvider })
  .provider(UserService, [AppContext, UserRepository])
  .consumer(NotificationConsumer, [EmailService]);
```

Key differences:
- Events are typed definitions (not strings or classes)
- Event payloads are validated against TypeBox schemas
- Events go through BullMQ (persistent, retryable) not in-process EventEmitter
- Consumers are explicit classes, not decorated methods

## Step 7: Convert Tests

```typescript
// NestJS
describe('UserService', () => {
  let service: UserService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: UserRepository, useValue: mockRepository },
        { provide: 'CACHE_MANAGER', useValue: mockCache },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should find user by id', async () => {
    mockRepository.findOne.mockResolvedValue({ id: '1', name: 'Alice' });
    const user = await service.findById('1');
    expect(user.name).toBe('Alice');
  });
});
```

```typescript
// OriJS
describe('UserService', () => {
  let service: UserService;

  beforeEach(() => {
    const mockRepo = {
      findById: mock(async (id: string) => ({ uuid: id, name: 'Alice' })),
    } as unknown as UserRepository;

    const mockCache = {
      getOrSet: mock(async (_, __, ___, factory) => factory()),
    } as unknown as CacheService;

    // Just instantiate it — no testing module needed
    service = new UserService(mockRepo, mockCache);
  });

  it('should find user by id', async () => {
    const user = await service.findById('1');
    expect(user.name).toBe('Alice');
  });
});
```

The biggest testing win in OriJS: no `TestingModule`, no `.compile()`, no module bootstrapping. Classes are plain classes — `new` them with mocks and test.

## Migration Checklist

### Phase 1: Setup
- [ ] Create new OriJS project alongside NestJS
- [ ] Install `@orijs/orijs` and related packages
- [ ] Set up Bun test runner
- [ ] Create base extension functions (database, auth)

### Phase 2: Core Services
- [ ] Migrate DTOs to TypeBox schemas
- [ ] Migrate services (remove `@Injectable()`)
- [ ] Migrate repositories (remove TypeORM/Prisma)
- [ ] Migrate guards (adapt `ExecutionContext` to `RequestContext`)

### Phase 3: Controllers
- [ ] Migrate controllers (decorators → RouteBuilder)
- [ ] Migrate interceptors
- [ ] Migrate validation pipes

### Phase 4: Events & Background
- [ ] Migrate event listeners to OriJS consumers
- [ ] Set up BullMQ provider
- [ ] Migrate scheduled tasks to scheduled events

### Phase 5: Testing
- [ ] Convert Jest tests to Bun tests
- [ ] Remove TestingModule usage
- [ ] Update mock patterns

### Phase 6: Cleanup
- [ ] Remove NestJS dependencies
- [ ] Remove `experimentalDecorators` and `emitDecoratorMetadata` from tsconfig
- [ ] Remove `reflect-metadata` import
- [ ] Verify all tests pass
- [ ] Performance comparison

## Common Gotchas

### 1. Handler `this` Binding

```typescript
// NestJS — regular methods work because NestJS binds them internally
@Get(':id')
async findOne(@Param('id') id: string) {
  return this.service.findById(id);
}

// OriJS — must use arrow functions
private findOne = async (ctx: RequestContext) => {
  return this.service.findById(ctx.params.id);  // `this` works
};
```

### 2. Dependency Array Order

```typescript
// NestJS — types inferred from constructor via reflect-metadata
constructor(private userRepo: UserRepository, private cache: CacheService) {}

// OriJS — deps array must match constructor order EXACTLY
app.provider(UserService, [UserRepository, CacheService]);
// [CacheService, UserRepository] would be WRONG
```

### 3. No Request Scope

```typescript
// NestJS — request-scoped provider
@Injectable({ scope: Scope.REQUEST })
class RequestContextService {
  constructor(@Inject(REQUEST) private request: Request) {}
}

// OriJS — use RequestContext instead (passed to handlers)
private handle = async (ctx: RequestContext) => {
  // ctx IS your request context — no need for a separate provider
  ctx.log.info('Processing', { userId: ctx.state.user.id });
};
```

### 4. No Module Imports/Exports

```typescript
// NestJS — must explicitly import/export between modules
@Module({
  imports: [AuthModule],  // Must import to use AuthService
  exports: [UserService], // Must export for other modules
})

// OriJS — all providers are in the same container
// Just register and use — no import/export ceremony
app.provider(AuthService);
app.provider(UserService, [AuthService]);  // AuthService is available
```

[Previous: Advanced Patterns ←](./15-advanced-patterns.md) | [Next: API Reference →](./17-api-reference.md)
