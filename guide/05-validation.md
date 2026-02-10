# Chapter 5: Validation

Validation is one of the most important aspects of any web API. Malformed input leads to bugs, security vulnerabilities, and cryptic error messages. OriJS uses [TypeBox](https://github.com/sinclairzx81/typebox) for validation, which provides JSON Schema-compatible validation with full TypeScript type inference.

## Why TypeBox?

Before diving into OriJS's validation system, it's worth understanding why TypeBox was chosen over alternatives like Zod, Yup, or class-validator.

**TypeBox vs Zod:**

Zod is the most popular TypeScript validation library, and for good reason — its API is elegant and its type inference is excellent. But TypeBox has several advantages for a framework like OriJS:

1. **JSON Schema output.** TypeBox schemas are valid JSON Schema objects. This means you can use them for OpenAPI documentation, client-side validation, and database constraints without conversion. Zod schemas are proprietary and require separate tools to generate JSON Schema.

2. **Performance.** TypeBox compiles schemas to optimized validation functions. In benchmarks, TypeBox validates 2-10x faster than Zod, depending on schema complexity. For an API framework that validates every request, this matters.

3. **Smaller footprint.** TypeBox is a single dependency with no transitive dependencies. Zod's chained builder pattern creates larger bundles.

**TypeBox vs class-validator (NestJS default):**

class-validator uses decorators on class properties, which has the same problems as NestJS's decorator-based DI:

```typescript
// class-validator — decorators on properties
class CreateUserDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsEmail()
  email: string;
}

// TypeBox — JSON Schema with type inference
const CreateUserBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ format: 'email' }),
});
// TypeScript type is automatically: { name: string; email: string }
```

TypeBox gives you the same type safety without decorators, and the schema itself is a plain JavaScript object that can be inspected, composed, and serialized.

## Basic Types

TypeBox provides type constructors that mirror TypeScript types:

```typescript
import { Type } from '@orijs/validation';

// Primitives
Type.String()                           // string
Type.Number()                           // number
Type.Integer()                          // number (integer)
Type.Boolean()                          // boolean
Type.Null()                             // null

// With constraints
Type.String({ minLength: 1, maxLength: 100 })
Type.Number({ minimum: 0, maximum: 100 })
Type.Integer({ minimum: 1 })

// String formats
Type.String({ format: 'email' })
Type.String({ format: 'uuid' })
Type.String({ format: 'uri' })
Type.String({ format: 'date-time' })

// Enums via unions
Type.Union([
  Type.Literal('active'),
  Type.Literal('inactive'),
  Type.Literal('pending'),
])

// Arrays
Type.Array(Type.String())               // string[]
Type.Array(Type.Number(), { minItems: 1, maxItems: 10 })

// Objects
Type.Object({
  name: Type.String(),
  age: Type.Integer(),
  email: Type.Optional(Type.String()),  // Optional property
})
```

Every TypeBox schema carries its TypeScript type. You can extract it with `Static<typeof schema>`:

```typescript
import type { Static } from '@orijs/validation';

const UserSchema = Type.Object({
  name: Type.String(),
  email: Type.String({ format: 'email' }),
  role: Type.Union([Type.Literal('admin'), Type.Literal('member')]),
});

type User = Static<typeof UserSchema>;
// type User = { name: string; email: string; role: 'admin' | 'member' }
```

## Route Validation

Apply validation to routes using the `.validate()` method:

```typescript
class UserController implements OriController {
  configure(r: RouteBuilder) {
    r.post('/users')
      .validate({ body: CreateUserBody })
      .handle(this.createUser);

    r.get('/users/:id')
      .validate({ params: UserIdParams })
      .handle(this.getUser);

    r.get('/users')
      .validate({ query: ListUsersQuery })
      .handle(this.listUsers);

    // Validate multiple sources at once
    r.put('/users/:id')
      .validate({
        params: UserIdParams,
        body: UpdateUserBody,
        query: UpdateOptionsQuery,
      })
      .handle(this.updateUser);
  }
}
```

The `.validate()` method accepts schemas for three sources:

| Source | Description | Example |
|--------|-------------|---------|
| `body` | JSON request body | `{ body: CreateUserBody }` |
| `params` | URL path parameters | `{ params: Type.Object({ id: Type.String() }) }` |
| `query` | URL query parameters | `{ query: Type.Object({ page: Type.Integer() }) }` |

When validation fails, OriJS returns a `400 Bad Request` response with detailed error information:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [
    {
      "path": "/name",
      "message": "Expected string length >= 1"
    },
    {
      "path": "/email",
      "message": "Expected string to match 'email' format"
    }
  ]
}
```

## Parameter Helpers

OriJS provides convenience helpers for common parameter patterns:

```typescript
import { Params, Query } from '@orijs/validation';

// UUID parameters
const UserParams = Type.Object({
  userId: Params.uuid(),
});
// Validates that userId matches UUID format

// Pagination query parameters
const PaginationQuery = Type.Object({
  ...Query.pagination(),
  // Adds: page (integer, default 1), limit (integer, default 20)
});

// Integer query parameters (with string-to-number coercion)
const FilterQuery = Type.Object({
  minAge: Query.integer({ minimum: 0 }),
  maxAge: Query.integer({ maximum: 150 }),
});
```

`Query.integer()` and `Query.number()` are particularly important because URL query parameters are always strings. These helpers automatically coerce `"42"` to `42` during validation, so your handler receives the correct type.

Without this coercion:
```typescript
// Without coercion
r.get('/users').handle(async (ctx) => {
  const page = ctx.query.page;  // "2" (string!)
  const offset = (page - 1) * 20;  // NaN — "2" - 1 is NaN in string context
});

