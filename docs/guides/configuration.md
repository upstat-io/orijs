# Configuration

OriJS provides a type-safe configuration system using environment variables and TypeBox schema validation.

---

## Overview

The configuration system features:

- **Environment-based** - Read from `process.env` or `.env` files
- **Type-safe** - TypeBox schemas with compile-time types
- **Validation** - Fail fast on invalid or missing config
- **Namespacing** - Organize config by prefix

---

## Basic Setup

### EnvConfig

The simplest configuration provider:

```typescript
import { EnvConfig } from '@orijs/orijs';

const config = new EnvConfig({
	DATABASE_URL: { required: true },
	REDIS_URL: { required: true },
	PORT: { default: '3000' },
	LOG_LEVEL: { default: 'info' }
});

// Get values
const dbUrl = await config.getRequired('DATABASE_URL');
const port = await config.get('PORT'); // Returns string | undefined
```

### Using with Application

```typescript
import { Ori, EnvConfig } from '@orijs/orijs';

const config = new EnvConfig({
	DATABASE_URL: { required: true },
	PORT: { default: '3000' }
});

Ori.create().config(config).provider(MyService, [AppContext]).listen(3000);
```

---

## Validated Configuration

For type-safe configuration with runtime validation, use `ValidatedConfig`:

### Define Schema

```typescript
import { Type, Static } from '@sinclair/typebox';
import { ValidatedConfig, EnvConfig } from '@orijs/orijs';

const ConfigSchema = Type.Object({
	// Required strings
	databaseUrl: Type.String({ format: 'uri' }),
	jwtSecret: Type.String({ minLength: 32 }),

	// Numbers with defaults
	port: Type.Number({ default: 3000 }),
	maxConnections: Type.Number({ default: 10, minimum: 1 }),

	// Enums
	logLevel: Type.Union(
		[Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')],
		{ default: 'info' }
	),

	// Boolean flags
	enableMetrics: Type.Boolean({ default: false }),

	// Optional values
	sentryDsn: Type.Optional(Type.String()),

	// Nested objects
	redis: Type.Object({
		host: Type.String({ default: 'localhost' }),
		port: Type.Number({ default: 6379 }),
		password: Type.Optional(Type.String())
	})
});

type AppConfig = Static<typeof ConfigSchema>;
```

### Create Provider

```typescript
async function createConfigProvider(): Promise<ValidatedConfig<typeof ConfigSchema>> {
	const envConfig = new EnvConfig({
		DATABASE_URL: { required: true },
		JWT_SECRET: { required: true },
		PORT: { default: '3000' },
		MAX_CONNECTIONS: { default: '10' },
		LOG_LEVEL: { default: 'info' },
		ENABLE_METRICS: { default: 'false' },
		SENTRY_DSN: {},
		REDIS_HOST: { default: 'localhost' },
		REDIS_PORT: { default: '6379' },
		REDIS_PASSWORD: {}
	});

	return new ValidatedConfig(envConfig, ConfigSchema);
}
```

### Load and Use

```typescript
// Load all config at startup
const config = await createConfigProvider();
const values = await config.loadKeys(['databaseUrl', 'jwtSecret', 'port', 'logLevel', 'redis']);

// values is typed as AppConfig
console.log(values.port); // number
console.log(values.logLevel); // 'debug' | 'info' | 'warn' | 'error'
console.log(values.redis.host); // string
```

---

## Using Config in Services

### Via AppContext

```typescript
class DatabaseService {
	private connectionString: string = '';

	constructor(private ctx: AppContext) {
		ctx.onStartup(async () => {
			this.connectionString = await ctx.config.getRequired('DATABASE_URL');
			await this.connect();
		});
	}

	private async connect() {
		this.ctx.log.info('Connecting to database');
		// Use this.connectionString
	}
}
```

### Loading Multiple Keys

