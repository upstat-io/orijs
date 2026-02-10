# Chapter 8: Configuration

Every application needs configuration — database URLs, API keys, feature flags, timeouts. OriJS provides a structured configuration system that validates your config at startup so you catch missing or invalid values before your application starts serving requests.

## The Problem with `process.env`

The simplest approach to configuration is reading environment variables directly:

```typescript
// The naive approach — scattered process.env reads
class DatabaseService {
  private url = process.env.DATABASE_URL;  // Might be undefined!
  private poolSize = parseInt(process.env.DB_POOL_SIZE || '5');  // String parsing everywhere
}

class EmailService {
  private apiKey = process.env.SENDGRID_API_KEY;  // Typo? You won't know until runtime
  private from = process.env.EMAIL_FROM || 'noreply@example.com';
}
```

Problems with this approach:
1. **No validation at startup.** If `DATABASE_URL` is missing, you won't know until the first database query.
2. **Type unsafety.** All environment variables are `string | undefined`. You manually parse numbers, booleans, and arrays.
3. **Scattered reads.** Configuration is spread across the codebase, making it hard to see what the application needs.
4. **No documentation.** There's no single place that lists all required configuration.

## EnvConfig

The simplest OriJS configuration approach reads and validates environment variables:

```typescript
import { EnvConfig } from '@orijs/config';

const config = EnvConfig.create({
  port: EnvConfig.integer('PORT', { default: 3000 }),
  databaseUrl: EnvConfig.string('DATABASE_URL'),
  redisUrl: EnvConfig.string('REDIS_URL', { default: 'redis://localhost:6379' }),
  logLevel: EnvConfig.string('LOG_LEVEL', { default: 'info' }),
  maxPoolSize: EnvConfig.integer('DB_POOL_SIZE', { default: 10 }),
  enableMetrics: EnvConfig.boolean('ENABLE_METRICS', { default: false }),
});

Ori.create()
  .config(config)
  .listen(config.port);
```

`EnvConfig.create()` reads and validates all environment variables immediately. If a required variable is missing (no `default` specified), it throws an error with a clear message:

```
ConfigError: Missing required environment variable: DATABASE_URL
```

This happens at application startup, not when the first query runs.

### EnvConfig Types

| Method | Env Value | Result |
|--------|-----------|--------|
| `EnvConfig.string('KEY')` | `"hello"` | `"hello"` |
| `EnvConfig.integer('KEY')` | `"42"` | `42` |
| `EnvConfig.boolean('KEY')` | `"true"` / `"1"` / `"yes"` | `true` |
| `EnvConfig.float('KEY')` | `"3.14"` | `3.14` |
| `EnvConfig.json('KEY')` | `'{"a":1}'` | `{ a: 1 }` |

All methods accept an optional `default` value. Without a default, the variable is required.

## ValidatedConfig

For more complex configuration with nested objects and cross-field validation, use `ValidatedConfig` with TypeBox schemas:

```typescript
import { ValidatedConfig } from '@orijs/config';
import { Type } from '@orijs/validation';

const AppConfigSchema = Type.Object({
  server: Type.Object({
    port: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
    host: Type.String({ default: '0.0.0.0' }),
    corsOrigins: Type.Array(Type.String(), { default: ['http://localhost:3000'] }),
  }),
  database: Type.Object({
    url: Type.String(),
    poolSize: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
    ssl: Type.Boolean({ default: false }),
  }),
  redis: Type.Object({
    url: Type.String({ default: 'redis://localhost:6379' }),
    keyPrefix: Type.String({ default: 'myapp:' }),
  }),
  auth: Type.Object({
    jwtSecret: Type.String({ minLength: 32 }),
    tokenExpirySeconds: Type.Integer({ minimum: 60, default: 3600 }),
  }),
});

const config = ValidatedConfig.create(AppConfigSchema, {
  server: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST,
    corsOrigins: process.env.CORS_ORIGINS?.split(','),
  },
  database: {
    url: process.env.DATABASE_URL,
    poolSize: Number(process.env.DB_POOL_SIZE) || undefined,
    ssl: process.env.DB_SSL === 'true',
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    tokenExpirySeconds: Number(process.env.TOKEN_EXPIRY) || undefined,
  },
});
```

`ValidatedConfig.create()` validates the entire configuration object against the TypeBox schema. If validation fails, you get detailed errors:

```
ConfigError: Configuration validation failed:
  - /database/url: Required
  - /auth/jwtSecret: Expected string length >= 32, got 16
```

### Why ValidatedConfig Over EnvConfig?

| Feature | EnvConfig | ValidatedConfig |
|---------|-----------|-----------------|
| Flat key-value pairs | Yes | Yes |
| Nested objects | No | Yes |
| TypeBox schema validation | No | Yes |
| Cross-field validation | No | Yes (via TypeBox) |
| Custom types | No | Yes |
| Complexity | Low | Medium |

