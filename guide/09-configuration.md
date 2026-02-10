# Chapter 9: Configuration

[Previous: Interceptors ←](./08-interceptors.md) | [Next: Data Mapping →](./10-data-mapping.md)

---

Configuration seems simple until it isn't. You start with `process.env.PORT`, and before long you have a codebase where environment variables are read in 47 different files, nobody knows which ones are required, and the app crashes twenty minutes into startup because `REDIS_HOST` was never set.

OriJS treats configuration as a first-class concern. The `@orijs/config` package provides three levels of configuration -- from simple env reads to fully validated, namespaced, multi-provider config systems -- and like everything in OriJS, the entire config system is a **provider** that you can swap.

## The Problem with process.env

Before looking at the solution, let's understand what goes wrong with the typical approach.

### No Validation

```typescript
// This will happily return undefined and crash later
const port = process.env.PORT;
server.listen(port); // Error: listen EACCES: undefined
```

The error message says nothing about a missing environment variable. You get a cryptic Node.js error instead of "PORT is not set." Worse, the crash happens at listen time -- potentially minutes after startup, after database connections are established and migrations have run.

### No Type Safety

```typescript
const maxRetries = process.env.MAX_RETRIES; // string | undefined
if (maxRetries > 3) { /* string comparison, not number! */ }

const enableCache = process.env.ENABLE_CACHE; // "true" is truthy, but so is "false"
if (enableCache) { /* always truthy if set to any string */ }
```

Environment variables are always strings. Every read site needs its own parsing logic, and developers regularly forget to convert types. String comparisons with numbers are a classic source of subtle bugs.

### Scattered Reads

```typescript
// In file A:
const dbUrl = process.env.DATABASE_URL;

// In file B (20 directories away):
const dbUrl = process.env.DB_URL; // Oops, different name

// In file C:
const dbUrl = process.env.DATABASE_URL || 'postgres://localhost/mydb'; // Has a default

// In file D:
const dbUrl = process.env.DATABASE_URL!; // Non-null assertion, will crash
```

When env variables are read directly throughout the codebase, you have no single source of truth for which variables exist, which are required, what their defaults are, or where they're used.

### Secret Leakage

In production, secrets often come from a vault or cloud secret manager -- not environment variables. When your services read `process.env.SECRET_API_KEY` directly, switching to a vault requires touching every file that reads a secret.

## EnvConfig: Simple Applications

For small applications or local development, `EnvConfigProvider` is the simplest way to read configuration. It wraps Bun's built-in `Bun.env`, which automatically loads `.env` files in this priority order:

1. Shell environment variables
2. `.env.local`
3. `.env.{NODE_ENV}` (e.g., `.env.development`)
4. `.env`

```typescript
import { EnvConfigProvider } from '@orijs/config';

const config = new EnvConfigProvider();

// Optional read -- returns undefined if not set
const port = await config.get('PORT');

// Required read -- throws a clear error if missing
const dbUrl = await config.getRequired('DATABASE_URL');
// Error: Required config 'DATABASE_URL' is not set. Add it to your .env file or environment.

// Batch read -- load multiple keys at once
const values = await config.loadKeys(['PORT', 'HOST', 'DATABASE_URL']);
// { PORT: '8001', HOST: 'localhost', DATABASE_URL: 'postgres://...' }
```

The API is intentionally async. Even though reading `Bun.env` is synchronous, the `ConfigProvider` interface is async because production providers (Vault, AWS SSM, Google Secret Manager) need to make network calls. By making the interface async from the start, swapping providers never requires changing calling code.

### When to Use EnvConfig

EnvConfig is appropriate when:

- You're building a small service with few config values
- All configuration comes from environment variables
- You don't need startup validation (fail-fast on missing keys)
- You're prototyping and want zero ceremony

For anything beyond a prototype, wrap it with `ValidatedConfig`.

## ValidatedConfig: Fail Fast, Fail Clearly

`ValidatedConfig` wraps any `ConfigProvider` and adds two critical capabilities: **startup validation** (declare what keys must exist) and **access tracking** (know which keys your app actually reads).

