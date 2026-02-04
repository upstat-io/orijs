# Troubleshooting

Common issues and their solutions when working with OriJS.

---

## Dependency Injection Issues

### "Service X is not registered"

**Error:**

```
Error: Service UserService is not registered.

Fix: Register the service as a provider:
  .provider(UserService, [/* dependencies */])

Or if it's pre-instantiated:
  .providerInstance(UserService, instance)
```

**Cause:** The service is used as a dependency but wasn't registered with the application.

**Solution:** Register the service before using it:

```typescript
// WRONG
Ori.create()
	.controller('/api', UserController, [UserService]) // UserService not registered
	.listen(3000);

// CORRECT
Ori.create()
	.provider(UserService) // Register first
	.controller('/api', UserController, [UserService])
	.listen(3000);
```

---

### "Circular dependency detected"

**Error:**

```
Error: Circular dependency detected: ServiceA -> ServiceB -> ServiceA
```

**Cause:** Two or more services depend on each other, creating a cycle.

**Solution 1:** Extract shared logic into a new service:

```typescript
// BEFORE (circular)
class ServiceA {
	constructor(private b: ServiceB) {}
}
class ServiceB {
	constructor(private a: ServiceA) {}
}

// AFTER (no cycle)
class SharedService {
	// Shared logic here
}
class ServiceA {
	constructor(private shared: SharedService) {}
}
class ServiceB {
	constructor(private shared: SharedService) {}
}
```

**Solution 2:** Use events for decoupling:

```typescript
// Instead of direct dependency
class OrderService {
	constructor(private ctx: AppContext) {}

	async complete(orderId: string) {
		// Emit event instead of calling InventoryService directly
		this.ctx.event?.emit('order.completed', { orderId });
	}
}
```

---

### "Constructor parameter count mismatch"

**Error:**

```
Error: Service UserService has 2 constructor parameters but 1 dependencies declared
```

**Cause:** The dependency array doesn't match the constructor parameters.

**Solution:** Ensure the dependency array matches the constructor:

```typescript
class UserService {
  constructor(
    private db: DatabaseService,
    private cache: CacheService,  // 2 params
  ) {}
}

// WRONG
.provider(UserService, [DatabaseService])  // Only 1 dep

// CORRECT
.provider(UserService, [DatabaseService, CacheService])  // Match constructor
```

---

### "Async constructor not supported"

**Error:**

```
Error: Service DatabaseService returned a Promise. Use resolveAsync() instead.
```

**Cause:** The constructor is async but you're using synchronous resolution.

**Solution 1:** Use `resolveAsync()`:

```typescript
const db = await container.resolveAsync(DatabaseService);
```

**Solution 2:** Move async work to startup hooks:

```typescript
// BEFORE (async constructor)
class DatabaseService {
	constructor() {
		return this.init(); // Returns Promise
	}
	private async init() {
		await this.connect();
		return this;
	}
}

// AFTER (sync constructor + startup hook)
class DatabaseService {
	constructor(private ctx: AppContext) {
		ctx.onStartup(async () => {
			await this.connect();
		});
	}
}
```

---

### "Slow service resolution warning"

**Warning:**

```
[WARN] Slow service resolution for DatabaseService (5234ms)
```

**Cause:** A service takes too long to instantiate, often due to blocking operations.

**Solution:** Move blocking operations to lifecycle hooks:

```typescript
// BEFORE (blocking constructor)
class ConfigService {
	private config: Config;

	constructor() {
		this.config = JSON.parse(fs.readFileSync('./config.json', 'utf8')); // Blocking!
	}
}

// AFTER (async in startup hook)
class ConfigService {
	private config!: Config;

	constructor(private ctx: AppContext) {
		ctx.onStartup(async () => {
			const content = await Bun.file('./config.json').text();
			this.config = JSON.parse(content);
		});
	}
}
```

---

## Controller Issues

### Handler `this` is undefined

**Error:**

```
TypeError: Cannot read properties of undefined (reading 'userService')
```

