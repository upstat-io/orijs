# @orijs/mapper

> Technical spec for the mapper package. Source: `packages/mapper/src/`

## Overview

The mapper provides a fluent API for transforming database rows (snake_case columns) into typed domain objects (camelCase properties). It handles type coercion, null/default resolution, JSON parsing, JOIN column mapping, and embedded object extraction.

Key types flow: `field()` -> `Mapper.defineTables()` -> `Mapper.for<T>()` -> `builder.build()` -> `mapper.map(row)`

---

## Field Definitions

Source: `src/field.ts`, `src/types.ts`

### field() Factory

```typescript
function field(column: string): FieldColumnBuilder
```

Creates a field definition starting with the database column name (mandatory). Returns a `FieldColumnBuilder` that provides type selection:

```typescript
interface FieldColumnBuilder {
    string(): StringFieldBuilder;
    number(): NumberFieldBuilder;
    boolean(): BooleanFieldBuilder;
    date(): DateFieldBuilder;
    any<T = unknown>(): AnyFieldBuilder<T>;
}
```

### FieldBuilder API

All typed field builders share these modifiers (each returns a new immutable instance):

| Modifier | Description |
|---|---|
| `.optional()` | Marks field as nullable; `null`/`undefined` values return `undefined` instead of throwing |
| `.default(value)` | Sets default value when source is `null`/`undefined` |
| `.nullable()` | Available on `string`, `number`, `boolean`, `date` builders. Allows `.default(null)` to type-check. |

### FieldDef

Internal definition stored as `_def` on each builder:

```typescript
interface FieldDef<T = unknown> {
    readonly column: string;       // Database column name
    readonly type: FieldType;      // 'string' | 'number' | 'boolean' | 'date' | 'any'
    readonly optional: boolean;
    readonly defaultValue?: T;     // Only present if explicitly set
}
```

The `defaultValue` key is conditionally included (using `'defaultValue' in def` checks) to distinguish "no default" from "default is `undefined`".

---

## Table Definitions

Source: `src/mapper.ts`

### Mapper.defineTables()

```typescript
Mapper.defineTables<T extends Record<string, TableDefInput>>(
    tables: T
): { readonly [K in keyof T]: FlattenedTableOutput<T[K]> }
```

Processes table input objects into frozen `FlattenedTable` structures. Each table input requires a `tableName` property and any number of `FieldBuilder` properties:

```typescript
interface TableDefInput {
    tableName: string;
    [key: string]: string | FieldBuilder;
}
```

### Mapper.defineTable()

```typescript
Mapper.defineTable<T extends TableDefInput>(table: T): FlattenedTableOutput<T>
```

Single-table variant of `defineTables()`.

### FlattenedTable

The processed table structure used by mappers:

```typescript
interface FlattenedTable {
    readonly $name: string;                                    // Table name
    readonly $fields: Readonly<Record<string, ResolvedFieldDef>>;  // Field definitions
}
```

`FlattenedTableOutput<T>` extends `FlattenedTable` with direct column name access:

```typescript
type FlattenedTableOutput<T extends TableDefInput> = FlattenedTable & {
    readonly [K in Exclude<keyof T, 'tableName'>]: string;  // property -> column name
};
```

This allows `Tables.User.displayName` to return `'display_name'` (the column name string), useful in SQL query construction.

### ResolvedFieldDef

```typescript
interface ResolvedFieldDef {
    readonly property: string;
    readonly column: string;
    readonly type: FieldType;
    readonly optional: boolean;
    readonly defaultValue?: unknown;
}
```

Both the output table and its `$fields` are frozen via `Object.freeze()`.

---

## Mapper Builder

Source: `src/mapper-builder.ts`, `src/mapper-types.ts`

### Mapper.for()

```typescript
Mapper.for<T>(table: FlattenedTable, ...fields: string[]): MapperBuilder<T>
```

Creates a mapper builder for a table. If field names are provided, only those fields from the primary table are mapped (field selection). Otherwise, all fields are included.

### MapperBuilder Interface

```typescript
interface MapperBuilder<T> {
    build(): BuiltMapper<T>;
    pick(table: FlattenedTable, ...fields: string[]): PickBuilder<T>;
    json<J>(column: string, factory?: (raw: unknown) => J | null | undefined): JsonBuilder<T, J>;
    col<C>(propertyName: string, columnOrCompute?: string | ((row: Record<string, unknown>) => C | null | undefined)): ColBuilder<T, C>;
    embed(key: string, table: FlattenedTable): EmbedBuilder<T>;
    omit(...fields: string[]): MapperBuilder<T>;
    field(fieldName: string): FieldRenameBuilder<T>;
    transform<K extends keyof T>(propertyName: K, fn: (value: T[K]) => T[K]): MapperBuilder<T>;
}
```

### Duplicate Property Detection

The builder tracks all mapped property names in a `Set`. Calling any mapping method that would produce a duplicate property name throws:

```
Error: Property '${name}' is already mapped. Each property can only be mapped once.
Attempted duplicate mapping from: ${source}
```

### Builder Methods

#### pick()

