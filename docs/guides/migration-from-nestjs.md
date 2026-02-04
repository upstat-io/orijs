# Migration from NestJS

This guide helps you migrate from NestJS to OriJS, covering key differences and step-by-step migration patterns.

---

## Overview

### Key Differences

| Feature          | NestJS                                 | OriJS                        |
| ---------------- | -------------------------------------- | ---------------------------- |
| **Runtime**      | Node.js                                | Bun                          |
| **Decorators**   | `@Injectable()`, `@Controller()`, etc. | None - explicit registration |
| **DI**           | Automatic via decorators               | Manual via dependency arrays |
| **Modules**      | `@Module()` decorator                  | Extension functions          |
| **Validation**   | Zod, class-validator                   | TypeBox                      |
| **Testing**      | Jest                                   | Bun test                     |
| **Guards**       | `@UseGuards()` decorator               | `.guard()` method            |
| **Interceptors** | `@UseInterceptors()` decorator         | `.intercept()` method        |

### Why Migrate?

- **Performance**: Bun is significantly faster than Node.js
- **Simplicity**: No decorators or reflection magic
- **Type Safety**: Explicit dependencies are easier to type
- **Bundle Size**: Smaller runtime footprint

---

## Step-by-Step Migration

### Step 1: Update Runtime

Replace Node.js with Bun:

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Convert package.json scripts
# From: "start": "node dist/main.js"
# To:   "start": "bun run src/main.ts"

# Install dependencies with Bun
bun install
```

### Step 2: Update tsconfig.json

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"types": ["bun-types"],
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true
	}
}
```

### Step 3: Install OriJS

```bash
bun add @upstat/orijs
bun remove @nestjs/core @nestjs/common @nestjs/platform-express reflect-metadata
```

---

## Converting Services

### NestJS Service

```typescript
// NestJS
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
	constructor(
		private readonly dbService: DatabaseService,
		private readonly cacheService: CacheService
	) {}

	async getUser(id: string): Promise<User> {
		return this.dbService.findUser(id);
	}
}
```

### OriJS Service

```typescript
// OriJS - No decorators needed
export class UserService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly cacheService: CacheService,
  ) {}

  async getUser(id: string): Promise<User> {
    return this.dbService.findUser(id);
  }
}

// Registration (in app setup)
.provider(UserService, [DatabaseService, CacheService])
```

---

## Converting Controllers

### NestJS Controller

```typescript
// NestJS
import { Controller, Get, Post, Body, Param } from '@nestjs/common';

@Controller('users')
export class UserController {
	constructor(private readonly userService: UserService) {}

	@Get()
	async list() {
		return this.userService.list();
	}

	@Get(':id')
	async findOne(@Param('id') id: string) {
		return this.userService.findById(id);
	}

	@Post()
	async create(@Body() dto: CreateUserDto) {
		return this.userService.create(dto);
	}
}
```

### OriJS Controller

```typescript
// OriJS
import { RouteBuilder, RequestContext, OriController } from '@upstat/orijs';

export class UserController implements OriController {
  constructor(private readonly userService: UserService) {}

  configure(r: RouteBuilder) {
    r.get('/list', this.list);
    r.get('/:id', this.findOne);
    r.post('/create', this.create);
  }

  // Use arrow functions!
  private list = async (ctx: RequestContext) => {
    return ctx.json(await this.userService.list());
  };

  private findOne = async (ctx: RequestContext) => {
    const { id } = ctx.params;
    return ctx.json(await this.userService.findById(id));
  };

  private create = async (ctx: RequestContext) => {
    const dto = await ctx.json<CreateUserDto>();
    return ctx.json(await this.userService.create(dto), 201);
  };
}

// Registration
.controller('/users', UserController, [UserService])
```

---

## Converting Modules

### NestJS Module

```typescript
// NestJS
import { Module } from '@nestjs/common';

@Module({
	imports: [DatabaseModule],
	controllers: [UserController],
	providers: [UserService, UserMapper],
	exports: [UserService]
})
export class UserModule {}
```

### OriJS Extension Function

```typescript
// OriJS - Use extension functions
import { Application } from '@upstat/orijs';

export function addUserModule(app: Application): Application {
	return app
		.provider(UserMapper)
		.provider(UserService, [DatabaseService, UserMapper])
		.controller('/users', UserController, [UserService]);
}

// Usage in main app
Ori.create().use(addDatabaseModule).use(addUserModule).listen(3000);
```

