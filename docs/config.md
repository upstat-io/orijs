# @orijs/config

> Technical spec for the configuration package. Source: `packages/config/src/`

## ConfigProvider Interface

Source: `src/types.ts`

The core contract for all configuration sources:

```typescript
interface ConfigProvider {
    get(key: string): Promise<string | undefined>;
    getRequired(key: string): Promise<string>;
    loadKeys(keys: string[]): Promise<Record<string, string | undefined>>;
}
```

| Method | Behavior |
|---|---|
| `get(key)` | Returns the value or `undefined` if not found |
| `getRequired(key)` | Throws if value is `undefined` or empty string |
| `loadKeys(keys)` | Batch loads keys into a key-value record; used for eager caching at startup |

The async interface accommodates remote providers (e.g., Google Secrets Manager, Vault) alongside local environment variables.

---

## EnvConfigProvider

Source: `src/env-config.ts`

Implements `ConfigProvider` by reading from `Bun.env`, which auto-loads:
1. Shell environment variables
2. `.env.local`
3. `.env.{NODE_ENV}` (e.g., `.env.development`)
4. `.env`

```typescript
class EnvConfigProvider implements ConfigProvider
```

All methods are thin wrappers over `Bun.env[key]`:

- `get()` -- returns `Bun.env[key]`
- `getRequired()` -- throws `Error('Required config '${key}' is not set...')` when value is `undefined` or `''`
- `loadKeys()` -- iterates keys, reads each from `Bun.env`

This is the default provider for local development. For production, swap with a cloud provider or wrap with `ValidatedConfig`.

---

## ValidatedConfig

Source: `src/validated-config.ts`

Decorator that wraps any `ConfigProvider` with validation, caching, and key access tracking.

```typescript
class ValidatedConfig implements ConfigProvider {
    constructor(provider: ConfigProvider, logger?: Logger)
}
```

### Configuration API (Fluent Builder)

| Method | Signature | Description |
|---|---|---|
| `expectKeys()` | `(...keys: string[]): this` | Declares keys that must be present. Can be called multiple times; keys accumulate in a `Set`. |
| `onFail()` | `(mode: 'error' \| 'warn'): this` | Sets fail mode. `'error'` throws on missing keys. `'warn'` logs and continues. Default: `'warn'`. |
| `validate()` | `(): Promise<this>` | Checks all expected keys, caches their values, logs results. Must be called before sync access. |

### Validation Flow

`validate()` calls `checkExpectedKeys()` which:
1. Iterates `expectedKeys` set
2. Calls `provider.get(key)` for each
3. Caches the value (including `undefined`) in an internal `Map<string, string | undefined>`
4. Classifies as `missing` if value is `undefined` or `''`

Returns `ConfigValidationResult`:

```typescript
interface ConfigValidationResult {
    valid: boolean;
    missing: string[];
    present: string[];
}
```

Behavior based on `failMode`:
- `'error'` -- logs error message, throws `Error('Missing required config keys: ...')`
- `'warn'` -- logs warning, continues execution

After validation, sets `validated = true` to enable sync access.

### Access Methods

| Method | Async | Requirement | Behavior |
|---|---|---|---|
| `get(key)` | Yes | None | Delegates to wrapped provider, tracks key access |
| `getRequired(key)` | Yes | None | Delegates to wrapped provider (always throws for missing) |
| `getSync(key)` | No | `validate()` called, key in `expectKeys()` | Returns from cache. Throws if preconditions not met. |
| `getRequiredSync(key)` | No | `validate()` called, key in `expectKeys()` | Returns from cache. Throws if missing/empty. |

`getSync()` and `getRequiredSync()` throw specific errors:
- `'Cannot use getSync() before validate() is called'` -- validation not run
- `'Key "${key}" was not in expectedKeys...'` -- key not declared for caching

### Key Access Tracking

Every `get`, `getRequired`, `getSync`, and `getRequiredSync` call registers the key in a `loadedKeys` set. Tracking methods:

- `getLoadedKeys(): string[]` -- returns all accessed keys
- `logLoadedKeys(): void` -- logs accessed key summary via the Logger instance

---

## NamespacedConfigBuilder

Source: `src/namespaced-config.ts`

Multi-provider configuration system with namespace isolation and sync access after validation.

### Factory

```typescript
function createConfigProvider(logger?: Logger): NamespacedConfigBuilder
```

### Builder API

| Method | Signature | Description |
|---|---|---|
| `add()` | `(namespace: string, provider: ConfigProviderInput): this` | Registers a provider under a namespace. Throws if `namespace === 'env'` (reserved). |
| `expectKeys()` | `(keys: Record<string, string[]>): this` | Declares required keys per namespace. Replaces previous declaration. |
| `onFail()` | `(mode: 'error' \| 'warn'): this` | Sets fail mode. Default: `'error'`. |
| `transform()` | `(transformer: ConfigTransformer): this` | Adds a post-validation transformer. Applied in registration order. |
| `validate<T>()` | `(): Promise<T & ConfigProvider>` | Validates, caches, applies transformers, returns typed Proxy. |

### ConfigProviderInput

Providers can be passed in three forms, resolved during `validate()`:

```typescript
type ConfigProviderInput = ConfigProvider | ConfigProviderConstructor | ConfigProviderFactory;

type ConfigProviderConstructor = new () => ConfigProvider;

interface ConfigProviderFactory {
    create(): Promise<ConfigProvider>;
}
```

Resolution order:
1. If `isConfigProviderFactory()` -- has `create()` method: calls `await input.create()`
2. If `isConfigProviderConstructor()` -- is a function: calls `new input()`
3. Otherwise: used as-is (already a `ConfigProvider` instance)

### The `env` Namespace

Always available without registration. Reads directly from `Bun.env` during validation (does not use a provider instance). Cannot be overridden -- `add('env', ...)` throws:

```
Error: Cannot override "env" namespace - it is reserved for environment variables
```

### Validation Flow

1. Load `env` namespace keys from `Bun.env`
2. Verify all namespaces in `expectKeys` have been registered via `add()`; throws if not
3. For each registered provider: resolve provider instance, call `provider.loadKeys(keys)`
4. Classify keys as `missing` (undefined or empty) or `present`
5. Handle validation result per `failMode`
6. Apply transformers in order

### Transformers

```typescript
interface ConfigTransformer<TInput = unknown, TOutput = unknown> {
    readonly property: string;
    readonly transform: (config: TInput) => TOutput;
}
```

Transformers derive new properties from the validated config object. They receive the full config (all namespaces + previously applied transformers) and their return value is set on `result[transformer.property]`.

### Return Value

`validate<T>()` returns a `Proxy` that implements both the typed config interface `T` and `ConfigProvider`:

- Property access (`config.env.PORT`, `config.secrets.KEY`) -- reads from the cached namespace objects
- `config.get(key)` -- searches all namespaces, `secrets` first, then others
- `config.getRequired(key)` -- throws if not found in any namespace
- `config.loadKeys(keys)` -- delegates to `get()` per key
- Unknown namespace access returns `{}` (any property access on it returns `undefined`)

### NamespacedConfigResult

Default type when `T` is not specified:

```typescript
type NamespaceAccessor = Record<string, string | undefined>;

type NamespacedConfigResult = {
    env: NamespaceAccessor;
    [namespace: string]: NamespaceAccessor;
};
```
