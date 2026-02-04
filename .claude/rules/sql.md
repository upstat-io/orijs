# oriSql Rules

## Basic Pattern

```typescript
import { oriSql } from '@orijs/sql';
import { UserTable } from './tables';

const sql = oriSql`
  SELECT ${[UserTable.id]}, ${[UserTable.email]}, ${[UserTable.name]}
  FROM ${[UserTable]}
  WHERE ${[UserTable.accountId]} = ${accountId}
`;
```

## Syntax

| Type | Syntax | Example |
|------|--------|---------|
| Identifier (column) | `${[Table.column]}` | `${[UserTable.email]}` |
| Identifier (table) | `${[Table]}` | `${[UserTable]}` |
| Value | `${value}` | `${accountId}` |

## Table Definitions

```typescript
import { defineTable } from '@orijs/sql';

export const UserTable = defineTable('users', {
  id: 'id',
  email: 'email',
  name: 'name',
  accountId: 'account_id',
  createdAt: 'created_at'
});
```

## Import Rules

**Always import tables with full names** - No aliases:

```typescript
// CORRECT
import { UserTable } from './tables';
import { AccountTable } from './tables';

// WRONG
import { UserTable as U } from './tables';
```

## Joins

```typescript
const sql = oriSql`
  SELECT
    ${[UserTable.id]},
    ${[UserTable.email]},
    ${[AccountTable.name]} as account_name
  FROM ${[UserTable]}
  JOIN ${[AccountTable]} ON ${[UserTable.accountId]} = ${[AccountTable.id]}
  WHERE ${[AccountTable.id]} = ${accountId}
`;
```

## Arrays

Bun postgres requires special handling for arrays:

```typescript
// For IN clause with array of values
const sql = oriSql`
  SELECT * FROM ${[UserTable]}
  WHERE ${[UserTable.id]} = ANY(${ids}::uuid[])
`;

// For integer arrays
const sql = oriSql`
  WHERE ${[Table.col]} = ANY(ARRAY[${ids.join(',')}]::int[])
`;
```

## JSONB

Pass objects directly - Bun handles serialization:

```typescript
const metadata = { key: 'value', nested: { a: 1 } };

const sql = oriSql`
  INSERT INTO ${[UserTable]} (${[UserTable.metadata]})
  VALUES (${metadata})
`;
```

## Conditional Fragments

```typescript
const conditions: string[] = [];
const values: unknown[] = [];

if (email) {
  conditions.push(oriSql`${[UserTable.email]} = ${email}`);
}

if (name) {
  conditions.push(oriSql`${[UserTable.name]} ILIKE ${`%${name}%`}`);
}

const whereClause = conditions.length > 0
  ? oriSql`WHERE ${conditions.join(' AND ')}`
  : '';
```

## Bun Postgres Connection

```typescript
import { SQL } from 'bun';

const sql = new SQL({
  hostname: 'localhost',
  port: 5432,
  database: 'mydb',
  username: 'user',
  password: 'pass'
});

// Query
const users = await sql`SELECT * FROM users`;

// Close connection (note: .close() not .end())
await sql.close();
```

## Security

- NEVER use string concatenation for values
- ALWAYS use template literal interpolation
- Values are automatically parameterized
- Identifiers are properly escaped
