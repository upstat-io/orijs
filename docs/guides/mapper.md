# Data Mappers

This guide covers the OriJS mapper system for transforming database rows into typed objects. Mappers provide a fluent builder API for defining how SQL query results map to TypeScript types.

> **Related**: [API Reference](./api-reference.md) | [Testing](./testing.md)

---

## Overview

The mapper system solves the impedance mismatch between SQL results and TypeScript objects:

- **Type-safe**: Mappers produce correctly typed objects
- **Coercion**: Automatic type coercion (strings to dates, numbers, etc.)
- **JOINs**: Handle multi-table queries with prefixed columns
- **JSON**: Parse and transform JSON/JSONB columns
- **Defaults**: Handle nulls with defaults or optional properties
- **Computed**: Derive values from row data

```typescript
import { Mapper, field } from '@orijs/mapper';

// Define table schema
const UserTable = Mapper.defineTable({
	tableName: 'user',
	uuid: field('uuid').string(),
	email: field('email').string(),
	displayName: field('display_name').string().optional(),
	createdAt: field('created_at').date()
});

// Build a mapper
const UserMapper = Mapper.for<User>(UserTable).build();

// Map database rows to typed objects
const user = UserMapper.map(row).value(); // User | undefined
const users = UserMapper.mapMany(rows); // User[]
```

---

## Defining Tables

### Basic Table Definition

Use `Mapper.defineTable()` to define table schemas:

```typescript
import { Mapper, field } from '@orijs/mapper';

export const UserTable = Mapper.defineTable({
	tableName: 'user', // SQL table name

	// Fields map property names to columns
	uuid: field('uuid').string(),
	email: field('email').string(),
	displayName: field('display_name').string().optional(),
	isActive: field('is_active').boolean().default(true),
	createdAt: field('created_at').date(),
	updatedAt: field('updated_at').date().optional()
});

// Access column names directly
UserTable.$name; // 'user'
UserTable.uuid; // 'uuid'
UserTable.displayName; // 'display_name'
```

### Multiple Tables

Use `Mapper.defineTables()` for multiple tables:

```typescript
export const Tables = Mapper.defineTables({
	User: {
		tableName: 'user',
		uuid: field('uuid').string(),
		email: field('email').string()
	},

	Project: {
		tableName: 'project',
		uuid: field('uuid').string(),
		name: field('name').string(),
		accountUuid: field('account_uuid').string()
	},

	Account: {
		tableName: 'account',
		uuid: field('uuid').string(),
		displayName: field('display_name').string()
	}
});

// Access
Tables.User.$name; // 'user'
Tables.Project.name; // 'name'
```

### Field Types

```typescript
import { field } from '@orijs/mapper';

// String fields
field('column').string(); // Required string
field('column').string().optional(); // Optional (undefined if null)
field('column').string().nullable(); // Nullable (null if null)
field('column').string().default('default'); // Default value

// Number fields
field('column').number();
field('column').number().optional();
field('column').number().default(0);

// Boolean fields
field('column').boolean();
field('column').boolean().default(false);

// Date fields (auto-coerces strings to Date objects)
field('column').date();
field('column').date().optional();

// Any type (for JSONB, complex objects)
field('metadata').any<Metadata>();
field('metadata').any<Metadata>().optional();
field('metadata').any<Metadata>().default({});
```

### Optional vs Nullable vs Default

Understanding the difference:

```typescript
// Required - throws if null/undefined
field('email').string();

// Optional - returns undefined if null
field('display_name').string().optional();
// Type: string | undefined

// Nullable - preserves SQL null
field('parent_id').string().nullable();
// Type: string | null

// Default - uses value if null
field('is_active').boolean().default(true);
// Type: boolean (never null/undefined)

// Combined - nullable with null default (for FK columns)
field('parent_id').string().nullable().default(null);
// Type: string | null
```

---

## Building Mappers

### Basic Mapper

```typescript
interface User {
	uuid: string;
	email: string;
	displayName?: string;
	createdAt: Date;
}

const UserMapper = Mapper.for<User>(UserTable).build();

// Map single row
const user = UserMapper.map(row).value(); // User | undefined

// Map with default
const user = UserMapper.map(row).default(null); // User | null

// Map multiple rows
const users = UserMapper.mapMany(rows); // User[]
```

### Selecting Specific Fields

Map only certain fields for partial types:

```typescript
interface BasicUser {
	uuid: string;
	displayName?: string;
}

// Only map uuid and displayName
const BasicUserMapper = Mapper.for<BasicUser>(UserTable, 'uuid', 'displayName').build();
```