```typescript
class CacheService {
	private redis!: Redis;

	constructor(private ctx: AppContext) {
		ctx.onStartup(async () => {
			const config = await ctx.config.loadKeys(['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD']);

			this.redis = new Redis({
				host: config.REDIS_HOST,
				port: parseInt(config.REDIS_PORT || '6379'),
				password: config.REDIS_PASSWORD
			});
		});
	}
}
```

---

## Namespaced Configuration

Organize config by prefix:

```typescript
import { NamespacedConfig, EnvConfig } from '@orijs/orijs';

const baseConfig = new EnvConfig({
	DATABASE_URL: { required: true },
	DATABASE_MAX_CONNECTIONS: { default: '10' },
	REDIS_HOST: { default: 'localhost' },
	REDIS_PORT: { default: '6379' }
});

// Create namespaced views
const dbConfig = new NamespacedConfig(baseConfig, 'DATABASE_');
const redisConfig = new NamespacedConfig(baseConfig, 'REDIS_');

// Access without prefix
const dbUrl = await dbConfig.getRequired('URL'); // Reads DATABASE_URL
const redisHost = await redisConfig.get('HOST'); // Reads REDIS_HOST
```

---

## Environment Variable Mapping

### Standard Mapping

```typescript
const envConfig = new EnvConfig({
	// Env var name → config options
	DATABASE_URL: { required: true }, // Must be set
	PORT: { default: '3000' }, // Has default
	DEBUG: {} // Optional, no default
});
```

### TypeBox Schema Mapping

Map environment variables to TypeBox schema fields:

```typescript
// Environment variables
DATABASE_URL=postgresql://localhost/db
JWT_SECRET=super-secret-key-that-is-long-enough
PORT=8080
LOG_LEVEL=debug

// Schema field names (camelCase) map to env vars (SCREAMING_SNAKE_CASE)
const ConfigSchema = Type.Object({
  databaseUrl: Type.String(),   // ← DATABASE_URL
  jwtSecret: Type.String(),     // ← JWT_SECRET
  port: Type.Number(),          // ← PORT
  logLevel: Type.String(),      // ← LOG_LEVEL
});
```

---

## Configuration Patterns

### Feature Flags

```typescript
const ConfigSchema = Type.Object({
	features: Type.Object({
		newDashboard: Type.Boolean({ default: false }),
		betaApi: Type.Boolean({ default: false }),
		experimentalCache: Type.Boolean({ default: false })
	})
});

class FeatureService {
	constructor(private ctx: AppContext) {}

	async isEnabled(feature: string): Promise<boolean> {
		const value = await this.ctx.config.get(`FEATURE_${feature.toUpperCase()}`);
		return value === 'true';
	}
}
```

### Environment-Specific Config

```typescript
const ConfigSchema = Type.Object({
	environment: Type.Union([Type.Literal('development'), Type.Literal('staging'), Type.Literal('production')]),

	// Different defaults by environment
	debug: Type.Boolean({ default: false }),
	logLevel: Type.String({ default: 'info' })
});

// In usage
const config = await loadConfig();

if (config.environment === 'development') {
	// Enable development features
}
```

### Secrets Management

```typescript
class SecretsConfig {
	constructor(private ctx: AppContext) {}

	async getApiKey(): Promise<string> {
		// Try secret manager first, fall back to env var
		const fromSecretManager = await this.fetchFromSecretManager('API_KEY');
		if (fromSecretManager) return fromSecretManager;

		return await this.ctx.config.getRequired('API_KEY');
	}

	private async fetchFromSecretManager(key: string): Promise<string | null> {
		// Integration with AWS Secrets Manager, Vault, etc.
		return null;
	}
}
```

---

## Validation Errors

When validation fails, you get clear error messages:

```typescript
const config = new ValidatedConfig(envConfig, ConfigSchema);

try {
	await config.loadKeys(['databaseUrl', 'port']);
} catch (error) {
	// Error: Configuration validation failed:
	// - databaseUrl: Expected string with format 'uri', received 'not-a-url'
	// - port: Expected number, received 'not-a-number'
}
```

