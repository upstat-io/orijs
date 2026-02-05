# @orijs/mapper

Fluent mapper framework for OriJS that transforms database rows to typed domain objects.

## Installation

```bash
bun add @orijs/mapper
```

## Quick Start

```typescript
import { Mapper, field } from '@orijs/mapper';

// Define table with column mappings
const Tables = Mapper.defineTables({
  User: {
    tableName: 'users',
    id: field('id').string(),
    email: field('email').string(),
    displayName: field('display_name').string().optional(),
    createdAt: field('created_at').date()
  }
});

// Create mapper
const UserMapper = Mapper.for<User>(Tables.User).build();

// Map database row to typed object
const row = { id: '123', email: 'alice@example.com', display_name: 'Alice', created_at: new Date() };
const user = UserMapper.map(row);
// { id: '123', email: 'alice@example.com', displayName: 'Alice', createdAt: Date }
```

## Features

- **Type-Safe Mapping** - Full TypeScript support with inference
- **Column Renaming** - Map snake_case columns to camelCase properties
- **Type Coercion** - Automatic type conversion (string to number, etc.)
- **Optional Fields** - Handle nullable columns gracefully
- **JSON Fields** - Parse JSON columns automatically

## Field Types

```typescript
// String field
field('column_name').string()

// Number field (coerces strings)
field('price').number()

// Boolean field
field('is_active').boolean()

// Date field
field('created_at').date()

// Optional fields
field('nickname').string().optional()

// Any type (no coercion)
field('metadata').any()
```

## Embedded Objects

```typescript
const Tables = Mapper.defineTables({
  OrderWithUser: {
    tableName: 'orders',
    id: field('id').string(),
    total: field('total').number(),
    // Embed related data with prefix
    user: {
      id: field('user_id').string(),
      email: field('user_email').string()
    }
  }
});

// Maps: { id, total, user: { id, email } }
```

## JSON Fields

```typescript
const Tables = Mapper.defineTables({
  Settings: {
    tableName: 'settings',
    id: field('id').string(),
    preferences: field('preferences').any() // Parsed from JSON
  }
});
```

## Documentation

See the [Mapper Guide](../../docs/guides/mapper.md) for more details.

## License

MIT
