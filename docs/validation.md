# @orijs/validation

> Technical spec for the validation package. Source: `packages/validation/src/`

## Schema Types

The validation system supports three schema types, detected via type guards at validation time:

| Schema Type | Type Guard | Detection | Validation Strategy |
|---|---|---|---|
| TypeBox (`TSchema`) | `isTypeBoxSchema()` | Checks for `Kind` symbol in object | `Value.Errors()` + `Value.Decode()` |
| Standard Schema | `isStandardSchema()` | Checks for `~standard` property | Calls `schema['~standard'].validate()` |
| Custom Validator | `isValidator()` | `typeof schema === 'function'` | Invokes function directly |

The union type covering all three:

```typescript
type Schema<T = unknown> = TSchema | StandardSchema<T> | Validator<T>;
```

### TypeBox (TSchema)

Default and primary schema library. Detection uses the `Kind` symbol from `@sinclair/typebox`:

```typescript
function isTypeBoxSchema(schema: unknown): schema is TSchema {
    return typeof schema === 'object' && schema !== null && Kind in (schema as Record<symbol, unknown>);
}
```

TypeBox validation follows a two-step process:
1. `Value.Errors(schema, sanitizedData)` -- collects all validation errors
2. `Value.Decode(schema, sanitizedData)` -- applies defaults and coercion (only when no errors)

Input data is sanitized via `Json.sanitize()` before TypeBox validation as defense-in-depth against prototype pollution, regardless of `additionalProperties` settings.

Re-exports `Type` (also aliased as `t`), `Value`, `Static`, and `TSchema` from `@sinclair/typebox` for convenience.

### Standard Schema