// With Query.integer() coercion
r.get('/users')
  .validate({ query: Type.Object({ page: Query.integer() }) })
  .handle(async (ctx) => {
    const page = ctx.query.page;  // 2 (number!)
    const offset = (page - 1) * 20;  // 20 — correct
  });
```

## Composing Schemas

TypeBox schemas are composable. You can build complex schemas from smaller pieces:

```typescript
// Base types
const Address = Type.Object({
  street: Type.String(),
  city: Type.String(),
  state: Type.String({ minLength: 2, maxLength: 2 }),
  zip: Type.String({ pattern: '^\\d{5}(-\\d{4})?$' }),
});

const ContactInfo = Type.Object({
  email: Type.String({ format: 'email' }),
  phone: Type.Optional(Type.String()),
});

// Composed type
const CreateCustomerBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  address: Address,
  contact: ContactInfo,
  notes: Type.Optional(Type.String()),
});

// Intersect for extending
const CustomerWithId = Type.Intersect([
  Type.Object({ id: Type.String({ format: 'uuid' }) }),
  CreateCustomerBody,
]);
```

### Discriminated Unions

For APIs that accept different shapes based on a discriminator field:

```typescript
const HttpMonitorConfig = Type.Object({
  type: Type.Literal('http'),
  url: Type.String({ format: 'uri' }),
  method: Type.Union([Type.Literal('GET'), Type.Literal('POST')]),
  timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000 })),
});

const TcpMonitorConfig = Type.Object({
  type: Type.Literal('tcp'),
  host: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
});

const DnsMonitorConfig = Type.Object({
  type: Type.Literal('dns'),
  hostname: Type.String(),
  recordType: Type.Union([Type.Literal('A'), Type.Literal('AAAA'), Type.Literal('CNAME')]),
});

const CreateMonitorBody = Type.Union([
  HttpMonitorConfig,
  TcpMonitorConfig,
  DnsMonitorConfig,
]);

// TypeScript narrows the type based on the discriminator
private createMonitor = async (ctx: RequestContext) => {
  const config = ctx.body;
  switch (config.type) {
    case 'http':
      // config is typed as HttpMonitorConfig
      return this.monitorService.createHttp(config.url, config.method);
    case 'tcp':
      // config is typed as TcpMonitorConfig
      return this.monitorService.createTcp(config.host, config.port);
    case 'dns':
      // config is typed as DnsMonitorConfig
      return this.monitorService.createDns(config.hostname, config.recordType);
  }
};
```

## Manual Validation

Sometimes you need to validate data outside of the route handler context — in a service, a queue consumer, or a test. Use the `validate` function directly:

```typescript
import { validate, Type } from '@orijs/validation';

const EmailSchema = Type.String({ format: 'email' });

const result = validate(EmailSchema, 'user@example.com');
if (result.success) {
  console.log('Valid email:', result.data);
} else {
  console.log('Invalid:', result.errors);
}
```

Or use `assertValid` for a throw-on-failure pattern:

```typescript
import { assertValid, Type } from '@orijs/validation';

function processEmail(input: unknown) {
  const email = assertValid(EmailSchema, input);
  // If we reach here, email is a valid string
  sendEmail(email);
}
```

## Safe JSON Parsing

OriJS's validation layer includes **prototype pollution protection** when parsing JSON. This prevents attacks where malicious payloads attempt to modify JavaScript's object prototype:

```json
{
  "__proto__": { "isAdmin": true },
  "name": "attacker"
}
```

The safe JSON parser strips `__proto__`, `constructor`, and `prototype` keys from parsed objects. This protection is applied automatically to all validated request bodies — you don't need to do anything to enable it.

## Custom Validators

For validation logic that can't be expressed as a TypeBox schema, use custom validators:

```typescript
import { Type, FormatRegistry } from '@orijs/validation';

// Register a custom format
FormatRegistry.Set('slug', (value: string) => {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
});

// Use it in schemas
const CreateProjectBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  slug: Type.String({ format: 'slug' }),  // Uses custom validator
});
```

For validators that depend on other request data (like checking that an end date is after a start date), implement the logic in your handler or service rather than in the schema. TypeBox schemas validate individual values, not relationships between values.

## Transform Types

TypeBox supports transform types for preprocessing input before validation:

```typescript
import { Type } from '@orijs/validation';

// Trim whitespace from strings
const TrimmedString = Type.Transform(Type.String())
  .Decode((value) => value.trim())
  .Encode((value) => value);

// Lowercase email addresses
const NormalizedEmail = Type.Transform(Type.String({ format: 'email' }))
  .Decode((value) => value.toLowerCase().trim())
  .Encode((value) => value);

const CreateUserBody = Type.Object({
  name: TrimmedString,
  email: NormalizedEmail,
});

// Input: { name: "  Alice  ", email: "ALICE@Example.COM" }
// After validation: { name: "Alice", email: "alice@example.com" }
```

Transform types are powerful for normalizing input, but use them judiciously. If the transformation is business logic (like calculating a derived field), it belongs in your service layer, not in the schema.

## Summary

OriJS's validation system provides:

1. **TypeBox schemas** for type-safe validation with JSON Schema compatibility
2. **Route-level validation** for body, params, and query with automatic type inference
3. **Parameter helpers** (`Params.uuid()`, `Query.integer()`, `Query.pagination()`) for common patterns
4. **Composable schemas** that can be built from smaller pieces
5. **Safe JSON parsing** with prototype pollution protection
6. **Manual validation** for use outside of HTTP context
7. **Transform types** for input normalization

The key advantage over decorator-based validation (class-validator) is that schemas are plain objects — they can be composed, serialized, and used for documentation without any framework coupling.

[Previous: Controllers & Routing ←](./04-controllers-and-routing.md) | [Next: Guards & Authentication →](./06-guards-and-authentication.md)
