# Chapter 6: Validation

[Previous: Controllers & Routing &larr;](./05-controllers-and-routing.md)

Validation is not just about rejecting bad input. It is about creating a contract between the client and the server -- a guarantee that when your handler runs, the data it receives has already been verified. In OriJS, validation is a **provider**: the framework ships with a TypeBox-based validation provider, but you can swap it for Zod, Joi, class-validator, or anything else.

This chapter covers how to validate request bodies, path parameters, and query strings. It explains why TypeBox is the default choice, how to compose complex schemas, and how to write your own validation provider if TypeBox is not right for your project.

---

## The Validation Provider

OriJS treats validation as a pluggable concern. The `@orijs/validation` package ships with TypeBox as the default validation provider, but the validation system accepts three kinds of schemas:

1. **TypeBox schemas** -- the default, with JSON Schema compatibility and compile-time type inference
2. **Standard Schema** -- the emerging `~standard` interface supported by Zod, Valibot, and others
3. **Custom validator functions** -- plain async functions that validate and return data

This means the framework is not married to TypeBox. If you prefer Zod, you can use it today through the Standard Schema interface. If you need something entirely custom, you can write a validator function. The framework does not care -- it just needs something that takes unknown data and returns validated data or errors.

---

## Why TypeBox Is the Default

OriJS chose TypeBox as its default validation provider for three reasons:

**JSON Schema compatibility.** TypeBox schemas compile to standard JSON Schema. This means you get OpenAPI documentation for free, you can use JSON Schema validators on the client side, and your schemas are interoperable with any tool that understands JSON Schema. Zod schemas are JavaScript-only -- you cannot send them over the wire.

**Performance.** TypeBox validation is significantly faster than Zod or class-validator. In benchmarks, TypeBox validates approximately 3-5x faster than Zod for complex schemas. For a framework that targets high-throughput APIs, this matters.

**Type inference.** TypeBox provides `Static<typeof schema>` to infer TypeScript types from schemas. You define the schema once and get both runtime validation and compile-time types. No need to maintain a schema and a type separately.

```typescript
import { Type, type Static } from '@orijs/validation';

const UserSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ format: 'email' }),
  age: Type.Integer({ minimum: 0, maximum: 150 })
});

// Inferred type: { name: string; email: string; age: number }
type User = Static<typeof UserSchema>;
```

