# ADR-004: SQL Interpolation Design

## Status

Accepted (Revised 2026-01-13)

## Context

OriJS needs type-safe SQL queries with Bun's native postgres driver. Goals:

1. Autocomplete for table/column names
2. Compile-time typo detection
3. SQL injection prevention
4. O(1) identifier detection at runtime

## Decision

### D1: Single-Element Array Syntax for Identifiers

Use `${[identifier]}` for SQL identifiers (table/column names) and `${value}` for parameterized values.

```typescript
oriSql`SELECT ${[Tables.User.uuid]} FROM ${[Tables.User.$name]} WHERE id = ${userId}`;
//            ^ identifier                ^ identifier                    ^ value (parameterized)
```

**Rationale:**

- O(1) detection: `Array.isArray(value) && value.length === 1` is constant time
- Visual distinction: Arrays stand out from plain values
- TypeScript inference: Works naturally with `as const` table definitions
- No runtime overhead: No symbol creation, no wrapper objects

**Alternatives Rejected:**

- Symbol markers: Require runtime symbol creation, harder to serialize
- Wrapper objects: `{ __identifier: true, value: 'name' }` - slower type checking
- Tagged template nesting: `sql${identifier('name')}` - harder to read

### D2: Delegate to Bun SQL's Native Identifier Function

Identifiers are passed to Bun's `sql('identifier')` function, NOT inlined into SQL strings.

```typescript
// oriSql internally does:
const convertedValues = values.map((value) => {
	if (isIdentifier(value)) {
		return bunSql(value[0]); // Calls sql('identifier')
	}
	return value;
});
return bunSql(strings, ...convertedValues);
```

**Rationale:**

- Bun's `sql('identifier')` handles reserved word quoting correctly
- PostgreSQL validates identifiers exist (rejects non-existent columns)
- No need for oriSql to maintain reserved word list
- Implementation reduced from ~175 lines to ~50 lines

**Previous Approach (Superseded):**

- D2 originally quoted reserved words inline using a reserved words list
- This created security concerns flagged in code reviews
- The new approach delegates all identifier handling to Bun + PostgreSQL

### D3: Layered Security Through Bun and PostgreSQL

SQL injection is prevented through three layers:

1. **oriSql**: Detects `${[identifier]}` syntax and calls `bunSql('identifier')`
2. **Bun SQL**: Native identifier handling via `sql('identifier')` function
3. **PostgreSQL**: Validates identifier exists; rejects invalid ones

```typescript
// SQL injection attempt:
const malicious = 'id; DROP TABLE users; --';
oriSql`SELECT ${[malicious]} FROM account`;
// Passes through Bun's sql('id; DROP TABLE users; --')
// PostgreSQL rejects: "column 'id; DROP TABLE users; --' does not exist"
```

**Security Model:**

- **Values** (`${value}`) - User input, parameterized by Bun's SQL driver (safe)
- **Identifiers** (`${[name]}`) - Passed to Bun/PostgreSQL for validation

**Best Practice:** Identifiers should come from trusted sources like Table definitions:

```typescript
// SAFE: Identifier from Table definition
oriSql`SELECT ${[Tables.Account.uuid]} FROM ${[Tables.Account.$name]}`;
```

### D4: Match Bun's Return Type

Return `Promise<T> & T` to match Bun's thenable pattern, allowing both `await` and direct property access.

## Consequences

**Positive:**

- Zero-overhead type safety
- Works with existing Table definitions from fluent-mapper
- Clear visual distinction between identifiers and values
- Simple implementation (~50 lines)
- SQL injection protection through Bun + PostgreSQL
- No need to maintain reserved word list

**Negative:**

- Unconventional syntax may surprise developers initially
- Relies on Bun's identifier handling (coupling to Bun runtime)

## Code Review Findings (WON'T FIX)

The following patterns are BY DESIGN based on this ADR:

| Pattern                        | Rationale                            | Decision  |
| ------------------------------ | ------------------------------------ | --------- |
| Single-element array detection | D1: O(1) identifier detection        | WON'T FIX |
| Delegation to bunSql()         | D2: Native identifier handling       | WON'T FIX |
| No allowlist validation        | D3: PostgreSQL validates identifiers | WON'T FIX |

## References

- ADR-001: OriJS Framework Design Decisions
- Bun SQL Documentation: https://bun.sh/docs/api/sql
- PostgreSQL Reserved Words: https://www.postgresql.org/docs/current/sql-keywords-appendix.html