```typescript
import { EnvConfigProvider, ValidatedConfig } from '@orijs/config';

const config = new ValidatedConfig(new EnvConfigProvider())
  .expectKeys('DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'PORT')
  .onFail('error')  // Throw on missing keys (use 'warn' for non-fatal)

await config.validate();
// If any key is missing:
// Error: Missing required config keys: JWT_SECRET, PORT
```

### Why Validate at Startup

The `validate()` call loads all expected keys at once and checks that every one is present and non-empty. If anything is missing, you find out immediately -- before your app connects to databases, sets up queues, or starts accepting traffic.

This is the **fail-fast principle** applied to configuration. Without it, your app might run for hours before a code path finally reads the missing key and crashes. With validated config, the app never starts in a broken state.

### Fail Modes

`onFail()` controls what happens when keys are missing:

```typescript
// Production: crash immediately
.onFail('error')  // Throws Error, app won't start

// Development: warn but continue (maybe the missing key isn't needed for your current work)
.onFail('warn')   // Logs warning, continues running
```

The default is `'warn'`, which is lenient for development. **Always use `'error'` in production.**

### Sync Access After Validation

Once `validate()` has run, all expected keys are cached in memory. You can read them synchronously:

```typescript
await config.validate();

// Sync access -- no await needed, but only works for keys in expectKeys()
const port = config.getRequiredSync('PORT');     // '8001'
const dbUrl = config.getRequiredSync('DATABASE_URL'); // 'postgres://...'

// For keys NOT in expectKeys(), use async access
const optionalKey = await config.get('OPTIONAL_THING'); // still works
```

This is important for constructors, where you can't use `await`:

```typescript
class DatabaseService {
  private readonly connectionString: string;

  constructor(private config: ValidatedConfig) {
    // Safe because validate() was called before this service is instantiated
    this.connectionString = config.getRequiredSync('DATABASE_URL');
  }
}
```

### Access Tracking

ValidatedConfig tracks every key your application reads. This is useful for debugging and auditing:

```typescript
// After your app has been running...
config.logLoadedKeys();
// INFO: Config Keys Accessed: DATABASE_URL, REDIS_URL, PORT, JWT_SECRET

// Or get the list programmatically
const accessed = config.getLoadedKeys();
// ['DATABASE_URL', 'REDIS_URL', 'PORT', 'JWT_SECRET']
```

This helps you answer questions like "which config keys does the billing service actually use?" -- invaluable when cleaning up old environment variables or migrating to a new config source.

## Comparison: EnvConfig vs ValidatedConfig

| Feature | EnvConfigProvider | ValidatedConfig |
|---|---|---|
| Read env variables | Yes | Yes (delegates) |
| Required key checks | Per-read only | Startup validation |
| Fail-fast on missing | No | Yes (`onFail('error')`) |
| Sync access | No | Yes (after validate) |
| Access tracking | No | Yes |
| Key caching | No | Yes |
| Wraps other providers | No | Yes (any ConfigProvider) |
| Best for | Prototypes, scripts | Production services |

## NamespacedConfig: Large Applications

Real production applications don't get all their configuration from environment variables. Secrets come from a vault. Feature flags come from a config service. Infrastructure settings come from environment variables. `NamespacedConfigBuilder` (created via `createConfigProvider()`) handles this by organizing configuration into **namespaces**, each backed by a different provider.

```typescript
import { createConfigProvider } from '@orijs/config';
import { GsmConfigProvider } from './providers/gsm-config-provider';

const config = await createConfigProvider()
  .add('secrets', GsmConfigProvider)  // Google Secret Manager
  .expectKeys({
    env: ['PORT', 'NODE_ENV', 'LOG_LEVEL'],
    secrets: ['SECRET_DB_CONNECTION_STRING', 'SECRET_REDIS_HOST', 'SECRET_JWT_KEY']
  })
  .onFail('error')
  .validate();
```

### How It Works

The `env` namespace is always available -- it reads from `Bun.env` automatically. You add additional namespaces with `.add()`, each backed by a `ConfigProvider`. During `validate()`, the builder:

1. Loads all expected keys from each namespace in parallel
2. Validates that every expected key is present and non-empty
3. Caches all values for sync access
4. Returns a proxy object where you access values by namespace