Use `EnvConfig` for simple applications with a handful of config values. Use `ValidatedConfig` when you need nested configuration, custom validation, or schema-based documentation.

## Accessing Config in Services

Once config is set on the application, services access it through `AppContext`:

```typescript
class DatabaseService {
  constructor(private ctx: AppContext) {}

  public async connect() {
    const dbUrl = this.ctx.config.get<string>('database.url');
    const poolSize = this.ctx.config.get<number>('database.poolSize');
    // Connect with validated, typed values
  }
}
```

Or inject the config directly as a provider:

```typescript
import { createToken } from '@orijs/core';

interface DatabaseConfig {
  url: string;
  poolSize: number;
  ssl: boolean;
}

const DB_CONFIG = createToken<DatabaseConfig>('DB_CONFIG');

Ori.create()
  .config(config)
  .providerWithToken(DB_CONFIG, {
    useFactory: () => config.database,
  })
  .provider(DatabaseService, [DB_CONFIG])
  .listen(config.server.port);
```

This approach is more explicit — `DatabaseService` declares exactly what configuration it needs, and the DI container provides it.

## Namespaced Config

For large applications with multiple feature areas, namespaced configuration keeps things organized:

```typescript
import { NamespacedConfig } from '@orijs/config';

const config = NamespacedConfig.create({
  database: EnvConfig.create({
    url: EnvConfig.string('DATABASE_URL'),
    poolSize: EnvConfig.integer('DB_POOL_SIZE', { default: 10 }),
  }),
  redis: EnvConfig.create({
    url: EnvConfig.string('REDIS_URL', { default: 'redis://localhost:6379' }),
  }),
  email: EnvConfig.create({
    apiKey: EnvConfig.string('SENDGRID_API_KEY'),
    fromAddress: EnvConfig.string('EMAIL_FROM', { default: 'noreply@example.com' }),
  }),
});
```

Each namespace is an independent `EnvConfig` that validates its own variables. This is useful when different team members own different configuration sections, or when you want to validate config for optional features only when those features are enabled.

## Configuration Best Practices

### 1. Validate Early, Fail Fast

Always validate configuration at startup, not at first use:

```typescript
// Good — fails at startup if DATABASE_URL is missing
const config = EnvConfig.create({
  databaseUrl: EnvConfig.string('DATABASE_URL'),
});

// Bad — fails at first query, possibly minutes after startup
class DatabaseService {
  connect() {
    const url = process.env.DATABASE_URL;  // Might be undefined
  }
}
```

### 2. Use Defaults for Development, Require for Production

```typescript
const config = EnvConfig.create({
  port: EnvConfig.integer('PORT', { default: 3000 }),           // Default ok
  databaseUrl: EnvConfig.string('DATABASE_URL'),                 // Required always
  logLevel: EnvConfig.string('LOG_LEVEL', { default: 'info' }), // Default ok
});
```

### 3. Type Config Values at the Boundary

Don't scatter `parseInt()` and `=== 'true'` checks across your codebase. Parse and validate once, then pass typed values:

```typescript
// Parse once in config
const config = EnvConfig.create({
  maxRetries: EnvConfig.integer('MAX_RETRIES', { default: 3 }),
  enableDebug: EnvConfig.boolean('DEBUG', { default: false }),
});

// Use typed values everywhere else
class RetryService {
  constructor(private maxRetries: number) {}
  // maxRetries is already a number, no parsing needed
}
```

### 4. Don't Read `process.env` in Services

Services should receive configuration through DI, not read environment variables directly:

```typescript
// Bad — service reads env directly
class EmailService {
  private apiKey = process.env.SENDGRID_API_KEY;
}

// Good — service receives config through DI
class EmailService {
  constructor(private config: EmailConfig) {}
}
```

This makes services testable (inject test config), environment-agnostic (works in any environment), and explicit about their requirements.

## Async Configuration

Some configuration needs to be loaded asynchronously — from a remote config service, a secrets manager, or a database. Use async config factories:

```typescript
Ori.create()
  .configAsync(async () => {
    const secrets = await loadFromVault();
    return EnvConfig.create({
      databaseUrl: EnvConfig.string('DATABASE_URL', { default: secrets.databaseUrl }),
      jwtSecret: EnvConfig.string('JWT_SECRET', { default: secrets.jwtSecret }),
    });
  })
  .listen(3000);
```

The async config factory runs before the bootstrap phase, ensuring all configuration is available when providers are instantiated.

[Previous: Interceptors ←](./07-interceptors.md) | [Next: Data Mapping →](./09-data-mapping.md)