### Omitting Fields

Exclude fields from the primary table:

```typescript
interface UserWithoutId {
	email: string;
	displayName?: string;
}

const UserInsertMapper = Mapper.for<UserWithoutId>(UserTable).omit('uuid', 'createdAt').build();
```

---

## Fluent API

### Picking Fields from JOINs

When querying with JOINs, pick fields from other tables:

```typescript
// SQL: SELECT u.*, p.name, p.slug FROM user u JOIN project p ON ...

interface UserWithProject {
	uuid: string;
	email: string;
	name: string; // From project table
	slug: string; // From project table
}

const UserWithProjectMapper = Mapper.for<UserWithProject>(UserTable)
	.pick(ProjectTable, 'name', 'slug')
	.build();
```

### Prefixed Columns

When JOINs alias columns with prefixes:

```typescript
// SQL: SELECT u.*, p.name AS project_name, p.slug AS project_slug FROM ...

const UserWithProjectMapper = Mapper.for<UserWithProject>(UserTable)
	.pick(ProjectTable, 'name', 'slug')
	.prefix('project_')
	.build();
```

### JSON/JSONB Columns

Parse and transform JSON columns:

```typescript
interface UserWithRoles {
	uuid: string;
	roles: Role[]; // From JSON aggregation
}

// Basic JSON column
const mapper = Mapper.for<UserWithRoles>(UserTable).json<Role[]>('roles').build();

// With default for null
const mapper = Mapper.for<UserWithRoles>(UserTable).json<Role[]>('roles').default([]).build();

// With factory function (for transformation)
const mapper = Mapper.for<UserWithRoles>(UserTable)
	.json<Role[]>('roles', (raw) => {
		if (!Array.isArray(raw)) return [];
		return raw.map((r) => ({
			name: r.name,
			permissions: r.permissions ?? []
		}));
	})
	.build();

// Optional JSON (returns undefined if null)
const mapper = Mapper.for<UserWithRoles>(UserTable).json<Role[]>('roles').optional().build();

// Rename the property
const mapper = Mapper.for<UserWithPermissions>(UserTable)
	.json<Permission[]>('user_permissions')
	.as('permissions')
	.build();
```

### Raw/Computed Columns

For calculated, aggregated, or derived values:

```typescript
interface UserWithStats {
	uuid: string;
	orderCount: number; // Calculated column
	lastOrderDate?: Date; // Optional calculated
}

// Column name inferred from property (camelCase → snake_case)
const mapper = Mapper.for<UserWithStats>(UserTable)
	.col<number>('orderCount')
	.default(0) // → 'order_count'
	.col<Date>('lastOrderDate')
	.optional() // → 'last_order_date'
	.build();

// Explicit column name
const mapper = Mapper.for<UserWithStats>(UserTable)
	.col<number>('orderCount', 'total_orders')
	.default(0)
	.build();

// Computed from row data
const mapper = Mapper.for<UserWithName>(UserTable)
	.col<string>('fullName', (row) => `${row.first_name} ${row.last_name}`)
	.build();

// Extract from nested JSON
const mapper = Mapper.for<Event>(EventTable)
	.col<string>('title', (row) => (row.payload as any)?.title ?? '')
	.col<string>('description', (row) => (row.payload as any)?.description)
	.build();
```

### Embedded Objects

Nest related table data as sub-objects:

```typescript
interface CommentWithUser {
	uuid: string;
	content: string;
	user: {
		uuid: string;
		displayName: string;
	};
}

// SQL: SELECT c.*, u.uuid AS user_uuid, u.display_name AS user_display_name FROM ...

const mapper = Mapper.for<CommentWithUser>(CommentTable).embed('user', UserTable).prefix('user_').build();
```

### Field Renaming

Rename fields from the primary table:

```typescript
interface UserDto {
	userId: string; // Renamed from 'uuid'
	email: string;
}

const mapper = Mapper.for<UserDto>(UserTable).field('uuid').as('userId').build();
```

### Field Transforms

Transform field values after coercion:

```typescript
const mapper = Mapper.for<Account>(AccountTable)
	// Convert null to undefined
	.transform('logoUrl', (v) => v || undefined)
	// Format dates
	.transform('displayDate', (v) => (v instanceof Date ? v.toISOString() : v))
	.build();
```

---

## MapResult API

The `map()` method returns a `MapResult` for fluent handling:

```typescript
// Get value directly
const user = UserMapper.map(row).value(); // User | undefined

// Provide default for undefined
const user = UserMapper.map(row).default(null); // User | null

// Conditional merge
const user = UserMapper.map(row).mergeWhen(includeStats, { orderCount: stats.count }).default(null);

// Chaining
const user = UserMapper.map(row, { prefix: 'user_' }).mergeWhen(!!extra, extra).default(null);
```

### MapResult Methods

| Method                      | Description                        |
| --------------------------- | ---------------------------------- | --------------------- |
| `.value()`                  | Returns `T                         | undefined`            |
| `.default(d)`               | Returns `T                         | D` (value or default) |
| `.mergeWhen(cond, partial)` | Conditionally merge partial object |

---

## Type Coercion

The mapper automatically coerces values based on field type:

### String Coercion

```typescript
field('name').string()

// Input → Output
'hello' → 'hello'
null → throws (required) or undefined (optional)
123 → '123' (converts to string)
```

### Number Coercion

```typescript
field('count').number()

// Input → Output
42 → 42
'42' → 42 (parses string)
'42.5' → 42.5
null → throws (required) or undefined (optional)
'invalid' → throws (NaN)
```

### Boolean Coercion

```typescript
field('active').boolean()

// Input → Output
true → true
false → false
1 → true
0 → false
'true' → true
'false' → false
null → throws (required) or undefined (optional)
```

### Date Coercion

```typescript
field('created_at').date()

// Input → Output
Date object → Date object
'2024-01-15T10:30:00Z' → Date
1705315800000 → Date (from timestamp)
null → throws (required) or undefined (optional)
```

---

## Working with JOINs

### Example: Multi-Table Query

```typescript
// Define tables
const UserTable = Mapper.defineTable({
	tableName: 'user',
	uuid: field('uuid').string(),
	email: field('email').string(),
	accountUuid: field('account_uuid').string()
});

const AccountTable = Mapper.defineTable({
	tableName: 'account',
	uuid: field('uuid').string(),
	displayName: field('display_name').string(),
	plan: field('plan').string()
});

// Define result type
interface UserWithAccount {
	uuid: string;
	email: string;
	accountUuid: string;
	account: {
		uuid: string;
		displayName: string;
		plan: string;
	};
}

// Build mapper with embedded account
const mapper = Mapper.for<UserWithAccount>(UserTable)
	.embed('account', AccountTable)
	.prefix('account_')
	.build();

// SQL query with aliased columns
const sql = `
  SELECT
    u.uuid,
    u.email,
    u.account_uuid,
    a.uuid AS account_uuid,
    a.display_name AS account_display_name,
    a.plan AS account_plan
  FROM user u
  JOIN account a ON u.account_uuid = a.uuid
  WHERE u.uuid = $1
`;

const rows = await db.query(sql, [userId]);
const user = mapper.map(rows[0]).value();
```

### Example: JSON Aggregation

```typescript
interface UserWithProjects {
	uuid: string;
	email: string;
	projects: ProjectRole[];
}

interface ProjectRole {
	projectUuid: string;
	projectName: string;
	role: string;
}

// Factory to transform snake_case JSON to camelCase
const mapProjectRoles = (raw: unknown): ProjectRole[] => {
	if (!Array.isArray(raw)) return [];
	return raw.map((r) => ({
		projectUuid: r.project_uuid,
		projectName: r.project_name,
		role: r.role
	}));
};

const mapper = Mapper.for<UserWithProjects>(UserTable)
	.json<ProjectRole[]>('project_roles', mapProjectRoles)
	.default([])
	.build();

// SQL with JSON aggregation
const sql = `
  SELECT
    u.*,
    COALESCE(
      json_agg(
        json_build_object(
          'project_uuid', p.uuid,
          'project_name', p.name,
          'role', pm.role
        )
      ) FILTER (WHERE p.uuid IS NOT NULL),
      '[]'
    ) AS project_roles
  FROM user u
  LEFT JOIN project_member pm ON pm.user_uuid = u.uuid
  LEFT JOIN project p ON p.uuid = pm.project_uuid
  WHERE u.uuid = $1
  GROUP BY u.uuid
`;
```

---

## Error Handling

The mapper throws `MapperError` for runtime mapping issues:

```typescript
import { MapperError } from '@orijs/mapper';

try {
	const user = UserMapper.map(row).value();
} catch (error) {
	if (error instanceof MapperError) {
		console.error(`Mapping error in ${error.tableName}.${error.columnName}`);
		console.error(`Expected ${error.expectedType}, got: ${error.actualValue}`);
	}
}
```

### Common Errors

