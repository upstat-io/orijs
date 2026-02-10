# Chapter 10: Data Mapping

[Previous: Configuration ←](./09-configuration.md) | [Next: Events →](./11-events.md)

---

SQL gives you flat rows. TypeScript wants nested objects. Every application that touches a database has to bridge this gap, and how you bridge it determines whether your data layer is a joy or a nightmare.

ORMs solve this by hiding SQL entirely -- you write method chains and hope the generated queries are efficient. OriJS takes a different approach: **you write the SQL, the mapper handles the shape**. The `@orijs/mapper` package maps flat SQL result rows to typed TypeScript objects, handling column naming, type coercion, JOINs, JSON columns, and embedded objects -- without generating a single query.

## The Problem: Flat Rows vs. Nested Objects

When you run a SQL query with JOINs, you get flat rows:

```
uuid       | email           | display_name | account_uuid | account_name | created_at
-----------+-----------------+--------------+--------------+--------------+-----------
usr-123    | alice@test.com  | Alice        | acc-456      | Acme Corp    | 2024-01-15
```

But your TypeScript code wants:

```typescript
interface UserWithAccount {
  uuid: string;
  email: string;
  displayName: string;
  account: {
    uuid: string;
    name: string;
  };
  createdAt: Date;
}
```

The mapping seems trivial for one entity, but in a real application you have dozens of entities, each with different JOINs, nullable relations, JSON columns, and computed fields. Without a systematic approach, you end up writing repetitive, error-prone mapping code in every query function.

## Defining Tables

Everything starts with `Mapper.defineTables()` (or `Mapper.defineTable()` for a single table). You describe your database schema using the `field()` builder:

```typescript
import { Mapper, field } from '@orijs/mapper';

const Tables = Mapper.defineTables({
  User: {
    tableName: 'user',
    uuid: field('uuid').string(),
    email: field('email').string(),
    displayName: field('display_name').string().optional(),
    isActive: field('is_active').boolean().default(true),
    createdAt: field('created_at').date(),
  },
  Account: {
    tableName: 'account',
    uuid: field('uuid').string(),
    name: field('name').string(),
    logoUrl: field('logo_url').string().optional(),
    createdAt: field('created_at').date(),
  },
  Project: {
    tableName: 'project',
    uuid: field('uuid').string(),
    accountUuid: field('account_uuid').string(),
    name: field('name').string(),
    slug: field('slug').string(),
    isArchived: field('is_archived').boolean().default(false),
    createdAt: field('created_at').date(),
  },
});
```

### What `field()` Does

Each `field()` call creates a mapping between a TypeScript property name (the object key) and a SQL column name (the `field()` argument):

```typescript
displayName: field('display_name').string()
//  ^                ^               ^
//  |                |               |
//  property name    column name     type + modifiers
```

The first argument to `field()` is always the database column name in `snake_case`. The property name is the object key in `camelCase`. The mapper handles the translation automatically.

### Field Types

| Method | TypeScript Type | SQL Types |
|--------|----------------|-----------|
| `.string()` | `string` | `varchar`, `text`, `uuid`, `char` |
| `.number()` | `number` | `integer`, `bigint`, `decimal`, `float`, `numeric` |
| `.boolean()` | `boolean` | `boolean`, `smallint` (0/1) |
| `.date()` | `Date` | `timestamp`, `timestamptz`, `date` |
| `.any<T>()` | `T` | `jsonb`, `json`, arrays, or any complex type |

Each type includes **automatic coercion**. If your database driver returns a `bigint` as a string (common with PostgreSQL), the `.number()` type coerces it to a JavaScript number. If a boolean comes back as `0` or `1`, it becomes `true` or `false`. Dates from string representations are parsed into `Date` objects.

### Field Modifiers

```typescript
// Optional: value can be null/undefined, maps to undefined in TypeScript
email: field('email').string().optional()

// Default: use this value when the column is null
isActive: field('is_active').boolean().default(true)

// Nullable: explicitly null (for foreign keys that can be null)
parentId: field('parent_id').string().nullable().default(null)
```

The distinction between `.optional()` and `.nullable()` matters:

- `.optional()` maps `NULL` to `undefined` -- the property may not exist
- `.nullable()` preserves `null` -- the property exists but its value is null
- `.default(value)` replaces `NULL` with the specified default value

### Table Metadata

The result of `defineTables()` is a frozen object where each table has:

```typescript
Tables.User.$name;       // 'user' (the SQL table name)
Tables.User.$fields;     // { uuid: { column: 'uuid', type: 'string', ... }, ... }
Tables.User.displayName; // 'display_name' (the SQL column name)
Tables.User.uuid;        // 'uuid'
```

The direct column name access (`Tables.User.displayName` returning `'display_name'`) is useful when building SQL queries -- you reference columns by their property names, and the table definition provides the actual column names:

```typescript
// In your SQL queries, reference columns via the table definition
const sql = `
  SELECT ${Tables.User.uuid}, ${Tables.User.email}, ${Tables.User.displayName}
  FROM ${Tables.User.$name}
  WHERE ${Tables.User.isActive} = true
`;
```

## Creating Mappers

Once you've defined your tables, create mappers with `Mapper.for<T>()`:

```typescript
interface User {
  uuid: string;
  email: string;
  displayName?: string;
  isActive: boolean;
  createdAt: Date;
}

const UserMapper = Mapper.for<User>(Tables.User).build();
```

The generic type parameter `<User>` tells TypeScript what shape the mapped result should have. The mapper uses the table's field definitions to know which columns to read and how to coerce them.

### Mapping a Single Row

```typescript
const row = await db.query('SELECT * FROM "user" WHERE uuid = $1', [userId]);

const result = UserMapper.map(row[0]);
// Returns MapResult<User>

const user = result.value();
// User | undefined

const userOrNull = result.default(null);
// User | null
```

`map()` returns a `MapResult<T>`, not the object directly. This fluent wrapper lets you handle missing rows cleanly without null checks everywhere.

### MapResult API

```typescript
interface MapResult<T> {
  /** Get the raw result, or undefined if the row was null */
  value(): T | undefined;

  /** Get the result, or a default value if undefined */
  default<D>(defaultValue: D): T | D;

  /** Conditionally merge extra fields (for computed properties) */
  mergeWhen(condition: boolean, extra: Partial<T> | undefined): MapResult<T>;
}
```

The `mergeWhen()` method is useful when you need to conditionally add properties:

```typescript
const user = UserMapper.map(row)
  .mergeWhen(includeStats, { postCount: row.post_count })
  .default(null);
```

### Mapping Multiple Rows

```typescript
const rows = await db.query('SELECT * FROM "user" WHERE is_active = true');

const users = UserMapper.mapMany(rows);
// User[] -- automatically filters out null/undefined results
```

`mapMany()` maps each row and filters out any that produce `undefined` (e.g., entirely null rows from LEFT JOINs).

## Selective Mapping with Field Selection

Sometimes you only need a subset of fields. Instead of defining a separate table, use field selection:

```typescript
interface BasicUser {
  uuid: string;
  displayName?: string;
  email: string;
}

// Only map these three fields from the User table
const BasicUserMapper = Mapper.for<BasicUser>(Tables.User, 'uuid', 'displayName', 'email').build();
```

This is the equivalent of `SELECT uuid, display_name, email FROM user` -- you're telling the mapper which properties to include from the full table definition.

## JOIN Mapping with `pick()` -- The Real Power

JOINs are where the mapper earns its keep. When you JOIN two tables, SQL flattens the result into one row. The mapper's `pick()` method pulls fields from a joined table, using a column prefix to disambiguate:

```typescript
interface UserWithAccount {
  uuid: string;
  email: string;
  displayName?: string;
  // Fields from the Account table:
  accountUuid: string;
  accountName: string;
}

const UserWithAccountMapper = Mapper.for<UserWithAccount>(Tables.User)
  .pick(Tables.Account, 'uuid', 'name').prefix('account_')
  .build();
```

The SQL query aliases the joined columns with a prefix:

```sql
SELECT
  u.uuid, u.email, u.display_name,
  a.uuid AS account_uuid,
  a.name AS account_name
FROM "user" u
JOIN account a ON u.account_uuid = a.uuid
WHERE u.uuid = $1
```

When the mapper sees `account_uuid` in the row, it knows to read it as the Account table's `uuid` field (because of the `account_` prefix) and map it to the `accountUuid` property.

### Why Prefixes?

Both `user` and `account` have a `uuid` column. Without prefixes, the mapper wouldn't know which `uuid` belongs to which table. SQL requires aliasing in this case anyway (`a.uuid AS account_uuid`), so the mapper's prefix mechanism mirrors what your SQL already does.

### Multiple JOINs

You can pick from multiple tables:

```typescript
interface MonitorWithDetails {
  uuid: string;
  name: string;
  url: string;
  // From Project table:
  projectName: string;
  projectSlug: string;
  // From Account table:
  accountUuid: string;
  accountName: string;
}

const MonitorDetailMapper = Mapper.for<MonitorWithDetails>(Tables.Monitor)
  .pick(Tables.Project, 'name', 'slug').prefix('project_')
  .pick(Tables.Account, 'uuid', 'name').prefix('account_')
  .build();
```

Each `.pick()` call adds fields from another table with its own prefix. The mapper reads the prefixed columns and maps them to the correct properties.

## Nullable JOINs (LEFT JOIN)

LEFT JOINs produce rows where the joined table's columns are all NULL when there's no match. The mapper handles this with the `embed()` method, which creates a nested object that becomes `undefined` when all its columns are NULL:

```typescript
interface CommentWithUser {
  uuid: string;
  body: string;
  createdAt: Date;
  author?: {  // undefined when LEFT JOIN finds no match
    uuid: string;
    displayName?: string;
    email: string;
  };
}

const CommentWithUserMapper = Mapper.for<CommentWithUser>(Tables.Comment)
  .embed('author', Tables.User).prefix('author_')
  .build();
```

```sql
SELECT
  c.uuid, c.body, c.created_at,
  u.uuid AS author_uuid,
  u.display_name AS author_display_name,
  u.email AS author_email
FROM comment c
LEFT JOIN "user" u ON c.author_uuid = u.uuid
```

When the user doesn't exist (all `author_*` columns are NULL), the mapper sets `author` to `undefined`. When the user exists, it creates a full nested object.

### Embedded Objects Without Prefix

You can also use `embed()` to group flat columns into a nested object:

```typescript
const UsageTable = Mapper.defineTable({
  tableName: 'usage', // virtual -- doesn't need to be a real table
  seats: field('seats_usage').number(),
  products: field('products_usage').number(),
});

interface AccountEntitlement {
  uuid: string;
  plan: string;
  usage: {
    seats: number;
    products: number;
  };
}

const EntitlementMapper = Mapper.for<AccountEntitlement>(Tables.Entitlement)
  .embed('usage', UsageTable) // No prefix -- reads seats_usage, products_usage directly
  .build();
```

## JSON Column Mapping

PostgreSQL's `jsonb` columns are common for aggregated data, metadata, and nested structures. The mapper's `json()` method handles parsing and transformation:

```typescript
interface UserWithRoles {
  uuid: string;
  email: string;
  roles: ProjectRole[];  // From a JSON aggregation
}

interface ProjectRole {
  projectUuid: string;
  role: string;
}

// Simple JSON passthrough
const UserWithRolesMapper = Mapper.for<UserWithRoles>(Tables.User)
  .json<ProjectRole[]>('project_roles').as('roles').default([])
  .build();
```

### JSON with Factory Functions

When the JSON structure doesn't match your TypeScript interface (e.g., the JSON uses `snake_case` but your interface uses `camelCase`), use a factory function:

```typescript
function mapProjectRoles(raw: unknown): ProjectRole[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((r: { project_uuid: string; role: string }) => ({
    projectUuid: r.project_uuid,
    role: r.role,
  }));
}

const UserWithRolesMapper = Mapper.for<UserWithRoles>(Tables.User)
  .json<ProjectRole[]>('project_roles', mapProjectRoles).as('roles').default([])
  .build();
```

### JSON Builder Options

```typescript
// Rename the column to a different property
.json<Tags[]>('tag_data').as('tags')

// Set a default when the column is NULL
.json<Tags[]>('tag_data').as('tags').default([])

// Mark as optional (undefined when NULL)
.json<Metadata>('metadata').optional()

// Chain .as() with .default() or .optional()
.json<Item[]>('items', mapItems).as('lineItems').default([])
```

## Raw Column Mapping with `col()`

For columns that don't belong to any table definition -- aggregated values, computed columns, or ad-hoc aliases -- use `col()`:

```typescript
interface UserProfile {
  uuid: string;
  email: string;
  postCount: number;      // COUNT(*) from a JOIN
  lastLoginAt?: Date;     // From a subquery
  isOnCall: boolean;      // Computed column
}

const UserProfileMapper = Mapper.for<UserProfile>(Tables.User)
  // Column name inferred from property name (camelCase -> snake_case)
  .col<number>('postCount').default(0)       // reads 'post_count' column
  .col<boolean>('isOnCall').default(false)    // reads 'is_on_call' column
  // Explicit column name when it differs from the convention
  .col<Date>('lastLoginAt', 'last_login').optional()
  .build();
```