**Cause:** Using regular methods instead of arrow functions for handlers.

**Solution:** Use arrow functions:

```typescript
// WRONG - 'this' is lost
class UserController {
	private getUser(ctx: RequestContext) {
		return ctx.json(this.userService.get()); // 'this' is undefined!
	}
}

// CORRECT - arrow function preserves 'this'
class UserController {
	private getUser = async (ctx: RequestContext) => {
		return ctx.json(this.userService.get()); // Works!
	};
}
```

---

### Route not found (404)

**Possible Causes:**

1. **Wrong path:** Check the controller path + route path combination

```typescript
.controller('/api/users', UserController)  // Base path

// In controller
r.get('/list', this.list);  // Full path: /api/users/list
```

2. **Controller not registered:**

```typescript
// Forgot to register
Ori.create()
	.provider(UserService)
	// Missing: .controller('/api', UserController, [UserService])
	.listen(3000);
```

3. **Route method mismatch:**

```typescript
// Defined as POST
r.post('/create', this.create);

// But called with GET
curl http://localhost:3000/api/users/create  // 404!
curl -X POST http://localhost:3000/api/users/create  // Works
```

---

### Guard always rejects (403)

**Possible Causes:**

1. **Guard returns false or throws:**

```typescript
class AuthGuard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		const token = ctx.request.headers.get('Authorization');

		if (!token) {
			ctx.log.warn('No token');
			return false; // Causes 403
		}

		// Missing: Set ctx.state and return true!
		return true; // Don't forget this
	}
}
```

2. **Async guard without await:**

```typescript
// WRONG
async canActivate(ctx: RequestContext): Promise<boolean> {
  this.validateToken(token);  // Missing await!
  return true;
}

// CORRECT
async canActivate(ctx: RequestContext): Promise<boolean> {
  await this.validateToken(token);
  return true;
}
```

---

## Event Issues

### Event handler not called

**Possible Causes:**

1. **Event system not configured:**

```typescript
// Missing .events()
Ori.create()
	.onEvent('user.created', handler) // Won't work!
	.listen(3000);

// CORRECT
Ori.create()
	.events(Events) // Configure first
	.onEvent('user.created', handler)
	.listen(3000);
```

2. **Event name mismatch:**

```typescript
// Registry defines
.event<{userId: string}>('user.created')

// But handler listens to
.onEvent('user_created', handler)  // Wrong name!
```

3. **Handler class not registered:**

```typescript
// Handler class defined but not registered
class UserEventHandler {
  configure(e: EventBuilder) {
    e.on('user.created', this.handle);
  }
}

// CORRECT - register it
.eventHandler(UserEventHandler, [EmailService])
```

---

### Events not emitting

**Possible Causes:**

1. **No event system on context:**

```typescript
// Check if event system exists
this.ctx.event?.emit('user.created', data); // Safe with ?.
```

2. **Missing await (if you need to wait):**

```typescript
// Fire and forget is fine
this.ctx.event?.emit('user.created', data);

// But if you need it complete before continuing:
await this.ctx.event?.emit('user.created', data);
```

---

## Workflow Issues

### Workflow not starting

**Possible Causes:**

1. **Workflow system not configured:**

```typescript
// Missing .workflows()
const handle = await ctx.workflows.start('OrderWorkflow', data); // Error!

// CORRECT
Ori.create()
	.workflows(Workflows) // Configure first
	.listen(3000);
```

2. **Workflow not registered:**

```typescript
const Workflows = WorkflowRegistry.create()
	// Missing: .workflow(OrderProcessingWorkflow)
	.build();
```

---

### Rollback not executing

**Possible Causes:**

1. **No rollback handler defined:**

```typescript
// Without rollback
w.step('reserve', this.reserve); // No rollback

// With rollback
w.step('reserve', this.reserve, this.release); // Has rollback
```

2. **Step completed successfully:**

Rollbacks only execute for steps that completed before the failure.