---

## Converting Guards

### NestJS Guard

```typescript
// NestJS
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
	constructor(private jwtService: JwtService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const token = request.headers.authorization?.replace('Bearer ', '');

		if (!token) return false;

		try {
			const payload = await this.jwtService.verify(token);
			request.user = payload;
			return true;
		} catch {
			return false;
		}
	}
}

// Usage with decorator
@UseGuards(AuthGuard)
@Controller('protected')
export class ProtectedController {}
```

### OriJS Guard

```typescript
// OriJS
import { Guard, RequestContext } from '@upstat/orijs';

export class AuthGuard implements Guard {
  constructor(private jwtService: JwtService) {}

  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.request.headers.get('Authorization')?.replace('Bearer ', '');

    if (!token) return false;

    try {
      const payload = await this.jwtService.verify(token);
      ctx.state = { user: payload };
      return true;
    } catch {
      return false;
    }
  }
}

// Usage - method chaining
.guard(AuthGuard)
.controller('/protected', ProtectedController, [])

// Or controller-level
class ProtectedController implements OriController {
  configure(r: RouteBuilder) {
    r.guard(AuthGuard);
    r.get('/data', this.getData);
  }
}
```

---

## Converting Interceptors

### NestJS Interceptor

```typescript
// NestJS
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
	intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
		const now = Date.now();
		return next.handle().pipe(tap(() => console.log(`Request took ${Date.now() - now}ms`)));
	}
}
```

### OriJS Interceptor

```typescript
// OriJS
import { Interceptor, RequestContext } from '@upstat/orijs';

export class LoggingInterceptor implements Interceptor {
  async intercept(
    ctx: RequestContext,
    next: () => Promise<Response>
  ): Promise<Response> {
    const now = Date.now();
    const response = await next();
    console.log(`Request took ${Date.now() - now}ms`);
    return response;
  }
}

// Usage
.intercept(LoggingInterceptor)
```

---

## Converting Validation

### NestJS with Zod

```typescript
// NestJS
import { ZodValidationPipe } from '@some/zod-pipe';
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

@Post()
@UsePipes(new ZodValidationPipe(CreateUserSchema))
async create(@Body() dto: z.infer<typeof CreateUserSchema>) {
  return this.userService.create(dto);
}
```

### OriJS with TypeBox

```typescript
// OriJS
import { Type, Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const CreateUserSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ format: 'email' }),
});

type CreateUserDto = Static<typeof CreateUserSchema>;

private create = async (ctx: RequestContext) => {
  const body = await ctx.json();

  // Validate
  if (!Value.Check(CreateUserSchema, body)) {
    return ctx.json({ error: 'Validation failed' }, 400);
  }

  const dto = body as CreateUserDto;
  return ctx.json(await this.userService.create(dto), 201);
};
```

---

## Converting Events

### NestJS EventEmitter

```typescript
// NestJS
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class UserService {
  constructor(private eventEmitter: EventEmitter2) {}

  async create(dto: CreateUserDto) {
    const user = await this.db.create(dto);
    this.eventEmitter.emit('user.created', { userId: user.id });
    return user;
  }
}

// Handler
@OnEvent('user.created')
handleUserCreated(payload: { userId: string }) {
  // Handle event
}
```

### OriJS Events

```typescript
// OriJS
import { EventRegistry, AppContext, EventContext } from '@upstat/orijs';

// Define events
const Events = EventRegistry.create()
  .event<{ userId: string }>('user.created')
  .build();

// Service
export class UserService {
  constructor(private ctx: AppContext) {}

  async create(dto: CreateUserDto) {
    const user = await this.db.create(dto);
    this.ctx.event?.emit('user.created', { userId: user.id });
    return user;
  }
}

// Handler
class UserEventHandler {
  configure(e: EventBuilder) {
    e.on('user.created', this.onUserCreated);
  }

  private onUserCreated = async (ctx: EventContext<{ userId: string }>) => {
    // Handle event
  };
}

// Registration
.events(Events)
.eventHandler(UserEventHandler, [])
```

---

## Converting Tests

### NestJS with Jest