### Computed Columns

`col()` also accepts a function for derived values:

```typescript
const UserMapper = Mapper.for<UserView>(Tables.User)
  .col<string>('fullName', (row) => {
    const first = row.first_name as string;
    const last = row.last_name as string;
    return `${first} ${last}`;
  })
  .build();
```

## Field Renaming

When you need to map a table field to a different property name:

```typescript
interface UserDto {
  userId: string;   // Not 'uuid'
  userEmail: string; // Not 'email'
}

const UserDtoMapper = Mapper.for<UserDto>(Tables.User)
  .field('uuid').as('userId')
  .field('email').as('userEmail')
  .build();
```

The `field().as()` method uses the table's existing field definition (including type coercion) but outputs to a different property name.

## Field Omission

When your target type doesn't include all table fields:

```typescript
interface UserSummary {
  uuid: string;
  displayName?: string;
  // No email, no isActive, no createdAt
}

const UserSummaryMapper = Mapper.for<UserSummary>(Tables.User)
  .omit('email', 'isActive', 'createdAt')
  .build();
```

## Field Transforms

Apply post-processing after type coercion:

```typescript
const AccountMapper = Mapper.for<Account>(Tables.Account)
  // Convert null logoUrl to undefined
  .transform('logoUrl', (v) => v || undefined)
  .build();
```

Transforms run after all other mapping is complete, so the value is already coerced to the correct type.

## Why Not an ORM?

OriJS deliberately does not include an ORM. This is a design decision, not a missing feature.

### SQL is the Source of Truth

ORMs generate SQL from method chains. When the generated SQL is inefficient, you fight the ORM to get the query you want. With raw SQL + mapper, you write exactly the query you need and map the result. No query generation surprises, no N+1 queries hidden behind lazy loading.

### Performance Control

Complex queries with multiple JOINs, CTEs, window functions, and conditional aggregations are straightforward in SQL but awkward or impossible in most ORMs. The mapper doesn't care how complex your query is -- it maps whatever rows come back.

### JOIN Handling

ORMs typically handle JOINs through "relations" that generate separate queries or cartesian products. The mapper's prefix-based approach maps any JOIN result naturally, because the JOIN is explicit in your SQL.

### No Migration Coupling

The mapper doesn't own your schema. It doesn't generate migrations, doesn't require you to define your schema in a framework-specific DSL, and doesn't break when you add a column. Your migration tool is separate from your mapping tool, as it should be.

### When Would You Want an ORM?

If your application is mostly CRUD with simple queries, an ORM saves boilerplate. If you're building dashboards, analytics, or any system with complex queries, the mapper approach gives you full SQL control with type-safe results.

## Real-World Example: Monitor Entity with Joins

Here's a complete example from a monitoring application, showing how multiple mappers compose for different query needs:

```typescript
import { Mapper, field } from '@orijs/mapper';

// Table definitions
const Tables = Mapper.defineTables({
  Monitor: {
    tableName: 'monitor',
    uuid: field('uuid').string(),
    projectUuid: field('project_uuid').string(),
    name: field('name').string(),
    url: field('url').string(),
    method: field('method').string().default('GET'),
    interval: field('interval').number().default(60),
    isActive: field('is_active').boolean().default(true),
    createdAt: field('created_at').date(),
    updatedAt: field('updated_at').date(),
  },
  MonitorStatus: {
    tableName: 'monitor_status',
    monitorUuid: field('monitor_uuid').string(),
    status: field('status').string(),
    responseTime: field('response_time').number().optional(),
    statusCode: field('status_code').number().optional(),
    checkedAt: field('checked_at').date(),
  },
  Project: {
    tableName: 'project',
    uuid: field('uuid').string(),
    name: field('name').string(),
    slug: field('slug').string(),
  },
});

// Simple monitor (basic queries)
interface Monitor {
  uuid: string;
  projectUuid: string;
  name: string;
  url: string;
  method: string;
  interval: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MonitorMapper = Mapper.for<Monitor>(Tables.Monitor).build();

// Monitor with latest status (JOIN)
interface MonitorWithStatus {
  uuid: string;
  name: string;
  url: string;
  isActive: boolean;
  // From MonitorStatus via JOIN:
  currentStatus?: string;
  lastResponseTime?: number;
  lastCheckedAt?: Date;
}

const MonitorWithStatusMapper = Mapper.for<MonitorWithStatus>(Tables.Monitor)
  .omit('projectUuid', 'method', 'interval', 'createdAt', 'updatedAt')
  .pick(Tables.MonitorStatus, 'status', 'responseTime', 'checkedAt').prefix('latest_')
  .field('status').as('currentStatus')       // Wait -- this won't work because 'status' is from pick
  .build();

// Actually, let's use col() for the renamed picked fields:
const MonitorWithStatusMapper2 = Mapper.for<MonitorWithStatus>(Tables.Monitor)
  .omit('projectUuid', 'method', 'interval', 'createdAt', 'updatedAt')
  .col<string>('currentStatus', 'latest_status').optional()
  .col<number>('lastResponseTime', 'latest_response_time').optional()
  .col<Date>('lastCheckedAt', 'latest_checked_at').optional()
  .build();

// Monitor list item with project info and status
interface MonitorListItem {
  uuid: string;
  name: string;
  url: string;
  isActive: boolean;
  projectName: string;
  projectSlug: string;
  currentStatus?: string;
  uptimePercent: number;
}

const MonitorListMapper = Mapper.for<MonitorListItem>(Tables.Monitor)
  .omit('projectUuid', 'method', 'interval', 'createdAt', 'updatedAt')
  .pick(Tables.Project, 'name', 'slug').prefix('project_')
  .col<string>('currentStatus', 'latest_status').optional()
  .col<number>('uptimePercent', 'uptime_pct').default(0)
  .build();

// Usage in a database service
class MonitorDbService {
  async getMonitor(uuid: string): Promise<Monitor | null> {
    const rows = await this.sql`
      SELECT * FROM monitor WHERE uuid = ${uuid}
    `;
    return MonitorMapper.map(rows[0]).default(null);
  }

  async getMonitorWithStatus(uuid: string): Promise<MonitorWithStatus | null> {
    const rows = await this.sql`
      SELECT
        m.uuid, m.name, m.url, m.is_active,
        ms.status AS latest_status,
        ms.response_time AS latest_response_time,
        ms.checked_at AS latest_checked_at
      FROM monitor m
      LEFT JOIN LATERAL (
        SELECT status, response_time, checked_at
        FROM monitor_status
        WHERE monitor_uuid = m.uuid
        ORDER BY checked_at DESC
        LIMIT 1
      ) ms ON true
      WHERE m.uuid = ${uuid}
    `;
    return MonitorWithStatusMapper2.map(rows[0]).default(null);
  }

  async listMonitors(projectUuid: string): Promise<MonitorListItem[]> {
    const rows = await this.sql`
      SELECT
        m.uuid, m.name, m.url, m.is_active,
        p.name AS project_name,
        p.slug AS project_slug,
        ms.status AS latest_status,
        COALESCE(u.uptime_pct, 0) AS uptime_pct
      FROM monitor m
      JOIN project p ON m.project_uuid = p.uuid
      LEFT JOIN LATERAL (
        SELECT status FROM monitor_status
        WHERE monitor_uuid = m.uuid
        ORDER BY checked_at DESC LIMIT 1
      ) ms ON true
      LEFT JOIN LATERAL (
        SELECT (COUNT(*) FILTER (WHERE status = 'up')::float / NULLIF(COUNT(*), 0) * 100) AS uptime_pct
        FROM monitor_status
        WHERE monitor_uuid = m.uuid AND checked_at > NOW() - INTERVAL '24 hours'
      ) u ON true
      WHERE m.project_uuid = ${projectUuid}
      ORDER BY m.name
    `;
    return MonitorListMapper.mapMany(rows);
  }
}
```

This example shows the mapper's strength: each query has its own mapper tailored to its result shape. The SQL is explicit and optimized. The TypeScript types are correct. And adding a new query with a different shape is just a new mapper definition -- no schema changes, no model updates, no migration coupling.

## Summary

The `@orijs/mapper` package solves the impedance mismatch between SQL and TypeScript without hiding SQL behind an abstraction:

- **`field()`** defines column-to-property mappings with type coercion
- **`Mapper.for<T>()`** creates type-safe mappers from table definitions
- **`pick().prefix()`** handles JOINs by reading prefixed columns from other tables
- **`embed().prefix()`** creates nullable nested objects for LEFT JOINs
- **`json()`** parses JSON columns with optional factory functions
- **`col()`** maps raw columns (aggregates, computed values) with defaults
- **`MapResult`** provides fluent null handling with `.value()`, `.default()`, and `.mergeWhen()`

You write SQL. The mapper shapes the result. Both do what they're best at.

---

[Previous: Configuration ←](./09-configuration.md) | [Next: Events →](./11-events.md)