---

## Complete Example

```typescript
import { Type, Static } from '@sinclair/typebox';
import { Ori, EnvConfig, ValidatedConfig, AppContext } from '@orijs/orijs';

// 1. Define schema
const ConfigSchema = Type.Object({
	// Server
	port: Type.Number({ default: 3000 }),
	host: Type.String({ default: '0.0.0.0' }),

	// Database
	databaseUrl: Type.String({ format: 'uri' }),

	// Redis
	redis: Type.Object({
		host: Type.String({ default: 'localhost' }),
		port: Type.Number({ default: 6379 }),
		password: Type.Optional(Type.String())
	}),

	// Auth
	jwtSecret: Type.String({ minLength: 32 }),
	jwtExpiresIn: Type.String({ default: '1h' }),

	// Features
	enableMetrics: Type.Boolean({ default: false }),
	logLevel: Type.Union(
		[Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')],
		{ default: 'info' }
	)
});

type AppConfig = Static<typeof ConfigSchema>;

// 2. Create provider
async function createConfig(): Promise<ValidatedConfig<typeof ConfigSchema>> {
	const env = new EnvConfig({
		PORT: { default: '3000' },
		HOST: { default: '0.0.0.0' },
		DATABASE_URL: { required: true },
		REDIS_HOST: { default: 'localhost' },
		REDIS_PORT: { default: '6379' },
		REDIS_PASSWORD: {},
		JWT_SECRET: { required: true },
		JWT_EXPIRES_IN: { default: '1h' },
		ENABLE_METRICS: { default: 'false' },
		LOG_LEVEL: { default: 'info' }
	});

	return new ValidatedConfig(env, ConfigSchema);
}

// 3. Use in application
async function main() {
	const config = await createConfig();

	// Load and validate config at startup
	const appConfig = await config.loadKeys([
		'port',
		'host',
		'databaseUrl',
		'redis',
		'jwtSecret',
		'jwtExpiresIn',
		'enableMetrics',
		'logLevel'
	]);

	const app = Ori.create()
		.config(config)
		.logger({ level: appConfig.logLevel })
		.provider(DatabaseService, [AppContext])
		.provider(AuthService, [AppContext])
		.controller('/api', ApiController, [AuthService]);

	await app.listen(appConfig.port, () => {
		console.log(`Server running on ${appConfig.host}:${appConfig.port}`);
	});
}

main().catch(console.error);
```

---

## Best Practices

### 1. Validate Early

Load and validate all configuration at startup:

```typescript
const config = await loadConfig();

// Validate all required config before starting
await config.loadKeys(['databaseUrl', 'jwtSecret', 'redisUrl']);

// Now safe to start the application
Ori.create().config(config).listen(3000);
```

### 2. Use Type-Safe Schemas

```typescript
// GOOD - type-safe with validation
const ConfigSchema = Type.Object({
	port: Type.Number({ minimum: 1, maximum: 65535 })
});

// BAD - no validation
const port = parseInt(process.env.PORT || '3000');
```

### 3. Provide Sensible Defaults

```typescript
const ConfigSchema = Type.Object({
	// Development-friendly defaults
	port: Type.Number({ default: 3000 }),
	logLevel: Type.String({ default: 'debug' }),

	// No defaults for secrets (force explicit configuration)
	jwtSecret: Type.String({ minLength: 32 })
});
```

### 4. Document Required Variables

```typescript
// In your README or .env.example:

# Required
DATABASE_URL=postgresql://localhost:5432/myapp
JWT_SECRET=your-32-character-minimum-secret

# Optional with defaults
PORT=3000
LOG_LEVEL=info
REDIS_HOST=localhost
REDIS_PORT=6379
```

---

## Next Steps

- [Logging](./logging.md) - Configure logging levels
- [Testing](./testing.md) - Test configuration handling
