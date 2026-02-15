# Chapter 1: Introduction & Philosophy

## Why Another Web Framework?

The Node.js ecosystem has no shortage of web frameworks. Express, Fastify, Hono, Koa, NestJS — each fills a different niche. So why build another one?

The answer starts with three observations:

1. **NestJS gets architecture right but the implementation is heavy.** Its dependency injection, guards, interceptors, and modular structure encourage well-organized applications. But the decorator-based syntax, reflect-metadata dependency, and complex module system add significant overhead — both in runtime performance and cognitive load.

2. **Bun changes the equation.** Bun's native HTTP server is dramatically faster than Node.js equivalents. Its built-in TypeScript support, native test runner, and SQLite/PostgreSQL drivers eliminate the need for much of the Node.js toolchain. But there was no framework that combined NestJS's architectural patterns with Bun's performance.

3. **Frameworks shouldn't create lock-in.** Most frameworks bundle specific infrastructure choices — a particular validation library, a specific queue system, a chosen caching backend. When your needs outgrow these defaults, you're stuck refactoring core framework code. A framework should provide *structure*, not *lock you in to specific vendors*.

OriJS fills that gap. It provides the structure and patterns that make NestJS productive, running natively on Bun, with a provider-based architecture that lets you swap out any infrastructure component without touching your business logic.

## Design Principles

### 1. Provider-Based Architecture

This is the most important architectural decision in OriJS, and it affects everything else.

In most frameworks, infrastructure choices are baked in. NestJS ships with `class-validator` and `class-transformer`. Fastify ships with Ajv. If you want to switch, you're fighting the framework.

OriJS takes a different approach: **every infrastructure component implements a provider interface.** The framework ships with production-ready default providers — TypeBox for validation, BullMQ for events and workflows, Redis for caching and WebSocket scaling — but these are *implementations*, not *requirements*.

```typescript
// The cache system defines a CacheProvider interface
interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<number>;
  delMany(keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
}

// OriJS ships with Redis and InMemory implementations
import { createRedisCacheProvider } from '@orijs/cache-redis';
import { InMemoryCacheProvider } from '@orijs/cache';

// But you can write your own
class MemcachedCacheProvider implements CacheProvider {
  // Your implementation using Memcached
}
```

This means:

- **No vendor lock-in.** Your business logic depends on interfaces, not implementations. Switch from Redis to Memcached without changing a single service.
- **Testability is built in.** Swap the Redis cache provider for an InMemory provider in tests. No complex mocking, no test containers for simple unit tests.
- **Gradual adoption.** Start with OriJS's built-in providers. As your needs evolve, replace individual providers without a framework migration.
- **Community extensibility.** Anyone can publish a provider package. `@orijs/cache-dynamodb`, `@orijs/events-rabbitmq`, `@orijs/validation-zod` — the ecosystem grows through providers, not framework patches.

We'll explore the provider architecture in depth in [Chapter 4](./04-the-provider-architecture.md). For now, remember this principle: **OriJS provides structure, providers provide infrastructure.**

### 2. No Decorators

This is the most visible difference from NestJS. Instead of:

```typescript
// NestJS style — decorators everywhere
@Controller('users')
export class UserController {
  constructor(private userService: UserService) {}

  @Get(':id')
  @UseGuards(AuthGuard)
  async getUser(@Param('id') id: string) {
    return this.userService.findById(id);
  }
}
```

OriJS uses a fluent builder API:

```typescript
// OriJS style — explicit configuration
class UserController implements OriController {
  constructor(private userService: UserService) {}

  configure(r: RouteBuilder) {
    r.guard(AuthGuard);
    r.get('/:id', this.getUser);
  }

  private getUser = async (ctx: RequestContext) => {
    const user = await this.userService.findById(ctx.params.id);
    return Response.json(user);
  };
}
```

**Why no decorators?**

- **TC39 decorators are incompatible with legacy decorators.** NestJS uses TypeScript's experimental `experimentalDecorators`, which are a different specification from the TC39 Stage 3 decorators that shipped in TypeScript 5.0. This creates a migration cliff — you can't gradually move from one to the other. If NestJS ever migrates, it will be a breaking change for every project.

