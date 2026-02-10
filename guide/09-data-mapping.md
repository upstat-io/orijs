# Chapter 9: Data Mapping

When working with SQL databases, there's always a gap between how data is stored (flat rows with snake_case columns) and how your application uses it (nested TypeScript objects with camelCase properties). OriJS's data mapper bridges this gap with a declarative, type-safe system.

## The Problem

Consider a SQL query that joins users with their accounts:

```sql
SELECT
  u.uuid as user_uuid,
  u.first_name,
  u.last_name,
  u.email,
  u.created_at,
  a.uuid as account_uuid,
  a.name as account_name,
  a.plan_type
FROM users u
JOIN accounts a ON u.account_id = a.id
```

The raw result is a flat row:

```typescript
{
  user_uuid: 'abc-123',
  first_name: 'Alice',
  last_name: 'Smith',
  email: 'alice@example.com',
  created_at: '2024-01-15T10:30:00Z',  // String, not Date!
  account_uuid: 'def-456',
  account_name: 'Acme Corp',
  plan_type: 'pro'
}
```

But your application wants:

```typescript
{
  uuid: 'abc-123',
  firstName: 'Alice',
  lastName: 'Smith',
  email: 'alice@example.com',
  createdAt: Date('2024-01-15T10:30:00Z'),  // Date object!
  account: {
    uuid: 'def-456',
    name: 'Acme Corp',
    planType: 'pro'
  }
}
```

Manually writing this transformation for every query is tedious, error-prone, and creates a maintenance burden. OriJS's mapper automates it.

## Defining Tables

Start by defining the table structure:

```typescript
import { Mapper } from '@orijs/mapper';

const UserTable = Mapper.defineTable('users', {
  uuid: Mapper.uuid('uuid'),
  firstName: Mapper.string('first_name'),
  lastName: Mapper.string('last_name'),
  email: Mapper.string('email'),
  createdAt: Mapper.date('created_at'),
  isActive: Mapper.boolean('is_active'),
});
```

Each field maps a **TypeScript property name** (left side) to a **SQL column name** (right side) with a type coercion:

| Mapper Method | SQL Type | TypeScript Type | Coercion |
|---------------|----------|-----------------|----------|
| `Mapper.string('col')` | `varchar`, `text` | `string` | None |
| `Mapper.integer('col')` | `integer`, `bigint` | `number` | `parseInt()` |
| `Mapper.float('col')` | `decimal`, `real` | `number` | `parseFloat()` |
| `Mapper.boolean('col')` | `boolean` | `boolean` | Truthy conversion |
| `Mapper.date('col')` | `timestamp`, `date` | `Date` | `new Date()` |
| `Mapper.uuid('col')` | `uuid` | `string` | None |
| `Mapper.json('col')` | `jsonb`, `json` | `T` | `JSON.parse()` |
| `Mapper.nullable('col', type)` | Any nullable | `T \| null` | Type-specific |

The `Mapper.defineTable()` call returns a table definition that can be used to create mappers.

## Creating Mappers

A mapper transforms SQL rows into TypeScript objects:

```typescript
const userMapper = UserTable.createMapper();

// Use it to map query results
const rows = await sql`SELECT uuid, first_name, last_name, email, created_at, is_active FROM users`;
const users = userMapper.mapRows(rows);
// users is typed as Array<{ uuid: string; firstName: string; lastName: string; email: string; createdAt: Date; isActive: boolean }>
```

### Selective Mapping

You don't always need every column. Use `.pick()` to select specific fields:

```typescript
const userSummaryMapper = UserTable.createMapper()
  .pick('uuid', 'firstName', 'lastName', 'email');

// Result type: Array<{ uuid: string; firstName: string; lastName: string; email: string }>
```

This is useful for list views where you need a subset of the entity's fields.

## JOIN Mapping

The real power of the mapper shows when handling JOINs. Instead of getting flat rows, you get nested objects:

```typescript
const AccountTable = Mapper.defineTable('accounts', {
  uuid: Mapper.uuid('uuid'),
  name: Mapper.string('name'),
  planType: Mapper.string('plan_type'),
  createdAt: Mapper.date('created_at'),
});

// User with joined account
const userWithAccountMapper = UserTable.createMapper()
  .join('account', AccountTable, {
    prefix: 'account_',  // SQL column prefix for the joined table
  });

// SQL query uses column prefixes to disambiguate
const rows = await sql`
  SELECT
    u.uuid, u.first_name, u.last_name, u.email, u.created_at, u.is_active,
    a.uuid as account_uuid,
    a.name as account_name,
    a.plan_type as account_plan_type,
    a.created_at as account_created_at
  FROM users u
  JOIN accounts a ON u.account_id = a.id
`;

const users = userWithAccountMapper.mapRows(rows);
// users[0] = {
//   uuid: 'abc-123',
//   firstName: 'Alice',
//   lastName: 'Smith',
//   email: 'alice@example.com',
//   createdAt: Date,
//   isActive: true,
//   account: {
//     uuid: 'def-456',
//     name: 'Acme Corp',
//     planType: 'pro',
//     createdAt: Date,
//   }
// }
```

The `prefix` option tells the mapper how to find the joined table's columns in the flat SQL result. When you alias columns as `account_uuid`, `account_name`, etc., the mapper strips the prefix and maps them to the nested `account` object.

### Multiple JOINs

You can join multiple tables:

```typescript
const RoleTable = Mapper.defineTable('roles', {
  uuid: Mapper.uuid('uuid'),
  name: Mapper.string('name'),
  permissions: Mapper.json('permissions'),
});

const userWithAccountAndRoleMapper = UserTable.createMapper()
  .join('account', AccountTable, { prefix: 'account_' })
  .join('role', RoleTable, { prefix: 'role_' });

// Result type includes both joins:
// { uuid, firstName, ..., account: { uuid, name, ... }, role: { uuid, name, permissions } }
```

### Nullable JOINs (LEFT JOIN)

For LEFT JOINs where the related record might not exist, use the nullable option:

```typescript
const userWithOptionalAccountMapper = UserTable.createMapper()
  .join('account', AccountTable, { prefix: 'account_', nullable: true });

// account is typed as AccountType | null
```

