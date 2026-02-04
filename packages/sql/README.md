# @orijs/sql

Type-safe SQL template literal wrapper for Bun's native PostgreSQL driver with identifier syntax support.

## Features

- **O(1) Identifier Detection**: Single-element string arrays `${['column']}` are detected as identifiers in constant time
- **Native PostgreSQL Validation**: Identifiers are passed to Bun's `sql('identifier')` function for PostgreSQL-level validation
- **SQL Injection Protection**: Invalid identifiers (including SQL injection attempts) are rejected by PostgreSQL
- **Type-Safe Parameters**: All other values are passed as parameterized queries
- **Zero Dependencies**: Pure TypeScript, works with Bun's built-in `sql` template tag

## Installation

```bash
bun add @orijs/sql
```

## Quick Start

```typescript
import { sql } from 'bun';
import { createOriSql } from '@orijs/sql';

const oriSql = createOriSql(sql);

// Identifiers use single-element array syntax
const tableName = 'account';
const columnName = 'uuid';

// Values are parameterized (safe for user input)
const searchId = 42;

const results = await oriSql`
  SELECT ${[columnName]}
  FROM ${[tableName]}
  WHERE id = ${searchId}
`;
```

## Usage

### Identifiers vs Parameters

```typescript
// IDENTIFIER: ${['name']} - Passed to Bun's sql('name') for safe handling
// Use for: table names, column names, schema names
oriSql`SELECT ${['uuid']} FROM ${['account']}`;

// PARAMETER: ${value} - Parameterized query
// Use for: user input, search values, any dynamic data
oriSql`SELECT * FROM account WHERE id = ${userId}`;
```

### Reserved Word Handling

PostgreSQL reserved words are handled automatically by Bun/PostgreSQL:

```typescript
oriSql`SELECT * FROM ${['user']}`;
// 'user' is passed to Bun's sql('user') which handles quoting

oriSql`SELECT ${['order']}, ${['group']} FROM ${['table']}`;
// All reserved words handled by PostgreSQL
```

### With Table Definitions

Best used with `@orijs/mapper` table definitions:

```typescript
import { Mapper } from '@orijs/mapper';

const Tables = {
	Account: Mapper.defineTable('account', {
		uuid: 'uuid',
		displayName: 'display_name',
		createdAt: 'created_at'
	})
};

// Type-safe column references
oriSql`
  SELECT ${[Tables.Account.uuid]}, ${[Tables.Account.displayName]}
  FROM ${[Tables.Account.$name]}
  WHERE ${[Tables.Account.uuid]} = ${accountUuid}
`;
```

## Security

### Layered Protection

Identifiers pass through multiple validation layers:

1. **oriSql**: Detects `${[identifier]}` syntax and calls `bunSql('identifier')`
2. **Bun SQL**: Native identifier handling via `sql('identifier')` function
3. **PostgreSQL**: Validates identifier exists; rejects invalid ones with "column does not exist"

### SQL Injection Protection

```typescript
// SQL injection attempt via identifier
const malicious = 'id; DROP TABLE users; --';
oriSql`SELECT ${[malicious]} FROM account`;
// PostgreSQL rejects: "column 'id; DROP TABLE users; --' does not exist"

// User input should ALWAYS use parameter syntax
const searchTerm = req.query.search;
oriSql`SELECT * FROM account WHERE name = ${searchTerm}`;
// Safely parameterized
```

### Best Practice

Identifiers should come from trusted sources like Table definitions:

```typescript
// SAFE: Identifier from Table definition
oriSql`SELECT ${[Tables.Account.uuid]} FROM ${[Tables.Account.$name]}`;

// SAFE: Identifier from code constant
const column = 'uuid';
oriSql`SELECT ${[column]} FROM account`;
```

## API Reference

### `createOriSql(sql: BunSqlFunction): OriSqlFactory`

Creates an oriSql template tag function from Bun's sql instance.

```typescript
import { sql } from 'bun';
import { createOriSql } from '@orijs/sql';

const oriSql = createOriSql(sql);
```

### `isIdentifier(value: unknown): value is SqlIdentifier`

Type guard to check if a value is an identifier marker.

```typescript
import { isIdentifier } from '@orijs/sql';

isIdentifier(['column']); // true
isIdentifier(['a', 'b']); // false (multi-element)
isIdentifier('string'); // false (not array)
isIdentifier([123]); // false (not string element)
```

## Types

```typescript
// Identifier marker type
type SqlIdentifier = readonly [string];

// Factory function type
type OriSqlFactory = <T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T> & T;

// Bun SQL function type (both template and identifier modes)
interface BunSqlFunction {
	(strings: TemplateStringsArray, ...values: unknown[]): unknown;
	(identifier: string): unknown;
}
```

## How It Works

When you use `${['identifier']}` syntax:

1. `oriSql` detects the single-element string array
2. Calls `bunSql('identifier')` to get a Bun SQL identifier fragment
3. Passes the fragment (not the raw string) to Bun's template function
4. Bun handles the identifier safely, delegating validation to PostgreSQL

This means oriSql is a thin wrapper that leverages Bun's native identifier support while providing a cleaner syntax.

## Comparison

| Feature               | @orijs/sql    | Raw Bun sql      | pg-format  |
| --------------------- | ------------- | ---------------- | ---------- |
| Parameterized values  | Yes           | Yes              | Yes        |
| Identifier syntax     | `${['name']}` | `${sql('name')}` | Manual     |
| PostgreSQL validation | Yes (via Bun) | Yes              | No         |
| Type safety           | Full          | Partial          | None       |
| O(1) detection        | Yes           | N/A              | No (regex) |

## License

MIT