Maps fields from a different table (for JOINs). Returns a `PickBuilder` with:
- `.prefix(str)` -- column prefix for aliased JOIN columns (e.g., `'account_'`)
- All `MapperBuilder` methods (for chaining)

If `.prefix()` is not called before the next builder method or `.build()`, the pick is finalized with an empty prefix.

#### json()

Maps a JSON/JSONB column. Returns a `JsonBuilder` with:
- `.as(propertyName)` -- renames the output property (default: column name)
- `.default(value)` -- default when column is null
- `.optional()` -- converts null to undefined

An optional `factory` function can transform the parsed JSON (e.g., snake_case to camelCase mapping).

#### col()

Maps a raw column or computed value. The second argument can be:
- A string: explicit column name
- A function: `(row: Record<string, unknown>) => C | null | undefined` for derived values
- Omitted: column name inferred via camelCase-to-snake_case conversion

Returns a `ColBuilder` with `.default(value)` and `.optional()`.

The camelCase-to-snake_case conversion handles acronyms: `parseXMLDocument` becomes `parse_xml_document`.

#### embed()

Nests a related object from prefixed columns. Returns an `EmbedBuilder` with:
- `.prefix(str)` -- column prefix for JOIN-aliased columns

During mapping, if all prefixed columns are null, the embedded object is set to `undefined` (LEFT JOIN null detection).

#### omit()

Excludes fields from the primary table mapping. Accepts variadic field names.

#### field().as()

Renames a primary table field to a different property name. The original field name is added to the omit set, and a rename config is registered.

#### transform()

Post-coercion transformation on a mapped property. The function receives the coerced value and must return the same type.

### ChainedBuilder Pattern

`PickBuilder`, `JsonBuilder`, `ColBuilder`, and `EmbedBuilder` extend an abstract `ChainedBuilder<T>` that:
- Implements all `MapperBuilder` methods by delegating to the parent
- Calls `finalize()` (idempotent) before delegating, which adds the builder's config to the parent
- Auto-finalizes when `.build()` is called or another builder method is chained

---

## Built Mapper

Source: `src/built-mapper.ts`

### BuiltMapper Interface

```typescript
interface BuiltMapper<T> {
    map(row: unknown, options?: MapOptions): MapResult<T>;
    mapMany(rows: unknown[], options?: MapOptions): T[];
}

interface MapOptions {
    prefix?: string;  // Column prefix for the primary table
}
```

### map() Execution Order

1. Null check: returns `MapResult(undefined)` if row is null/undefined/non-object
2. Map primary table fields (respecting `includes` and `omits`)
3. Apply field renames
4. Apply picks (from other tables)
5. Apply JSON column mappings
6. Apply raw column mappings (including computed)
7. Apply embeds
8. Apply transforms
9. Wrap in `MapResult<T>`

### Field Value Resolution

For each field, `resolveFieldValue()` follows this logic:

1. Read `row[prefix + fieldDef.column]`
2. If value is null/undefined and `'defaultValue' in fieldDef`: return `defaultValue`
3. If value is null/undefined and `fieldDef.optional`: return `undefined`
4. Coerce value based on `fieldDef.type`

### MapResult

```typescript
interface MapResult<T> {
    mergeWhen(condition: boolean, extra: Partial<T> | undefined): MapResult<T>;
    default<D>(defaultValue: D): T | D;
    value(): T | undefined;
}
```

Fluent result wrapper:
- `mergeWhen()` -- conditionally merges extra fields into the result (spread merge)
- `default()` -- returns result or fallback
- `value()` -- unwraps to `T | undefined`

### mapMany()

Maps an array of rows, filtering out `undefined` results (rows that failed the null check).

---

## Coercion Functions

Source: `src/coercion.ts`

Type coercion applied during field value resolution:

| Function | Input Types | Error Behavior |
|---|---|---|
| `coerceString(value, table, column)` | Any non-null -> `String(value)` | Throws `MapperError` on null/undefined |
| `coerceNumber(value, table, column)` | Number passthrough, string parsed via `Number()` | Throws `MapperError` on null, NaN, empty string |
| `coerceBoolean(value)` | Any -> `Boolean(value)` | Never throws; simple truthiness conversion |
| `coerceDate(value, table, column)` | `Date` passthrough, number as timestamp, string as `new Date()` | Throws `MapperError` on null, invalid date, empty string |

`coerceBoolean` is the only coercion function that does not require table/column context, since it never throws.

For `any` type fields, no coercion is applied -- the value passes through as-is.

---

## MapperError

Source: `src/mapper-error.ts`

```typescript
class MapperError extends Error {
    readonly name = 'MapperError';
    readonly tableName: string;
    readonly columnName: string;
    readonly reason: string;
    readonly expectedType?: string;
    readonly actualValue?: unknown;
}
```

Formatted message: `[tableName.columnName] reason - expected expectedType, got: formattedValue`

Value formatting:
- `null` -> `"null"`
- `undefined` -> `"undefined"`
- Strings -> `"\"value\""`
- Objects -> `JSON.stringify()` with fallback to `"[object]"`
- Other -> `String(value)`