- **reflect-metadata is a runtime cost.** NestJS's DI system relies on `reflect-metadata` to read constructor parameter types at runtime. This adds startup overhead and requires the `emitDecoratorMetadata` compiler option, which generates extra code for every decorated class. In benchmarks, this adds 5-15% to startup time for large applications.

- **Decorators hide control flow.** When you see `@UseGuards(AuthGuard)`, it's not immediately clear when the guard runs, how it interacts with other decorators, or what happens when it fails. The fluent builder API makes the execution pipeline visible and linear — you can read it top to bottom and understand exactly what happens.

- **Testing is simpler without decorators.** With decorators, testing a controller means either setting up NestJS's testing module or carefully mocking the decorator behavior. With OriJS, a controller is just a class — you can instantiate it directly with mock dependencies. No framework bootstrapping needed.

- **Tree-shaking works.** Decorator metadata prevents effective tree-shaking because the generated code creates runtime references that bundlers can't safely remove. Without decorators, your bundle contains only the code you actually use.

### 3. Explicit Dependency Injection

NestJS uses TypeScript's type metadata to automatically resolve constructor dependencies:

```typescript
// NestJS — "magic" DI via reflect-metadata
@Injectable()
export class UserService {
  // NestJS reads the type UserRepository from metadata at runtime
  constructor(private repo: UserRepository) {}
}
```

OriJS requires you to list dependencies explicitly:

```typescript
// OriJS — explicit dependency listing
class UserService {
  constructor(private repo: UserRepository) {}
}

// When registering:
app.provider(UserService, [UserRepository]);
```

This looks like more work, but it's a deliberate trade-off with significant benefits:

- **No metadata overhead.** No `reflect-metadata`, no `emitDecoratorMetadata`, no runtime type introspection. Your application starts faster and uses less memory.
- **Refactoring is safe.** If you change a constructor parameter's type, TypeScript catches the mismatch at compile time. With NestJS, a type change can silently break DI if metadata isn't regenerated correctly.
- **Dependencies are visible at the registration site.** You can see the entire dependency graph by reading the application's provider registrations. No need to trace through decorator metadata.
- **Tree-shaking works.** Without decorator metadata, unused providers don't get pulled into the bundle.
- **Works with any class.** No `@Injectable()` decorator needed. Any JavaScript class can be a provider.

The small duplication (listing deps in both the constructor and the registration) is caught by TypeScript's type checker — if the deps array doesn't match the constructor signature, you get a compile-time error.

### 4. Composition Over Configuration

NestJS organizes code into modules with `@Module` decorators that declare imports, exports, providers, and controllers:

```typescript
// NestJS — module configuration
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService],
})
export class UserModule {}
```

OriJS replaces modules with **extension functions** — plain TypeScript functions that configure an application:

```typescript
// OriJS — extension function
function useUsers(app: OriApplication) {
  app
    .provider(UserRepository, [DbService])
    .provider(UserService, [UserRepository])
    .controller('/users', UserController, [UserService]);
}

// Usage
Ori.create()
  .use(useUsers)
  .use(useAuth)
  .listen(3000);
```

**Why extension functions over modules?**

- **They're just functions.** No special syntax, no decorator metadata, no circular dependency issues between modules. You can compose them, conditionally apply them, and test them — they're standard JavaScript.
- **No import/export ceremony.** NestJS modules require explicit `imports` and `exports` arrays. Forgetting to export a provider creates a confusing "Nest can't resolve dependencies" error. Extension functions operate on the global container — all providers are available to all consumers.
- **Conditional composition.** Want to add admin routes only in development? It's an `if` statement: `if (isDev) app.use(useAdmin)`. No `DynamicModule` needed.
- **Parameterized composition.** Need different config for different environments? Extension functions can accept parameters: `app.use(useCors({ origins: ['https://myapp.com'] }))`.

### 5. Bun-Native

OriJS doesn't abstract away Bun — it embraces it:

- **Bun's native HTTP server** powers routing. Routes are compiled to Bun's `Bun.serve({ routes })` format, which uses an optimized radix tree for path matching. This is dramatically faster than Express's layer-based routing.
- **Bun's native WebSocket support** is used directly, not wrapped in a compatibility layer. This gives you access to Bun's zero-copy pub/sub primitives and efficient message handling.
- **Bun's test runner** is used for all testing. No Jest, no Mocha, no Vitest needed for backend tests.
- **Bun's native `import`** handles TypeScript directly. No compilation step, no build tool, no transpiler configuration.

