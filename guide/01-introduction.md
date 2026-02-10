# Chapter 1: Introduction & Philosophy

## Why Another Web Framework?

The Node.js ecosystem has no shortage of web frameworks. Express, Fastify, Hono, Koa, NestJS — each fills a different niche. So why build another one?

The answer starts with two observations:

1. **NestJS gets architecture right but the implementation is heavy.** Its dependency injection, guards, interceptors, and modular structure encourage well-organized applications. But the decorator-based syntax, reflect-metadata dependency, and complex module system add significant overhead — both in runtime performance and cognitive load.

2. **Bun changes the equation.** Bun's native HTTP server is dramatically faster than Node.js equivalents. Its built-in TypeScript support, native test runner, and SQLite/PostgreSQL drivers eliminate the need for much of the Node.js toolchain. But there was no framework that combined NestJS's architectural patterns with Bun's performance.

OriJS fills that gap. It provides the structure and patterns that make NestJS productive, running natively on Bun, with an API designed to be explicit rather than magical.

## Design Principles

### 1. No Decorators

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
    r.get('/:id')
      .guard(AuthGuard)
      .handle(this.getUser);
  }

  private getUser = async (ctx: RequestContext) => {
    const id = ctx.params.id;
    return this.userService.findById(id);
  };
}
```

**Why no decorators?**

- **TC39 decorators are incompatible with legacy decorators.** NestJS uses TypeScript's experimental `experimentalDecorators`, which are a different specification from the TC39 Stage 3 decorators. This creates a migration cliff — you can't gradually move from one to the other.

- **reflect-metadata is a runtime cost.** NestJS's DI system relies on `reflect-metadata` to read constructor parameter types at runtime. This adds startup overhead and requires the `emitDecoratorMetadata` compiler option, which generates extra code for every decorated class.

- **Decorators hide control flow.** When you see `@UseGuards(AuthGuard)`, it's not immediately clear when the guard runs, how it interacts with other decorators, or what happens when it fails. The fluent builder API makes the execution pipeline visible and linear.

- **Testing is simpler without decorators.** With decorators, testing a controller means either setting up NestJS's testing module or carefully mocking the decorator behavior. With OriJS, a controller is just a class — you can instantiate it directly with mock dependencies.

### 2. Explicit Dependency Injection

NestJS uses TypeScript's type metadata to automatically resolve constructor dependencies:

```typescript
// NestJS — "magic" DI via reflect-metadata
@Injectable()
export class UserService {
  // NestJS reads the type UserRepository from metadata
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

**Why explicit?**

- **No metadata overhead.** No `reflect-metadata`, no `emitDecoratorMetadata`, no runtime type introspection.
- **Refactoring is safe.** If you change a constructor parameter's type, TypeScript catches the mismatch at compile time. With NestJS, a type change can silently break DI if metadata isn't regenerated.
- **Dependencies are visible at the registration site.** You can see the entire dependency graph by reading the application's provider registrations.
- **Tree-shaking works.** Without decorator metadata, unused providers don't get pulled into the bundle.

### 3. Composition Over Configuration

NestJS organizes code into modules with `@Module` decorators that declare imports, exports, providers, and controllers. This creates a configuration layer between your code and the framework:

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

OriJS replaces modules with **extension functions** — plain functions that configure an application:

```typescript
// OriJS — extension function
function useUsers(app: OriApplication) {
  app
    .provider(UserRepository, [DbService])
    .provider(UserService, [UserRepository])
    .controller(UserController, [UserService]);
}

// Usage
Ori.create()
  .use(useUsers)
  .use(useAuth)
  .listen(3000);
```

**Why extension functions?**

- **They're just functions.** No special syntax, no decorator metadata, no circular dependency issues between modules. You can compose them, conditionally apply them, and test them.
- **No import/export ceremony.** NestJS modules require explicit `imports` and `exports` arrays. Forgetting to export a provider creates a confusing "Nest can't resolve dependencies" error. Extension functions operate on the global container — all providers are available.
- **Conditional composition.** Want to add admin routes only in development? It's an `if` statement: `if (isDev) app.use(useAdmin)`.

### 4. Bun-Native

OriJS doesn't abstract away Bun — it embraces it:

- **Bun's native HTTP server** powers routing. Routes are compiled to Bun's `Bun.serve({ routes })` format, which uses an optimized radix tree for path matching.
- **Bun's native WebSocket support** is used directly, not wrapped in a compatibility layer. This gives you access to Bun's pub/sub primitives and zero-copy message handling.
- **Bun's test runner** is used for all testing. No Jest, no Mocha, no Vitest needed (though you can use Vitest for browser tests).
- **Bun's native `import`** handles TypeScript directly. No compilation step, no build tool, no transpiler.

This means OriJS applications start in milliseconds, handle tens of thousands of concurrent connections, and use a fraction of the memory of equivalent Node.js applications.

### 5. Type Safety Without Ceremony

TypeBox is used throughout OriJS for validation and type safety:

```typescript
const CreateUserBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  email: Type.String({ format: 'email' }),
  role: Type.Union([Type.Literal('admin'), Type.Literal('member')]),
});

r.post('/')
  .validate({ body: CreateUserBody })
  .handle(async (ctx) => {
    // ctx.body is fully typed as { name: string; email: string; role: 'admin' | 'member' }
    const user = await this.userService.create(ctx.body);
    return ctx.response.created(user);
  });
```

**Why TypeBox over Zod?**

- **JSON Schema compatible.** TypeBox schemas can be used for API documentation (OpenAPI), client-side validation, and database constraints. Zod schemas are TypeScript-only.
- **Faster validation.** TypeBox compiles schemas to optimized validation functions. Benchmarks show 2-10x faster validation compared to Zod.
- **Smaller bundle.** TypeBox is tree-shakeable and adds minimal overhead. Zod's chained API creates larger bundles.
- **Ajv compatibility.** TypeBox produces standard JSON Schema objects that work with the Ajv ecosystem.

## When to Use OriJS

OriJS is a good fit when:

- **You want NestJS's structure without the overhead.** If you appreciate dependency injection, guards, and interceptors but find NestJS's decorator system cumbersome.
- **You're building on Bun.** If you've chosen Bun for its performance and want a framework that takes full advantage of it.
- **You need type safety end to end.** From validation to response types, OriJS leverages TypeScript to catch errors at compile time.
- **You're building APIs at scale.** OriJS's event system, workflow engine, caching, and WebSocket support are designed for production distributed systems.

OriJS may not be the best fit when:

- **You need Node.js compatibility.** OriJS is Bun-only. If you must run on Node.js, consider NestJS, Fastify, or Hono.
- **You want a minimal framework.** If you just need basic routing and middleware, Hono or Elysia might be simpler choices.
- **You need a large plugin ecosystem.** NestJS has hundreds of community modules. OriJS's ecosystem is newer and smaller.

## Comparison with Other Frameworks

| Feature | OriJS | NestJS | Fastify | Hono | Elysia |
|---------|-------|--------|---------|------|--------|
| Runtime | Bun | Node.js | Node.js | Any | Bun |
| DI System | Built-in (explicit) | Built-in (decorators) | None | None | None |
| Guards/Interceptors | Yes | Yes | Hooks | Middleware | Hooks |
| Validation | TypeBox | class-validator/Zod | Ajv | Zod/Valibot | TypeBox |
| WebSocket | Native Bun | Socket.io/WS | @fastify/websocket | Varies | Built-in |
| Event System | BullMQ | @nestjs/microservices | None | None | None |
| Workflow Engine | Built-in (Saga) | None | None | None | None |
| Caching | Built-in (multi-level) | @nestjs/cache-manager | None | None | None |
| Type Safety | Full (TypeBox) | Partial | Partial | Full (generics) | Full (TypeBox) |

## What's Next

In the next chapter, you'll install OriJS, create your first application, and understand the basic project structure. Let's get started.

[Next: Quick Start →](./02-quick-start.md)