---

## Test Issues

### Tests interfere with each other

**Solution:** Use `.disableSignalHandling()` and clean up:

```typescript
let app: Application;

beforeEach(async () => {
	app = Ori.create()
		.disableSignalHandling() // Important!
		.provider(UserService)
		.controller('/api', UserController, [UserService]);

	await app.listen(0);
});

afterEach(async () => {
	await app.stop(); // Clean up!
});
```

---

### Port already in use

**Error:**

```
Error: Failed to start server on port 3000: EADDRINUSE
```

**Solution:** Use port 0 for random available port:

```typescript
const server = await app.listen(0); // Random port
const baseUrl = `http://localhost:${server.port}`;
```

---

### Singleton state persists between tests

**Solution:** Clear container instances:

```typescript
afterEach(() => {
	container.clearInstances();
});
```

---

## Configuration Issues

### "Required configuration not set"

**Error:**

```
Error: Required configuration DATABASE_URL is not set
```

**Solution:** Set the environment variable or provide a default:

```bash
# Set in environment
export DATABASE_URL=postgresql://localhost/db
```

Or in code:

```typescript
const config = new EnvConfig({
	DATABASE_URL: { required: true }, // Must be set
	PORT: { default: '3000' } // Optional with default
});
```

---

### Configuration validation fails

**Error:**

```
Error: Configuration validation failed:
- port: Expected number, received 'not-a-number'
```

**Solution:** Ensure environment variables match the schema:

```typescript
// Schema expects number
port: Type.Number();

// But env has string that's not a number
PORT = not - a - number; // Wrong!
PORT = 3000; // Correct
```

---

## General Tips

### Enable Debug Logging

```typescript
Ori.create().logger({ level: 'debug' }).listen(3000);
```

### Validate Container Early

```typescript
const app = Ori.create().provider(UserService).controller('/api', UserController, [UserService]);

// Validate before listening
app.getContainer().validate();

await app.listen(3000);
```

### Check Registered Routes

```typescript
const app = Ori.create().controller('/api', UserController).controller('/admin', AdminController);

console.log(app.getRoutes());
// [{ method: 'GET', path: '/api/list' }, ...]
```

### Check Registered Services

```typescript
const container = app.getContainer();
console.log(container.getRegisteredNames());
// ['UserService', 'DatabaseService', ...]
```

---

## Promise and Async Issues

### Unhandled Promise Rejection in Tests

**Error:**

```
error: Unhandled rejection: Error: timeout
```

**Cause:** Using parallel promise handlers instead of chained handlers.

**CRITICAL:** Never use parallel handlers with `.catch()` and `.finally()`:

```typescript
// WRONG - parallel handlers create unhandled rejection:
const promise = someAsyncOperation();
promise.catch(() => {});
promise.finally(() => cleanup());
// The .finally() returns a NEW promise that rejects - unhandled!

// CORRECT - chained handlers:
const promise = someAsyncOperation();
promise.catch(() => {}).finally(() => cleanup());
// Single chain, fully handled
```

**Why This Happens:**

- `.finally()` returns a NEW promise
- If the original promise rejects, `.finally()`'s promise also rejects
- With parallel handlers, you have two separate promise chains
- The `.finally()` chain has no `.catch()` = unhandled rejection

**Common Pattern for Timeout Cleanup:**

```typescript
const promise = new Promise((resolve, reject) => {
	state.resolve = resolve;
	state.reject = reject;
});

const timeout = setTimeout(() => state.reject(new Error('timeout')), 30000);

// CORRECT: Chain catch and finally
promise.catch(() => {}).finally(() => clearTimeout(timeout));

// Return original promise for caller to await
return { result: () => promise };
```

---

## Getting Help

If you're still stuck:

1. Check the [API Reference](./api-reference.md) for correct method signatures
2. Review the [Testing](./testing.md) guide for debugging techniques
3. Look at the example application in the `example/` directory
4. Check test files in `__tests__/` for usage examples