Implements the [Standard Schema](https://github.com/standard-schema/standard-schema) v1 interface for library-agnostic validation:

```typescript
interface StandardSchema<T = unknown> {
    '~standard': {
        version: 1;
        vendor: string;
        validate: (value: unknown) => { value: T } | { issues: StandardSchemaIssue[] };
    };
}

interface StandardSchemaIssue {
    message: string;
    path?: (string | number)[];
}
```

When an issue has a `path` array, it is joined with `.` for the `ValidationError.path` field. Missing paths default to `''`.

### Custom Validators

Any function matching the `Validator<T>` signature:

```typescript
type Validator<T = unknown> = (data: unknown) => T | Promise<T>;
```

The validator function receives raw `unknown` data and either:
- Returns validated/transformed data of type `T`
- Throws an error to fail validation

Errors thrown from custom validators are caught and wrapped into `ValidationError[]` with the error message and an empty path string.

---

## validate() and validateSync()

### validate()

```typescript
async function validate<T>(schema: Schema<T>, data: unknown): Promise<ValidationResult<T>>
```

Dispatches to the appropriate validation strategy based on type guard detection. Detection order:

1. `isValidator(schema)` -- function check (fastest)
2. `isStandardSchema(schema)` -- `~standard` property check
3. `isTypeBoxSchema(schema)` -- `Kind` symbol check
4. Throws `Error('Unknown schema type')` if none match

### validateSync()

```typescript
function validateSync<T>(schema: TSchema, data: unknown): ValidationResult<T>
```

Synchronous-only variant. Throws `Error('validateSync only supports TypeBox schemas')` if the schema is not a TypeBox schema. Used when async validation is unnecessary and the schema type is known.

### ValidationResult

```typescript
type ValidationResult<T> =
    | { success: true; data: T }
    | { success: false; errors: ValidationError[] };

interface ValidationError {
    path: string;
    message: string;
    value?: unknown;
}
```

The `value` field is only populated for TypeBox validation errors (from `Value.Errors` output). Standard Schema and custom validator errors do not include the offending value.

---

## Safe JSON

Source: `src/json.ts`

The `Json` namespace provides prototype pollution protection as a drop-in replacement for `JSON.parse`.

### Json.parse()

```typescript
Json.parse<T = unknown>(text: string, reviver?: (key: string, value: unknown) => unknown): T
```

Calls `JSON.parse()` then applies `sanitize()` to the result. If a `reviver` is provided, it runs before sanitization.

### Json.sanitize()

```typescript
Json.sanitize<T>(obj: T): T
```

Recursively removes dangerous keys from an already-parsed object. Dangerous keys are stored in a `Set` for O(1) lookup:

| Key | Attack Vector |
|---|---|
| `__proto__` | Direct prototype setter |
| `constructor` | Access to `constructor.prototype` |
| `prototype` | Direct prototype property |

Performance characteristics:
- O(n) single-pass traversal where n = total keys across all nested objects
- O(1) per-key lookup via `Set`
- Primitives and `null` return immediately (no allocation)
- Built-in types pass through without sanitization: `Date`, `RegExp`, `Map`, `Set`, `Error`
- Arrays are mapped to new arrays with each element sanitized
- Objects are copied with dangerous keys omitted

### Json.stringify()

```typescript
Json.stringify(value: unknown, replacer?, space?): string
```

Pass-through to `JSON.stringify`. Included for API symmetry; no sanitization needed on the stringify path.

---

## Param Helpers

Source: `src/params.ts`

The `Params` namespace generates TypeBox schemas for URL path parameter validation.

### Params.uuid()

```typescript
Params.uuid(...names: string[]): TSchema
```

Creates a `Type.Object` with each named parameter validated against the RFC 4122 UUID pattern:

```
^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$
```

Accepts variadic names: `Params.uuid('orgId', 'userId')` produces a schema with both parameters.

### Params.string()

```typescript
Params.string(name: string, options?: StringParamOptions): TSchema

interface StringParamOptions {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
}
```

Creates a `Type.Object` with a single string parameter. All options are forwarded to `Type.String()`.

### Params.number()

```typescript
Params.number(name: string, options?: NumberParamOptions): TSchema

interface NumberParamOptions {
    min?: number;
    max?: number;
}
```

Validates that the path parameter is a numeric string. Path params are always strings from the URL, so this validates against a numeric pattern rather than coercing to a number type. If `min > 0`, the pattern changes from `^[0-9]+$` to `^[1-9][0-9]*$` to exclude leading zeros.

Note: `min` and `max` are included in the field description string but are not enforced by the regex pattern itself. The handler is expected to parse and validate the numeric range if needed.

---

## Query Helpers

Source: `src/query.ts`

The `Query` namespace generates TypeBox schemas for query string parameter validation with string-to-type coercion via `Type.Transform`.

### Query.pagination()

```typescript
Query.pagination(options?: PaginationOptions): TObject

interface PaginationOptions {
    defaultPage?: number;    // default: 1
    defaultLimit?: number;   // default: 20
    maxLimit?: number;       // default: 100
    minLimit?: number;       // default: 1
}
```

Produces a schema with `page` and `limit` fields, both optional `Type.Transform` strings:

- `page`: Parsed via `parseInt`, clamped to `Math.max(1, num)`. Default string: `"1"`.
- `limit`: Parsed via `parseInt`, clamped to `Math.min(maxLimit, Math.max(minLimit, num))`. Default string: `"20"`.

Both fields validate against `^[0-9]+$` before coercion.

### Query.search()

```typescript
Query.search(options?: SearchOptions): TObject

interface SearchOptions {
    minLength?: number;  // default: 1
    maxLength?: number;  // default: 100
}
```

Produces a schema with an optional `q` string field constrained by `minLength` and `maxLength`.

### Query.sort()

```typescript
Query.sort(options?: SortOptions): TObject

interface SortOptions {
    allowed?: string[];
    defaultField?: string;
    defaultOrder?: 'asc' | 'desc';  // default: 'asc'
}
```

Produces a schema with:
- `sortBy`: If `allowed` is provided, uses a `Type.Union` of `Type.Literal` values (allowlist enforcement). Otherwise, accepts any `Type.String`.
- `order`: `Type.Union([Type.Literal('asc'), Type.Literal('desc')])` with configurable default.

Both fields are optional.