When all the joined columns are `null` (because the LEFT JOIN didn't match), the mapper returns `null` for the entire nested object instead of an object full of `null` values.

## JSON Column Mapping

PostgreSQL's `jsonb` columns store structured data. The mapper handles serialization:

```typescript
interface MonitorConfig {
  url: string;
  method: string;
  timeout: number;
  headers?: Record<string, string>;
}

const MonitorTable = Mapper.defineTable('monitors', {
  uuid: Mapper.uuid('uuid'),
  name: Mapper.string('name'),
  config: Mapper.json<MonitorConfig>('config'),
  tags: Mapper.json<string[]>('tags'),
});
```

The generic parameter on `Mapper.json<T>()` tells TypeScript the shape of the parsed JSON. The mapper automatically parses JSON strings from the database into JavaScript objects.

## MapResult API

The `mapRows()` method returns a `MapResult` that provides convenience methods:

```typescript
const result = userMapper.mapRows(rows);

// Get all rows
const allUsers = result;  // MapResult extends Array

// Get first row or null
const firstUser = result.first();

// Get first row or throw
const user = result.firstOrThrow('User not found');

// Check if empty
if (result.isEmpty()) {
  // No results
}
```

The `firstOrThrow()` method is particularly useful in repository methods:

```typescript
class UserDbService {
  public async getByUuid(uuid: string): Promise<User> {
    const rows = await sql`SELECT * FROM users WHERE uuid = ${uuid}`;
    return userMapper.mapRows(rows).firstOrThrow(`User not found: ${uuid}`);
  }
}
```

## Embedded Objects

For columns that should be grouped into a sub-object without a JOIN:

```typescript
const UserTable = Mapper.defineTable('users', {
  uuid: Mapper.uuid('uuid'),
  email: Mapper.string('email'),
  // Embedded address from the same table
  address: Mapper.embedded({
    street: Mapper.string('address_street'),
    city: Mapper.string('address_city'),
    state: Mapper.string('address_state'),
    zip: Mapper.string('address_zip'),
  }),
});

// Result: { uuid, email, address: { street, city, state, zip } }
```

Embedded objects are useful when a table has denormalized data (columns that logically belong together) or when you want to match a specific TypeScript interface shape.

## Real-World Example

Here's a complete example of a monitor entity with multiple joins and JSON columns:

```typescript
// Table definitions
const MonitorTable = Mapper.defineTable('monitors', {
  uuid: Mapper.uuid('uuid'),
  name: Mapper.string('name'),
  type: Mapper.string('monitor_type'),
  url: Mapper.string('url'),
  interval: Mapper.integer('check_interval_seconds'),
  config: Mapper.json<MonitorConfig>('config'),
  isActive: Mapper.boolean('is_active'),
  createdAt: Mapper.date('created_at'),
  updatedAt: Mapper.date('updated_at'),
});

const StatusTable = Mapper.defineTable('monitor_status', {
  isUp: Mapper.boolean('is_up'),
  lastCheckedAt: Mapper.date('last_checked_at'),
  responseTimeMs: Mapper.nullable('response_time_ms', Mapper.integer),
  errorMessage: Mapper.nullable('error_message', Mapper.string),
});

const ProjectTable = Mapper.defineTable('projects', {
  uuid: Mapper.uuid('uuid'),
  name: Mapper.string('name'),
});

// Mapper for list view (minimal fields, with current status)
const monitorListMapper = MonitorTable.createMapper()
  .pick('uuid', 'name', 'type', 'url', 'isActive')
  .join('status', StatusTable, { prefix: 'status_', nullable: true })
  .join('project', ProjectTable, { prefix: 'project_' });

// Mapper for detail view (all fields)
const monitorDetailMapper = MonitorTable.createMapper()
  .join('status', StatusTable, { prefix: 'status_', nullable: true })
  .join('project', ProjectTable, { prefix: 'project_' });

// Usage in a db service
class MonitorDbService {
  public async listByProject(projectUuid: string) {
    const rows = await sql`
      SELECT
        m.uuid, m.name, m.monitor_type, m.url, m.is_active,
        ms.is_up as status_is_up,
        ms.last_checked_at as status_last_checked_at,
        ms.response_time_ms as status_response_time_ms,
        ms.error_message as status_error_message,
        p.uuid as project_uuid,
        p.name as project_name
      FROM monitors m
      LEFT JOIN monitor_status ms ON ms.monitor_id = m.id
      JOIN projects p ON p.id = m.project_id
      WHERE p.uuid = ${projectUuid}
      ORDER BY m.name
    `;
    return monitorListMapper.mapRows(rows);
  }
}
```

## Why Not an ORM?

OriJS uses a data mapper instead of an ORM (like Prisma, TypeORM, or Drizzle). This is a deliberate choice:

1. **SQL is the source of truth.** An ORM generates SQL from your model definitions, which means you're debugging SQL you didn't write. With a mapper, you write the SQL and the mapper handles the tedious part (column-to-property mapping and type coercion).

2. **Performance control.** ORMs make it easy to accidentally trigger N+1 queries or load unnecessary relations. With explicit SQL, you control exactly what data is fetched.

3. **JOIN handling.** ORMs typically handle JOINs by making multiple queries or using eager/lazy loading. The mapper handles JOINs in a single query, mapping flat rows to nested objects.

4. **No migration coupling.** ORMs often couple your schema to your migration tool. The mapper works with any SQL schema — you write migrations independently (using any migration tool) and mappers adapt.

The mapper doesn't replace SQL — it complements it. You get the full power of SQL for querying, with type-safe mapping for the results.

[Previous: Configuration ←](./08-configuration.md) | [Next: Events →](./10-events.md)
