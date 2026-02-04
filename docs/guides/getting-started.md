# Getting Started with OriJS

This guide walks you through installing OriJS and creating your first application.

> **Quick reference**: See the [README](../README.md#quick-start) for a minimal example you can copy-paste and run immediately.

---

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- Basic TypeScript knowledge
- A code editor with TypeScript support

```bash
# Verify Bun is installed
bun --version
```

---

## Installation

### New Project

```bash
# Create project directory
mkdir my-app && cd my-app

# Initialize with Bun
bun init -y

# Install OriJS
bun add @upstat/orijs
```

### Existing Project

```bash
bun add @upstat/orijs
```

### Optional Dependencies

Install based on features you need:

```bash
# Redis-based caching
bun add ioredis

# Queue-based events and workflows
bun add bullmq

# Database access
bun add postgres
```

---

## Your First Application

Create `app.ts`:

```typescript
import { Ori, RouteBuilder, RequestContext } from '@upstat/orijs';

// Define a controller
class HealthController {
	configure(r: RouteBuilder) {
		r.get('/health', this.health);
		r.get('/info', this.info);
	}

	// Arrow functions preserve 'this' binding
	private health = async () => {
		return Response.json({ status: 'ok' });
	};

	private info = async (ctx: RequestContext) => {
		return ctx.json({
			name: 'my-app',
			version: '1.0.0',
			timestamp: new Date().toISOString()
		});
	};
}

// Create and start the application
Ori.create()
	.controller('/', HealthController)
	.listen(3000, () => {
		console.log('Server running at http://localhost:3000');
	});
```

Run it:

```bash
bun run app.ts
```

Test it:

```bash
curl http://localhost:3000/health
# {"status":"ok"}

curl http://localhost:3000/info
# {"name":"my-app","version":"1.0.0","timestamp":"..."}
```

---

## Adding Services

Create `services/user.service.ts`:

```typescript
interface User {
	id: string;
	name: string;
	email: string;
}

export class UserService {
	private users: User[] = [
		{ id: '1', name: 'Alice', email: 'alice@example.com' },
		{ id: '2', name: 'Bob', email: 'bob@example.com' }
	];

	list(): User[] {
		return this.users;
	}

	findById(id: string): User | undefined {
		return this.users.find((u) => u.id === id);
	}

	create(name: string, email: string): User {
		const user = { id: String(this.users.length + 1), name, email };
		this.users.push(user);
		return user;
	}
}
```

Create `controllers/user.controller.ts`:

```typescript
import { RouteBuilder, RequestContext, OriController } from '@upstat/orijs';
import { UserService } from '../services/user.service';

export class UserController implements OriController {
	constructor(private userService: UserService) {}

	configure(r: RouteBuilder) {
		r.get('/list', this.list);
		r.get('/:id', this.findById);
		r.post('/create', this.create);
	}

	private list = async (ctx: RequestContext) => {
		return ctx.json(this.userService.list());
	};

	private findById = async (ctx: RequestContext) => {
		const { id } = ctx.params;
		const user = this.userService.findById(id);

		if (!user) {
			return ctx.json({ error: 'User not found' }, 404);
		}

		return ctx.json(user);
	};

	private create = async (ctx: RequestContext) => {
		const { name, email } = await ctx.json<{ name: string; email: string }>();
		const user = this.userService.create(name, email);
		return ctx.json(user, 201);
	};
}
```

Update `app.ts`:

```typescript
import { Ori } from '@upstat/orijs';
import { UserService } from './services/user.service';
import { UserController } from './controllers/user.controller';

Ori.create()
	// Register service first
	.provider(UserService)
	// Register controller with its dependency
	.controller('/api/users', UserController, [UserService])
	.listen(3000, () => {
		console.log('Server running at http://localhost:3000');
	});
```

Test the API:

```bash
# List users
curl http://localhost:3000/api/users/list

# Get user by ID
curl http://localhost:3000/api/users/1

# Create user
curl -X POST http://localhost:3000/api/users/create \
  -H "Content-Type: application/json" \
  -d '{"name":"Charlie","email":"charlie@example.com"}'
```

---

## Project Structure

Recommended structure for a typical OriJS project:

```
my-app/
├── app.ts                    # Application entry point
├── package.json
├── tsconfig.json
├── src/
│   ├── controllers/          # HTTP controllers
│   │   ├── user.controller.ts
│   │   └── project.controller.ts
│   ├── services/             # Business logic services
│   │   ├── user.service.ts
│   │   └── project.service.ts
│   ├── providers/            # Extension modules
│   │   ├── database.ts
│   │   └── events.ts
│   ├── events/               # Event handlers
│   │   └── user.events.ts
│   ├── workflows/            # Workflow definitions
│   │   └── order.workflow.ts
│   └── types/                # Type definitions
│       └── index.ts
└── __tests__/                # Test files
    └── user.spec.ts
```

---

## Using Extension Functions

As your app grows, organize related providers into extension functions:

```typescript
// src/providers/database.ts
import { Application } from '@upstat/orijs';
import { SQL } from 'postgres';

export function addDatabase(app: Application, sql: SQL): Application {
	return app
		.providerInstance('SQL', sql)
		.provider(UserMapper)
		.provider(ProjectMapper)
		.provider(DbUserService, ['SQL', UserMapper]);
}

// src/providers/controllers.ts
export function addControllers(app: Application): Application {
	return app
		.controller('/api/users', UserController, [UserService])
		.controller('/api/projects', ProjectController, [ProjectService]);
}

// app.ts
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL!);

Ori.create()
	.use((app) => addDatabase(app, sql))
	.use(addControllers)
	.listen(3000);
```

---

## Adding Logging

```typescript
import { Ori, FileTransport } from '@upstat/orijs';

Ori.create()
	.logger({
		level: 'info',
		transports: [new FileTransport('./logs')]
	})
	.provider(UserService)
	.controller('/api/users', UserController, [UserService])
	.listen(3000);
```

---

## Next Steps

Now that you have a running application:

1. **[Core Concepts](./core-concepts.md)** - Learn about DI, AppContext, and lifecycle
2. **[HTTP & Routing](./http-routing.md)** - Add guards, interceptors, and validation
3. **[Events](./events.md)** - Decouple components with pub/sub
4. **[Testing](./testing.md)** - Write tests for your services and controllers

---

## Troubleshooting

### "Service X is not registered"

Make sure you register the service before any controller that depends on it:

```typescript
Ori.create()
	.provider(UserService) // Register first
	.controller('/api/users', UserController, [UserService]); // Then use
```

### "Cannot find module '@upstat/orijs'"

Ensure you've installed the package:

```bash
bun add @upstat/orijs
```

### Server doesn't start

Check for port conflicts:

```bash
lsof -i :3000
```

Use a different port if needed:

```typescript
.listen(3001, () => console.log('Server on :3001'));
```