```typescript
// After validate(), all access is synchronous
const port = config.env.PORT;                           // '8001'
const dbUrl = config.secrets.SECRET_DB_CONNECTION_STRING; // 'postgres://...'
const redisHost = config.secrets.SECRET_REDIS_HOST;       // 'redis.internal'
```

### Provider Resolution

The `.add()` method accepts three forms of provider:

```typescript
// 1. An instance (already created)
const gsmProvider = new GsmConfigProvider({ project: 'my-project' });
builder.add('secrets', gsmProvider);

// 2. A class constructor (will be instantiated with new)
builder.add('secrets', GsmConfigProvider);

// 3. A factory object with async create() (for providers that need async init)
const factory = {
  async create() {
    const client = await connectToVault();
    return new VaultConfigProvider(client);
  }
};
builder.add('secrets', factory);
```

The factory pattern is particularly useful for providers that need to authenticate before they can read values. The async `create()` method runs during `validate()`, which is already async.

### Config Transformers

Sometimes you need to derive structured configuration from raw key-value pairs. Transformers do this as a pure function applied after validation:

```typescript
import type { ConfigTransformer } from '@orijs/config';

interface RedisConfig {
  host: string;
  port: number;
  password: string;
}

const RedisConfigTransformer: ConfigTransformer<
  { secrets: { SECRET_REDIS_HOST: string; SECRET_REDIS_PORT: string; SECRET_REDIS_PASSWORD: string } },
  RedisConfig
> = {
  property: 'redis',
  transform: (config) => ({
    host: config.secrets.SECRET_REDIS_HOST,
    port: Number(config.secrets.SECRET_REDIS_PORT) || 6379,
    password: config.secrets.SECRET_REDIS_PASSWORD,
  }),
};

// Apply during build
interface AppConfig {
  env: { PORT: string; NODE_ENV: string };
  secrets: { SECRET_REDIS_HOST: string; SECRET_REDIS_PORT: string; SECRET_REDIS_PASSWORD: string };
  redis: RedisConfig;
}

const config = await createConfigProvider()
  .add('secrets', GsmConfigProvider)
  .expectKeys({
    env: ['PORT', 'NODE_ENV'],
    secrets: ['SECRET_REDIS_HOST', 'SECRET_REDIS_PORT', 'SECRET_REDIS_PASSWORD']
  })
  .transform(RedisConfigTransformer)
  .validate<AppConfig>();

// Now config.redis is a typed, structured object
const { host, port, password } = config.redis;
```

Transformers are pure functions that take the validated config and return a derived value. They run in the order they're added, so later transformers can depend on earlier ones.

### Typed Config Results

The `validate()` method accepts a generic type parameter that types the returned config object:

```typescript
interface AppConfig {
  env: {
    PORT: string;
    NODE_ENV: string;
    LOG_LEVEL: string;
  };
  secrets: {
    SECRET_DB_URL: string;
    SECRET_API_KEY: string;
  };
}

const config = await createConfigProvider()
  .add('secrets', GsmConfigProvider)
  .expectKeys({
    env: ['PORT', 'NODE_ENV', 'LOG_LEVEL'],
    secrets: ['SECRET_DB_URL', 'SECRET_API_KEY']
  })
  .validate<AppConfig>();

// TypeScript knows the shape
config.env.PORT;            // string
config.secrets.SECRET_DB_URL; // string
config.env.NONEXISTENT;     // TypeScript error!
```

## Accessing Config in Services

The validated config object also implements the `ConfigProvider` interface, so it can be used anywhere a `ConfigProvider` is expected:

```typescript
// The result of validate() is both a typed config AND a ConfigProvider
const config = await createConfigProvider()
  .add('secrets', GsmConfigProvider)
  .expectKeys({ secrets: ['SECRET_API_KEY'] })
  .validate();

// Use as typed config (sync access)
const apiKey = config.secrets.SECRET_API_KEY;

// Use as ConfigProvider (async interface)
const key = await config.get('SECRET_API_KEY');
const required = await config.getRequired('SECRET_API_KEY');
```

### Injecting Config via the Application

In an OriJS application, config is typically passed to the application builder and made available through dependency injection:

```typescript
import { Ori } from '@orijs/orijs';
import { createConfigProvider } from '@orijs/config';

// Create and validate config
const config = await createConfigProvider()
  .add('secrets', GsmConfigProvider)
  .expectKeys({
    env: ['PORT', 'NODE_ENV'],
    secrets: ['SECRET_DB_URL', 'SECRET_REDIS_HOST']
  })
  .onFail('error')
  .validate<AppConfig>();

// Pass to application
const app = Ori.create()
  .config(config)
  .provider(DatabaseService, [AppContext])
  .provider(CacheService, [AppContext])
  .listen(Number(config.env.PORT));
```

Services access config through `AppContext`:

```typescript
class DatabaseService {
  private readonly connectionString: string;

  constructor(private app: AppContext) {
    // AppContext.config is the ConfigProvider
    // If you used ValidatedConfig, you can getRequiredSync
  }

  async connect() {
    const dbUrl = await this.app.config.getRequired('SECRET_DB_URL');
    // ...
  }
}
```

## Writing a Custom Config Provider

The config system is provider-based. The `ConfigProvider` interface is intentionally minimal:

```typescript
interface ConfigProvider {
  /** Get a value by key, or undefined if not found */
  get(key: string): Promise<string | undefined>;

  /** Get a required value, throw if missing */
  getRequired(key: string): Promise<string>;

  /** Load multiple keys at once (for batch optimization) */
  loadKeys(keys: string[]): Promise<Record<string, string | undefined>>;
}
```

Three methods. That's it. Any class that implements these three methods is a config provider.

### Example: AWS SSM Provider

```typescript
import type { ConfigProvider } from '@orijs/config';
import { SSMClient, GetParametersByPathCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

class AwsSsmConfigProvider implements ConfigProvider {
  private readonly client: SSMClient;
  private readonly prefix: string;

  constructor(options: { region: string; prefix: string }) {
    this.client = new SSMClient({ region: options.region });
    this.prefix = options.prefix;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const result = await this.client.send(new GetParameterCommand({
        Name: `${this.prefix}/${key}`,
        WithDecryption: true
      }));
      return result.Parameter?.Value;
    } catch {
      return undefined;
    }
  }

  async getRequired(key: string): Promise<string> {
    const value = await this.get(key);
    if (value === undefined) {
      throw new Error(`Required SSM parameter '${this.prefix}/${key}' not found`);
    }
    return value;
  }

  async loadKeys(keys: string[]): Promise<Record<string, string | undefined>> {
    // Batch load for efficiency
    const result: Record<string, string | undefined> = {};
    // SSM GetParameters supports up to 10 keys per call
    for (let i = 0; i < keys.length; i += 10) {
      const batch = keys.slice(i, i + 10);
      const params = await this.client.send(new GetParametersByPathCommand({
        Path: this.prefix,
        WithDecryption: true
      }));
      for (const param of params.Parameters ?? []) {
        const key = param.Name?.replace(`${this.prefix}/`, '');
        if (key && batch.includes(key)) {
          result[key] = param.Value;
        }
      }
    }
    // Fill in undefined for missing keys
    for (const key of keys) {
      if (!(key in result)) result[key] = undefined;
    }
    return result;
  }
}
```

### Using the Custom Provider

```typescript
const config = await createConfigProvider()
  .add('secrets', new AwsSsmConfigProvider({
    region: 'us-east-1',
    prefix: '/myapp/production'
  }))
  .expectKeys({
    env: ['PORT', 'NODE_ENV'],
    secrets: ['DB_PASSWORD', 'API_KEY', 'JWT_SECRET']
  })
  .onFail('error')
  .validate();
```

### Async Factory Pattern

For providers that need async initialization (authentication, token exchange), use the factory pattern:

```typescript
class VaultConfigProvider implements ConfigProvider {
  private constructor(private client: VaultClient) {}

  static async create(): Promise<VaultConfigProvider> {
    const client = await VaultClient.connect({
      address: Bun.env.VAULT_ADDR,
      token: Bun.env.VAULT_TOKEN,
    });
    return new VaultConfigProvider(client);
  }

  async get(key: string): Promise<string | undefined> {
    const secret = await this.client.read(`secret/data/${key}`);
    return secret?.data?.data?.[key];
  }

  async getRequired(key: string): Promise<string> {
    const value = await this.get(key);
    if (!value) throw new Error(`Vault secret '${key}' not found`);
    return value;
  }

  async loadKeys(keys: string[]): Promise<Record<string, string | undefined>> {
    const result: Record<string, string | undefined> = {};
    for (const key of keys) {
      result[key] = await this.get(key);
    }
    return result;
  }
}

// The builder detects the static create() method and uses it
const config = await createConfigProvider()
  .add('vault', VaultConfigProvider)
  .expectKeys({ vault: ['DB_PASSWORD', 'API_KEY'] })
  .validate();
```