| Error                       | Cause                  | Solution                          |
| --------------------------- | ---------------------- | --------------------------------- |
| `JSON parse failed`         | Invalid JSON string    | Check column data                 |
| `Expected string, got null` | Required field is null | Use `.optional()` or `.default()` |
| `Expected number, got NaN`  | Invalid numeric string | Validate input data               |

---

## Best Practices

### 1. Define Tables Once, Export for Reuse

```typescript
// tables/user.ts
export const UserTable = Mapper.defineTable({
	tableName: 'user',
	uuid: field('uuid').string()
	// ...
});

// mappers/user-mapper.ts
import { UserTable } from '../tables/user';

export const UserMapper = Mapper.for<User>(UserTable).build();
```

### 2. Create Type-Specific Mappers

```typescript
// Different mappers for different use cases
export const UserMapper = Mapper.for<User>(UserTable).build();

export const UserListMapper = Mapper.for<UserListItem>(UserTable, 'uuid', 'email', 'displayName').build();

export const UserWithAccountMapper = Mapper.for<UserWithAccount>(UserTable)
	.embed('account', AccountTable)
	.prefix('account_')
	.build();
```

### 3. Use Factories for Complex JSON Transformation

```typescript
// factories/project-role-factory.ts
export function mapProjectRole(raw: unknown): ProjectRole | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	return {
		projectUuid: String(r.project_uuid ?? ''),
		role: String(r.role ?? 'viewer'),
		permissions: Array.isArray(r.permissions) ? r.permissions : []
	};
}

export function mapProjectRoles(raw: unknown): ProjectRole[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(mapProjectRole).filter((r): r is ProjectRole => r !== null);
}
```

### 4. Handle Optional vs Nullable Correctly

```typescript
// Optional: TypeScript undefined, use for properties that may not exist
field('display_name').string().optional(); // displayName?: string

// Nullable: SQL null, use for nullable FK or when null is meaningful
field('parent_id').string().nullable(); // parentId: string | null

// Default: Never null/undefined, use when you always want a value
field('is_active').boolean().default(true); // isActive: boolean
```

### 5. Use Column Access for Dynamic Queries

```typescript
// Use table column names in queries
const columns = `${UserTable.uuid}, ${UserTable.email}`;
const sql = `SELECT ${columns} FROM ${UserTable.$name} WHERE ...`;

// Useful for building dynamic queries
const sortColumn = UserTable[sortBy]; // 'display_name' for sortBy='displayName'
const sql = `SELECT * FROM user ORDER BY ${sortColumn}`;
```

---

## API Summary

### Mapper Factory

| Method                             | Description             |
| ---------------------------------- | ----------------------- |
| `Mapper.defineTable(def)`          | Define a single table   |
| `Mapper.defineTables(defs)`        | Define multiple tables  |
| `Mapper.for<T>(table, ...fields?)` | Start building a mapper |

### MapperBuilder Methods

| Method                       | Description                    |
| ---------------------------- | ------------------------------ |
| `.build()`                   | Create the BuiltMapper         |
| `.pick(table, ...fields)`    | Pick fields from another table |
| `.json<J>(column, factory?)` | Map JSON column                |
| `.col<C>(property, column?)` | Map raw/computed column        |
| `.embed(key, table)`         | Embed related object           |
| `.omit(...fields)`           | Exclude fields                 |
| `.field(name).as(newName)`   | Rename field                   |
| `.transform(field, fn)`      | Transform field value          |

### Chained Builders

| Method            | On                        | Description      |
| ----------------- | ------------------------- | ---------------- |
| `.prefix(str)`    | PickBuilder, EmbedBuilder | Column prefix    |
| `.default(value)` | JsonBuilder, ColBuilder   | Default value    |
| `.optional()`     | JsonBuilder, ColBuilder   | Return undefined |
| `.as(name)`       | JsonBuilder               | Rename property  |

### Field Builders

| Method                 | Type      |
| ---------------------- | --------- |
| `field(col).string()`  | `string`  |
| `field(col).number()`  | `number`  |
| `field(col).boolean()` | `boolean` |
| `field(col).date()`    | `Date`    |
| `field(col).any<T>()`  | `T`       |

### Field Modifiers

| Modifier          | Effect             |
| ----------------- | ------------------ | ---------- |
| `.optional()`     | `T                 | undefined` |
| `.nullable()`     | `T                 | null`      |
| `.default(value)` | Uses value if null |

---

## Next Steps

- [API Reference](./api-reference.md) - Complete API documentation
- [Testing](./testing.md) - Testing patterns for mappers
