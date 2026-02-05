# @orijs/validation

TypeBox-based validation utilities for OriJS. Provides schema validation, type inference, and common validation helpers.

## Installation

```bash
bun add @orijs/validation
```

## Quick Start

```typescript
import { Type, Static, validate } from '@orijs/validation';

// Define a schema
const UserSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ format: 'email' }),
  age: Type.Optional(Type.Number({ minimum: 0 }))
});

// Infer TypeScript type
type User = Static<typeof UserSchema>;

// Validate data
const result = await validate(UserSchema, data);
if (result.success) {
  console.log(result.data); // Type-safe User
} else {
  console.log(result.errors); // Validation errors
}
```

## Features

- **TypeBox Integration** - Full TypeBox support with Static type inference
- **Async Validation** - Support for async validators
- **Route Helpers** - Pre-built schemas for common route parameters

## Route Validation Helpers

### Params

```typescript
import { Params } from '@orijs/validation';

// UUID parameter
r.get('/users/:id', handler, { params: Params.uuid('id') });

// Multiple UUIDs
r.get('/org/:orgId/user/:userId', handler, {
  params: Params.uuid('orgId', 'userId')
});

// String with constraints
r.get('/users/:slug', handler, {
  params: Params.string('slug', { minLength: 1, maxLength: 100 })
});
```

### Query

```typescript
import { Query } from '@orijs/validation';

// Pagination: ?page=1&limit=20
r.get('/users', handler, { query: Query.pagination() });

// With options
r.get('/users', handler, {
  query: Query.pagination({ defaultLimit: 10, maxLimit: 100 })
});

// Search: ?q=term
r.get('/search', handler, { query: Query.search() });
```

## Custom Validation

```typescript
import { Type, Static } from '@orijs/validation';

const CreateUserSchema = Type.Object({
  email: Type.String({ format: 'email' }),
  password: Type.String({ minLength: 8 }),
  confirmPassword: Type.String()
});

// Use with route
r.post('/users', this.create, { body: CreateUserSchema });
```

## Documentation

See the [Validation Guide](../../docs/guides/validation.md) for more details.

## License

MIT