## Best Practices

### 1. Validate Early, Fail Fast

Always call `validate()` before starting your application. Missing config should prevent startup, not cause runtime crashes.

```typescript
// Good: validate before anything else
const config = await createConfigProvider()
  .expectKeys({ env: ['DATABASE_URL', 'REDIS_URL'] })
  .onFail('error')
  .validate();

const app = Ori.create()
  .config(config)
  // ... providers that depend on config
  .listen(8001);
```

### 2. Defaults for Development, Required for Production

Use `.env` files with sensible defaults for local development, but require explicit values in production:

```env
# .env.development
PORT=8001
DATABASE_URL=postgres://localhost:5432/myapp_dev
REDIS_URL=redis://localhost:6379
LOG_LEVEL=debug
```

```typescript
const failMode = Bun.env.NODE_ENV === 'production' ? 'error' : 'warn';

const config = await createConfigProvider()
  .expectKeys({ env: ['PORT', 'DATABASE_URL', 'REDIS_URL'] })
  .onFail(failMode)
  .validate();
```

### 3. Type at the Boundary, Not Everywhere

Parse and validate config values once, at startup, then pass typed objects to services:

```typescript
// Good: parse once in config transformer
const DatabaseConfigTransformer: ConfigTransformer = {
  property: 'database',
  transform: (config) => ({
    connectionString: config.secrets.SECRET_DB_URL,
    poolSize: Number(config.env.DB_POOL_SIZE) || 10,
    ssl: config.env.NODE_ENV === 'production',
  }),
};

// Services receive typed config, never parse strings
class DatabaseService {
  constructor(private dbConfig: DatabaseConfig) {
    // dbConfig.poolSize is already a number
    // dbConfig.ssl is already a boolean
  }
}
```

### 4. Never Read process.env in Services

Services should receive configuration through dependency injection, never by reading environment variables directly:

```typescript
// Bad: service reads env directly
class EmailService {
  async send(to: string) {
    const apiKey = process.env.SENDGRID_API_KEY; // Hidden dependency, untestable
  }
}

// Good: config injected through constructor
class EmailService {
  constructor(private config: AppConfig) {}

  async send(to: string) {
    const apiKey = this.config.secrets.SENDGRID_API_KEY; // Explicit, testable
  }
}
```

### 5. Group Related Config with Namespaces

Use namespaces to organize config by concern, not by source:

```typescript
const config = await createConfigProvider()
  .add('secrets', GsmConfigProvider)
  .expectKeys({
    env: ['PORT', 'NODE_ENV', 'LOG_LEVEL'],      // Infrastructure
    secrets: [
      'SECRET_DB_URL',                             // Database
      'SECRET_REDIS_HOST',                          // Cache
      'SECRET_SENDGRID_KEY',                        // Email
      'SECRET_STRIPE_KEY',                          // Payments
    ]
  })
  .transform(DatabaseConfigTransformer)
  .transform(RedisConfigTransformer)
  .transform(EmailConfigTransformer)
  .validate<AppConfig>();
```

## Summary

OriJS configuration addresses the fundamental problems with `process.env` through a layered system:

- **EnvConfigProvider** for simple env reads with a consistent async interface
- **ValidatedConfig** for startup validation, fail-fast behavior, and sync access
- **NamespacedConfigBuilder** for multi-source configuration with typed results and transformers
- **ConfigProvider interface** for writing custom providers (Vault, SSM, GCP Secret Manager)

The entire system is built on the provider pattern. The config source is an implementation detail that your services never need to know about. Whether your secrets come from `.env` files in development or HashiCorp Vault in production, your service code stays the same.

---

[Previous: Interceptors ←](./08-interceptors.md) | [Next: Data Mapping →](./10-data-mapping.md)