```typescript
// NestJS
import { Test, TestingModule } from '@nestjs/testing';

describe('UserService', () => {
	let service: UserService;
	let module: TestingModule;

	beforeEach(async () => {
		module = await Test.createTestingModule({
			providers: [UserService, { provide: DatabaseService, useValue: mockDb }]
		}).compile();

		service = module.get<UserService>(UserService);
	});

	it('should return user', async () => {
		const result = await service.getUser('1');
		expect(result).toBeDefined();
	});
});
```

### OriJS with Bun Test

```typescript
// OriJS
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Container } from '@upstat/orijs';

describe('UserService', () => {
	let service: UserService;
	let container: Container;

	beforeEach(() => {
		container = new Container();

		const mockDb = { findUser: mock(() => Promise.resolve({ id: '1' })) };
		container.registerInstance(DatabaseService, mockDb);
		container.register(UserService, [DatabaseService]);

		service = container.resolve(UserService);
	});

	it('should return user', async () => {
		const result = await service.getUser('1');
		expect(result).toBeDefined();
	});
});
```

---

## Application Entry Point

### NestJS main.ts

```typescript
// NestJS
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	await app.listen(3000);
}
bootstrap();
```

### OriJS main.ts

```typescript
// OriJS
import { Ori } from '@upstat/orijs';

Ori.create()
	.logger({ level: 'info' })
	.config(configProvider)
	.use(addDatabaseModule)
	.use(addUserModule)
	.use(addOrderModule)
	.listen(3000, () => {
		console.log('Server running on port 3000');
	});
```

---

## Migration Checklist

### Phase 1: Setup

- [ ] Install Bun runtime
- [ ] Update tsconfig.json
- [ ] Install OriJS, remove NestJS packages
- [ ] Update package.json scripts

### Phase 2: Core Infrastructure

- [ ] Convert configuration loading
- [ ] Set up logging
- [ ] Convert database connections to provider instances

### Phase 3: Services

- [ ] Remove `@Injectable()` decorators
- [ ] Keep constructor signatures the same
- [ ] Plan dependency registration order

### Phase 4: Controllers

- [ ] Convert `@Controller()` to class implementing `OriController`
- [ ] Convert `@Get()/@Post()` to `r.get()/r.post()`
- [ ] Change method handlers to arrow functions
- [ ] Convert `@Body()/@Param()` to `ctx.json()/ctx.params`

### Phase 5: Guards & Interceptors

- [ ] Convert guards to `Guard` interface
- [ ] Convert interceptors to `Interceptor` interface
- [ ] Update registration to use `.guard()/.intercept()`

### Phase 6: Events & Queues

- [ ] Define event registry
- [ ] Convert event handlers
- [ ] Update event emission to use `AppContext.event`

### Phase 7: Tests

- [ ] Switch from Jest to Bun test
- [ ] Update test setup to use Container
- [ ] Use `.disableSignalHandling()` in tests

### Phase 8: Cleanup

- [ ] Remove all NestJS imports
- [ ] Remove reflect-metadata
- [ ] Remove unused decorators
- [ ] Run full test suite

---

## Common Gotchas

### 1. Arrow Functions Required

NestJS methods work as regular functions because of how it handles binding. OriJS requires arrow functions:

```typescript
// NestJS - works
@Get()
async list() { return this.service.list(); }

// OriJS - must use arrow function
private list = async (ctx: RequestContext) => {
  return ctx.json(await this.service.list());
};
```

### 2. No Module Auto-Discovery

NestJS auto-discovers providers in modules. OriJS requires explicit registration:

```typescript
// Everything must be registered
.provider(DatabaseService)
.provider(UserMapper, [DatabaseService])
.provider(UserService, [DatabaseService, UserMapper])
```

### 3. Different Response Handling

NestJS auto-serializes return values. OriJS requires explicit Response creation:

```typescript
// NestJS - auto-serializes
return { data: 'value' };

// OriJS - explicit Response
return ctx.json({ data: 'value' });
```

### 4. Validation Happens in Handler

NestJS pipes run before the handler. In OriJS, validate inside or use pipes:

```typescript
private create = async (ctx: RequestContext) => {
  const body = await ctx.json();

  // Validate manually
  if (!Value.Check(Schema, body)) {
    return ctx.json({ error: 'Invalid' }, 400);
  }

  // Continue with valid data
};
```

---

## Getting Help

- Review the [Getting Started](./getting-started.md) guide
- Check the [API Reference](./api-reference.md) for method signatures
- Look at example applications in the codebase
- Consult [Troubleshooting](./troubleshooting.md) for common issues