This means OriJS applications start in milliseconds, handle tens of thousands of concurrent connections, and use a fraction of the memory of equivalent Node.js applications.

### 6. Type Safety Without Ceremony

TypeBox is OriJS's default validation provider, and it provides end-to-end type safety:

```typescript
const CreateUserBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  email: Type.String({ format: 'email' }),
  role: Type.Union([Type.Literal('admin'), Type.Literal('member')]),
});

// In configure():
r.post('/', this.create, { body: CreateUserBody });

// Handler receives validated body:
private create = async (ctx: RequestContext) => {
  const input = await ctx.json<Static<typeof CreateUserBody>>();
  const user = await this.userService.create(input);
  return Response.json(user, { status: 201 });
};
```

**Why TypeBox as the default over Zod?**

- **JSON Schema compatible.** TypeBox schemas are valid JSON Schema objects. This means you can use them for OpenAPI documentation, client-side validation, and database constraints without conversion. Zod schemas are TypeScript-only and require separate tools to generate JSON Schema.
- **Faster validation.** TypeBox compiles schemas to optimized validation functions. Benchmarks show 2-10x faster validation compared to Zod, depending on schema complexity. For an API framework that validates every request, this matters.
- **Smaller bundle.** TypeBox is tree-shakeable and adds minimal overhead. Zod's chained API creates larger bundles.

But remember: TypeBox is a *provider*. If your team prefers Zod, you can write a Zod validation provider and plug it in. The framework doesn't care — it depends on the validation interface, not on TypeBox specifically.

## When to Use OriJS

OriJS is a good fit when:

- **You want NestJS's structure without the overhead.** If you appreciate dependency injection, guards, and interceptors but find NestJS's decorator system cumbersome or its performance insufficient.
- **You're building on Bun.** If you've chosen Bun for its performance and want a framework that takes full advantage of it rather than treating it as a Node.js replacement.
- **You need infrastructure flexibility.** If you want to choose your own queue system, cache backend, or validation library without fighting the framework.
- **You need type safety end to end.** From validation to response types, OriJS leverages TypeScript to catch errors at compile time.
- **You're building APIs at scale.** OriJS's event system, workflow engine, caching, and WebSocket support are designed for production distributed systems.

OriJS may not be the best fit when:

- **You need Node.js compatibility.** OriJS is Bun-only. If you must run on Node.js, consider NestJS, Fastify, or Hono.
- **You want a minimal framework.** If you just need basic routing and middleware, Hono or Elysia might be simpler choices.
- **You need a large plugin ecosystem.** NestJS has hundreds of community modules. OriJS's ecosystem is newer and smaller (though the provider architecture makes it easy to build your own).

## Comparison with Other Frameworks

| Feature | OriJS | NestJS | Fastify | Hono | Elysia |
|---------|-------|--------|---------|------|--------|
| Runtime | Bun | Node.js | Node.js | Any | Bun |
| Architecture | Provider-based | Module-based | Plugin-based | Middleware | Plugin-based |
| DI System | Built-in (explicit) | Built-in (decorators) | None | None | None |
| Guards/Interceptors | Yes | Yes | Hooks | Middleware | Hooks |
| Validation | TypeBox (swappable) | class-validator (baked in) | Ajv (baked in) | Zod/Valibot | TypeBox |
| Event System | BullMQ (swappable) | @nestjs/microservices | None | None | None |
| Workflow Engine | Built-in (Saga) | None | None | None | None |
| Caching | Built-in (swappable) | @nestjs/cache-manager | None | None | None |
| WebSocket | Native Bun (swappable scaling) | Socket.io/WS | @fastify/websocket | Varies | Built-in |
| Type Safety | Full (TypeBox) | Partial | Partial | Full (generics) | Full (TypeBox) |
| Infrastructure Lock-in | None (providers) | High (decorators + modules) | Medium | Low | Medium |

## What's Next

In the next chapter, you'll install OriJS, create your first application, and understand the basic project structure. Let's get started.

[Next: Quick Start →](./02-quick-start.md)
