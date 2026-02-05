# @orijs/config

Configuration management for OriJS with environment variables, validation, and namespacing.

## Installation

```bash
bun add @orijs/config
```

## Quick Start

```typescript
import { EnvConfig } from '@orijs/config';

const config = new EnvConfig();

// Get optional value
const port = await config.get('PORT') ?? '3000';

// Get required value (throws if missing)
const dbUrl = await config.getRequired('DATABASE_URL');

// Load multiple keys
const values = await config.loadKeys(['PORT', 'HOST', 'DATABASE_URL']);
```

## Features

- **Environment Variables** - Easy access to env vars
- **Validation** - TypeBox schema validation for config
- **Namespacing** - Prefix-based config organization
- **Type Safety** - Full TypeScript support

## Validated Config

```typescript
import { ValidatedConfig } from '@orijs/config';
import { Type } from '@orijs/validation';

const ConfigSchema = Type.Object({
  PORT: Type.String(),
  DATABASE_URL: Type.String(),
  LOG_LEVEL: Type.Optional(Type.String())
});

const config = new ValidatedConfig(new EnvConfig(), ConfigSchema);

// Throws if validation fails
const values = await config.loadKeys(['PORT', 'DATABASE_URL', 'LOG_LEVEL']);
// values is typed: { PORT: string; DATABASE_URL: string; LOG_LEVEL?: string }
```

## Namespaced Config

```typescript
import { NamespacedConfig, EnvConfig } from '@orijs/config';

const redisConfig = new NamespacedConfig(new EnvConfig(), 'REDIS_');

// Reads REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
const host = await redisConfig.get('HOST');
const port = await redisConfig.get('PORT');
```

## Application Integration

```typescript
import { Ori } from '@orijs/core';
import { EnvConfig } from '@orijs/config';

Ori.create()
  .config(new EnvConfig())
  .listen(3000);

// Access in services
class MyService {
  constructor(private ctx: AppContext) {}

  async doSomething() {
    const apiKey = await this.ctx.config.getRequired('API_KEY');
  }
}
```

## Documentation

See the [Configuration Guide](../../docs/guides/configuration.md) for more details.

## License

MIT