That said, TypeBox is a provider -- a default that can be swapped. If your team knows Zod or prefers another library, [the section on custom validation providers](#writing-a-custom-validation-provider) shows exactly how to plug in your own.

---

## Basic TypeBox Types

TypeBox mirrors JSON Schema types with a fluent builder API. The `Type` object is re-exported from `@orijs/validation` for convenience.

### Primitive Types

```typescript
import { Type } from '@orijs/validation';

Type.String()                    // string
Type.Number()                    // number (float)
Type.Integer()                   // integer
Type.Boolean()                   // boolean
Type.Null()                      // null
```

### String Constraints

```typescript
Type.String({ minLength: 1 })                     // Non-empty string
Type.String({ maxLength: 255 })                    // Max 255 characters
Type.String({ pattern: '^[a-z]+$' })               // Lowercase only
Type.String({ format: 'email' })                   // Email format
Type.String({ format: 'uri' })                     // URI format
Type.String({ format: 'date-time' })               // ISO 8601 datetime
Type.String({ format: 'uuid' })                    // UUID format
```

### Number Constraints

```typescript
Type.Number({ minimum: 0 })                        // >= 0
Type.Number({ maximum: 100 })                      // <= 100
Type.Number({ exclusiveMinimum: 0 })               // > 0
Type.Integer({ minimum: 1, maximum: 1000 })        // 1-1000 integer
```

### Objects

```typescript
const UserSchema = Type.Object({
  name: Type.String(),
  email: Type.String({ format: 'email' }),
  age: Type.Optional(Type.Integer({ minimum: 0 })),
  role: Type.Union([
    Type.Literal('admin'),
    Type.Literal('member'),
    Type.Literal('viewer')
  ])
});
```

### Arrays

```typescript
Type.Array(Type.String())                           // string[]
Type.Array(Type.Integer(), { minItems: 1 })         // Non-empty integer array
Type.Array(Type.String(), { maxItems: 10 })         // Max 10 strings
Type.Array(Type.String(), { uniqueItems: true })    // No duplicates
```

### Enums and Unions

```typescript
// Literal union (most common for enums)
Type.Union([
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('disabled')
])

// TypeBox Enum (from a TypeScript enum -- not recommended, prefer literal unions)
enum Status { Active = 'active', Paused = 'paused' }
Type.Enum(Status)
```

### Optional and Nullable

```typescript
// Optional: key may be missing entirely
Type.Optional(Type.String())

// Nullable: value may be null
Type.Union([Type.String(), Type.Null()])

// Optional AND nullable
Type.Optional(Type.Union([Type.String(), Type.Null()]))
```

---

## Type Inference with Static

The `Static` type extracts a TypeScript type from a TypeBox schema. This is how you avoid maintaining a schema and a type separately:

```typescript
import { Type, type Static } from '@orijs/validation';

const CreatePostSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ minLength: 1 }),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
  publishAt: Type.Optional(Type.String({ format: 'date-time' }))
});

// This type is inferred automatically:
// { title: string; body: string; tags?: string[]; publishAt?: string }
type CreatePostInput = Static<typeof CreatePostSchema>;
```

You define the schema once. The runtime validator uses it to check incoming data. TypeScript uses it to provide type safety in your handler. One source of truth.

---

## Route Validation

The primary way to use validation in OriJS is through the route schema option. When you define a route with a schema, the framework validates the request before your handler runs. If validation fails, the framework returns a `422 Unprocessable Entity` response and your handler is never called.

```typescript
const CreateUserSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ format: 'email' })
});

const UserParamsSchema = Type.Object({
  uuid: Type.String({ pattern: '^[0-9a-f-]{36}$' })
});

const ListQuerySchema = Type.Object({
  page: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
  limit: Type.Optional(Type.String({ pattern: '^[0-9]+$' }))
});

class UserController implements OriController {
  configure(r: RouteBuilder) {
    // Validate body only
    r.post('/', this.createUser, { body: CreateUserSchema });

    // Validate params only
    r.get('/:uuid', this.getUser, { params: UserParamsSchema });

    // Validate query only
    r.get('/', this.listUsers, { query: ListQuerySchema });

    // Validate all three
    r.put('/:uuid', this.updateUser, {
      params: UserParamsSchema,
      body: CreateUserSchema,
      query: ListQuerySchema
    });
  }
}
```

The schema option accepts three fields:

| Field | Validated Against | Applies To |
|-------|------------------|------------|
| `body` | `await ctx.json()` | POST, PUT, PATCH only |
| `params` | `ctx.params` | All methods |
| `query` | `ctx.query` | All methods |

### Validation Error Response

When validation fails, the response looks like this:

```json
{
  "error": "Validation Error",
  "errors": [
    {
      "path": "body.email",
      "message": "Expected string to match 'email' format",
      "value": "not-an-email"
    },
    {
      "path": "body.name",
      "message": "Expected string length >= 1",
      "value": ""
    }
  ]
}
```

Error paths are dot-notation prefixed with the source (`body.`, `params.`, `query.`), so clients can map errors back to specific form fields.

---

## Parameter Helpers

The `@orijs/validation` package exports `Params` and `Query` helpers that create common validation schemas. These save you from writing the same patterns repeatedly.

### Params Helpers

```typescript
import { Params } from '@orijs/validation';

// Validate UUID path parameters
r.get('/:id', this.getUser, { params: Params.uuid('id') });

// Multiple UUID params
r.get('/:orgId/members/:userId', this.getMember, {
  params: Params.uuid('orgId', 'userId')
});

// String param with constraints
r.get('/:slug', this.getBySlug, {
  params: Params.string('slug', { minLength: 1, maxLength: 100 })
});

// Numeric param
r.get('/:page', this.getPage, {
  params: Params.number('page', { min: 1 })
});
```

### Query Helpers

```typescript
import { Query } from '@orijs/validation';

// Pagination (page + limit with defaults and bounds)
r.get('/', this.listUsers, { query: Query.pagination() });
// Accepts: ?page=2&limit=10
// Defaults: page=1, limit=20, maxLimit=100

// Custom pagination bounds
r.get('/', this.listUsers, {
  query: Query.pagination({ defaultLimit: 50, maxLimit: 200 })
});

// Search
r.get('/search', this.searchUsers, { query: Query.search() });
// Accepts: ?q=alice
// Constraints: 1-100 characters

// Sort
r.get('/', this.listUsers, {
  query: Query.sort({
    allowed: ['createdAt', 'name', 'email'],
    defaultField: 'createdAt',
    defaultOrder: 'desc'
  })
});
// Accepts: ?sortBy=name&order=asc
```

### Why Query.integer() Matters

This is a common gotcha that every web framework has to deal with. Query parameters arrive as strings:

```
GET /users?page=2&limit=10
```

In your handler, `ctx.query.page` is `"2"` (a string), not `2` (a number). If you pass this to a database query expecting an integer, you get a type mismatch at runtime despite TypeScript not complaining (because you told it the type was `number`).

The `Query.pagination()` helper handles this with TypeBox `Transform` types that coerce strings to numbers:

```typescript
// Under the hood, Query.pagination() creates:
Type.Transform(Type.String({ pattern: '^[0-9]+$' }))
  .Decode((v) => {
    const num = parseInt(v, 10);
    return Math.max(1, num);  // Ensure positive
  })
  .Encode((v) => String(v))
```

The `Decode` step runs during validation -- by the time your handler receives the data, the strings have already been converted to numbers and clamped to valid ranges. This is why validation runs before your handler: it is not just checking types, it is normalizing data.

---

## Composing Schemas

Real-world schemas are often built from smaller pieces. TypeBox supports composition through standard schema operations.

### Intersection (Combine Objects)

```typescript
const TimestampFields = Type.Object({
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' })
});

const BaseEntity = Type.Object({
  uuid: Type.String({ format: 'uuid' }),
  accountUuid: Type.String({ format: 'uuid' })
});

// Combine all fields into one schema
const UserEntity = Type.Intersect([
  BaseEntity,
  TimestampFields,
  Type.Object({
    name: Type.String(),
    email: Type.String({ format: 'email' })
  })
]);

// Result: { uuid, accountUuid, createdAt, updatedAt, name, email }
```

### Nested Objects

```typescript
const AddressSchema = Type.Object({
  street: Type.String(),
  city: Type.String(),
  country: Type.String({ minLength: 2, maxLength: 2 }),
  postalCode: Type.String()
});

const CreateCompanySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  address: AddressSchema,
  contacts: Type.Array(Type.Object({
    name: Type.String(),
    email: Type.String({ format: 'email' }),
    role: Type.Optional(Type.String())
  }))
});
```

### Discriminated Unions

Discriminated unions are useful when a field's type depends on another field's value:

```typescript
const HttpMonitor = Type.Object({
  type: Type.Literal('http'),
  url: Type.String({ format: 'uri' }),
  method: Type.Union([Type.Literal('GET'), Type.Literal('POST')]),
  expectedStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 }))
});

const TcpMonitor = Type.Object({
  type: Type.Literal('tcp'),
  host: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65535 })
});

const DnsMonitor = Type.Object({
  type: Type.Literal('dns'),
  hostname: Type.String(),
  recordType: Type.Union([
    Type.Literal('A'),
    Type.Literal('AAAA'),
    Type.Literal('CNAME'),
    Type.Literal('MX')
  ])
});

const CreateMonitorSchema = Type.Union([HttpMonitor, TcpMonitor, DnsMonitor]);
// TypeBox validates the discriminant (type) field and applies the right schema
```

### Partial and Pick

TypeBox provides utility types that mirror TypeScript's built-in utility types:

```typescript
const UserSchema = Type.Object({
  name: Type.String(),
  email: Type.String(),
  role: Type.String()
});

// All fields optional (like TypeScript Partial<User>)
const UpdateUserSchema = Type.Partial(UserSchema);

// Only specific fields (like TypeScript Pick<User, 'name' | 'email'>)
const CreateUserSchema = Type.Pick(UserSchema, ['name', 'email']);

// All fields except some (like TypeScript Omit<User, 'role'>)
const PublicUserSchema = Type.Omit(UserSchema, ['role']);
```

---

## Manual Validation

Sometimes you need to validate data outside of the route schema -- for example, validating event payloads or data from external sources.

### Synchronous Validation (TypeBox Only)

```typescript
import { validateSync, Type } from '@orijs/validation';

const schema = Type.Object({
  name: Type.String(),
  age: Type.Integer({ minimum: 0 })
});

const result = validateSync(schema, { name: 'Alice', age: 30 });

if (result.success) {
  // result.data is typed and validated
  console.log(result.data.name);  // "Alice"
} else {
  // result.errors contains validation errors
  for (const error of result.errors) {
    console.log(`${error.path}: ${error.message}`);
  }
}
```

### Async Validation (Any Schema Type)

```typescript
import { validate, Type } from '@orijs/validation';

// Works with TypeBox
const result1 = await validate(Type.String(), 'hello');

// Works with custom validator functions
const customValidator = async (data: unknown) => {
  if (typeof data !== 'string') throw new Error('Expected string');
  return data.toUpperCase();  // Transform during validation
};
const result2 = await validate(customValidator, 'hello');

// Works with Standard Schema (Zod, Valibot, etc.)
// const result3 = await validate(zodSchema, data);
```

---

## Safe JSON Parsing

OriJS provides a `Json` utility that wraps `JSON.parse` with prototype pollution protection:

```typescript
import { Json } from '@orijs/validation';

// Safe parse - strips __proto__, constructor, prototype keys
const data = Json.parse('{"__proto__": {"admin": true}, "name": "test"}');
// Result: { name: "test" } -- dangerous keys removed

// Standard JSON.parse would keep __proto__ as an own property,
// which becomes dangerous with Object.assign or spread operators

// Stringify (standard, included for symmetry)
const json = Json.stringify({ name: 'test' });

// Sanitize an already-parsed object
const sanitized = Json.sanitize(externalData);
```

You do not need to use `Json.parse` directly in most cases. `ctx.json()` uses it internally. But if you are parsing JSON from other sources (WebSocket messages, event payloads, file contents), use `Json.parse` instead of `JSON.parse`.

**Why does this matter?** Prototype pollution is a class of vulnerability where an attacker injects properties into `Object.prototype` through `__proto__` keys in JSON. If you use `Object.assign` or the spread operator on parsed JSON, those injected properties end up on every object in your process. This has led to real CVEs in Express, Lodash, and other popular libraries.

---

## Custom Validators and FormatRegistry

TypeBox supports custom string formats through `FormatRegistry`:

```typescript
import { Type, Value } from '@orijs/validation';
import { FormatRegistry } from '@sinclair/typebox';

// Register a custom format
FormatRegistry.Set('phone', (value) => {
  return /^\+?[1-9]\d{1,14}$/.test(value);
});

// Use it in schemas
const ContactSchema = Type.Object({
  name: Type.String(),
  phone: Type.String({ format: 'phone' })
});
```

For one-off validation needs, custom validator functions work well:

```typescript
import type { Validator } from '@orijs/validation';

const validateUniqueEmail: Validator<{ email: string }> = async (data) => {
  if (!data || typeof data !== 'object' || !('email' in data)) {
    throw new Error('Expected object with email field');
  }
  const { email } = data as { email: string };

  const exists = await userService.emailExists(email);
  if (exists) {
    throw new Error('Email already registered');
  }

  return { email };
};

// Use in route schema
r.post('/register', this.register, { body: validateUniqueEmail });
```

---

## Transform Types for Input Normalization

TypeBox Transform types let you normalize data during validation. The value is validated first, then decoded (transformed):

```typescript
import { Type } from '@orijs/validation';

// Trim whitespace from strings
const TrimmedString = Type.Transform(Type.String())
  .Decode((v) => v.trim())
  .Encode((v) => v);

// Lowercase email
const EmailField = Type.Transform(Type.String({ format: 'email' }))
  .Decode((v) => v.toLowerCase().trim())
  .Encode((v) => v);

// Parse ISO date string to Date object
const DateField = Type.Transform(Type.String({ format: 'date-time' }))
  .Decode((v) => new Date(v))
  .Encode((v) => v.toISOString());

const CreateUserSchema = Type.Object({
  name: TrimmedString,
  email: EmailField,
  birthDate: Type.Optional(DateField)
});
```

Transforms run after validation succeeds. If the input does not match the base type (e.g., `Type.String()`), the transform never runs and you get a validation error. This means transforms do not need to handle invalid input -- they only receive validated values.

---

## Writing a Custom Validation Provider

This is where the provider architecture pays off. If TypeBox is not right for your team -- maybe you have an existing Zod schema library, or you need a validation library with different error messages -- you can swap out the entire validation layer.

### The Validation Interface

OriJS's validation system accepts three types of schemas through the `Schema` type:

```typescript
// From @orijs/validation
type Schema<T = unknown> = TSchema | StandardSchema<T> | Validator<T>;
```

To integrate a different library, you have three options:

### Option 1: Standard Schema Interface

The easiest approach. If your validation library supports the Standard Schema interface (Zod v4+, Valibot, ArkType), schemas work directly:

```typescript
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email()
});

// Use directly in route schema (if Zod supports ~standard interface)
r.post('/', this.createUser, { body: CreateUserSchema });
```

### Option 2: Validator Function

For any library, you can wrap it in a validator function:

```typescript
import { z } from 'zod';
import type { Validator } from '@orijs/validation';

const zodSchema = z.object({
  name: z.string().min(1),
  email: z.string().email()
});

// Wrap as a validator function
const validateCreateUser: Validator<z.infer<typeof zodSchema>> = (data) => {
  const result = zodSchema.parse(data);  // Throws ZodError on failure
  return result;
};

r.post('/', this.createUser, { body: validateCreateUser });
```

### Option 3: Standard Schema Adapter

Write a reusable adapter that converts any Zod schema into a Standard Schema:

```typescript
import { z } from 'zod';
import type { StandardSchema, StandardSchemaIssue } from '@orijs/validation';

function zodToStandard<T>(schema: z.ZodType<T>): StandardSchema<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'zod',
      validate(value: unknown) {
        const result = schema.safeParse(value);
        if (result.success) {
          return { value: result.data };
        }
        const issues: StandardSchemaIssue[] = result.error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path.map(String)
        }));
        return { issues };
      }
    }
  };
}

// Use like any other schema
const CreateUserSchema = zodToStandard(z.object({
  name: z.string().min(1),
  email: z.string().email()
}));

r.post('/', this.createUser, { body: CreateUserSchema });
```

This adapter is about 15 lines of code. Once written, every Zod schema in your application works with OriJS's validation pipeline. The framework validates request data through the adapter, returns proper error responses, and your handlers receive typed, validated data.

### The Key Insight

The framework does not call TypeBox directly. It calls `validate()`, which dispatches based on the schema type:

```typescript
// Simplified from @orijs/validation
async function validate<T>(schema: Schema<T>, data: unknown): Promise<ValidationResult<T>> {
  if (isValidator(schema))       return validateCustom(schema, data);
  if (isStandardSchema(schema))  return validateStandardSchema(schema, data);
  if (isTypeBoxSchema(schema))   return validateTypeBox(schema, data);
  throw new Error('Unknown schema type');
}
```

This is the provider pattern at the validation level. TypeBox is the default, but any schema that matches one of these interfaces works. The `validate()` function is the contract -- everything upstream (the request pipeline, route validation, manual validation) goes through it.

---

## Best Practices

### Define Schemas Close to Controllers

Schemas are the contract between client and server. Define them near the controller that uses them, not in a distant shared folder:

```typescript
// Good: schema defined right next to the controller
const CreatePostSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String()
});

class PostController implements OriController {
  configure(r: RouteBuilder) {
    r.post('/', this.create, { body: CreatePostSchema });
  }
}
```

### Share Common Patterns, Not Individual Schemas

If multiple controllers need the same pagination or search patterns, use the `Query` and `Params` helpers:

```typescript
// Good: reusable patterns
r.get('/', this.list, { query: Query.pagination() });
r.get('/search', this.search, { query: Query.search() });

// Bad: sharing the specific schema across unrelated controllers
// (couples them unnecessarily)
```

### Keep Schemas Flat Where Possible

Deeply nested schemas are hard to read and produce confusing error paths. Prefer flat schemas with clear field names:

```typescript
// Prefer this
const CreateMonitorSchema = Type.Object({
  name: Type.String(),
  url: Type.String({ format: 'uri' }),
  intervalSeconds: Type.Integer({ minimum: 30 }),
  regionCodes: Type.Array(Type.String())
});

// Over this (unless nesting is genuinely needed)
const CreateMonitorSchema = Type.Object({
  config: Type.Object({
    basic: Type.Object({
      name: Type.String(),
      url: Type.String({ format: 'uri' })
    }),
    schedule: Type.Object({
      interval: Type.Object({
        seconds: Type.Integer({ minimum: 30 })
      })
    })
  })
});
```

### Validate at the Edge

Validate incoming data as early as possible -- at the controller level, not deep in your service layer. Route schemas validate before your handler runs, which means invalid data never reaches your business logic.

---

## Key Takeaways

1. **TypeBox is a provider, not a requirement** -- the validation system accepts TypeBox, Standard Schema, and custom validator functions
2. **Route schemas** validate body, params, and query before your handler runs -- invalid data returns 422 automatically
3. **`Static<typeof schema>`** gives you TypeScript types from TypeBox schemas -- one source of truth for validation and types
4. **Query parameters are strings** -- use `Query.pagination()` and Transform types to coerce them to the right types
5. **`Json.parse`** provides prototype pollution protection -- use it instead of `JSON.parse` for external data
6. **Params helpers** (`Params.uuid()`, `Params.string()`, `Params.number()`) save boilerplate for common parameter patterns
7. **Custom validation providers** can be integrated through Standard Schema adapters or validator functions in about 15 lines of code

---

[Next: Guards & Authentication &rarr;](./07-guards-and-authentication.md)
