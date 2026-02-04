# Validation

This guide covers validation in OriJS using TypeBox for schema definitions, including request body validation, path parameters, query parameters, and custom validators.

> **Related**: [HTTP Routing](./http-routing.md) | [API Reference](./api-reference.md)

---

## Overview

OriJS uses [TypeBox](https://github.com/sinclairzx81/typebox) as its primary validation library. TypeBox provides:

- **JSON Schema compatible**: Schemas compile to standard JSON Schema
- **Type inference**: TypeScript types are automatically inferred from schemas
- **Fast validation**: High-performance validation with detailed error messages
- **Composable**: Build complex schemas from simple primitives

```typescript
import { Type, Static } from '@orijs/validation';

// Define a schema
const UserSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	email: Type.String({ format: 'email' }),
	age: Type.Optional(Type.Number({ minimum: 0 }))
});

// Infer the TypeScript type
type User = Static<typeof UserSchema>;
// { name: string; email: string; age?: number }
```

---

## Basic Types

### Primitive Types

```typescript
import { Type } from '@orijs/validation';

// Strings
Type.String(); // any string
Type.String({ minLength: 1 }); // non-empty string
Type.String({ maxLength: 100 }); // max 100 chars
Type.String({ pattern: '^[a-z]+$' }); // regex pattern
Type.String({ format: 'email' }); // email format
Type.String({ format: 'uri' }); // URI format
Type.String({ format: 'uuid' }); // UUID format
Type.String({ format: 'date-time' }); // ISO 8601 datetime

// Numbers
Type.Number(); // any number
Type.Number({ minimum: 0 }); // >= 0
Type.Number({ maximum: 100 }); // <= 100
Type.Number({ exclusiveMinimum: 0 }); // > 0
Type.Integer(); // integer only
Type.Integer({ minimum: 1 }); // positive integer

// Boolean
Type.Boolean();

// Null
Type.Null();

// Literal values
Type.Literal('active'); // exactly 'active'
Type.Literal(42); // exactly 42
Type.Literal(true); // exactly true
```

### Objects

```typescript
// Required properties
const User = Type.Object({
	id: Type.String({ format: 'uuid' }),
	name: Type.String({ minLength: 1 }),
	email: Type.String({ format: 'email' })
});

// Optional properties
const UserUpdate = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	email: Type.Optional(Type.String({ format: 'email' }))
});

// Nested objects
const Order = Type.Object({
	id: Type.String(),
	user: Type.Object({
		id: Type.String(),
		name: Type.String()
	}),
	items: Type.Array(
		Type.Object({
			productId: Type.String(),
			quantity: Type.Integer({ minimum: 1 })
		})
	)
});

// Additional properties
const Metadata = Type.Object(
	{ version: Type.String() },
	{ additionalProperties: Type.String() } // allow string values
);

// Strict mode (reject unknown properties - RECOMMENDED)
const StrictUser = Type.Object(
	{
		name: Type.String(),
		email: Type.String()
	},
	{ additionalProperties: false }
);
```

### Arrays

```typescript
// Array of strings
Type.Array(Type.String());

// Array with constraints
Type.Array(Type.String(), { minItems: 1 }); // at least 1 item
Type.Array(Type.String(), { maxItems: 10 }); // at most 10 items
Type.Array(Type.String(), { uniqueItems: true }); // no duplicates

// Tuple (fixed length, typed positions)
Type.Tuple([Type.String(), Type.Number()]); // [string, number]
```

### Unions and Enums

```typescript
// Union types
const Status = Type.Union([Type.Literal('pending'), Type.Literal('active'), Type.Literal('inactive')]);

// Enum (TypeScript enum style)
const Priority = Type.Enum({
	Low: 'low',
	Medium: 'medium',
	High: 'high'
});

// Nullable
const NullableName = Type.Union([Type.String(), Type.Null()]);

// Or use Type.Optional for undefined
const OptionalName = Type.Optional(Type.String());
```

### Records

```typescript
// Record with string keys and number values
const Scores = Type.Record(Type.String(), Type.Number());
// { [key: string]: number }

// Record with specific key pattern
const UuidMap = Type.Record(
	Type.String({ pattern: '^[0-9a-f-]{36}$' }),
	Type.Object({ name: Type.String() })
);
```

---

## Route Validation

### Body Validation

Validate request body in route definitions:

```typescript
import { Type, Params } from '@orijs/validation';

const CreateUserSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		email: Type.String({ format: 'email' }),
		password: Type.String({ minLength: 8 })
	},
	{ additionalProperties: false }
);

class UserController implements OriController {
	configure(r: RouteBuilder) {
		r.post('/create', this.create, { body: CreateUserSchema });
	}

	private create = async (ctx: RequestContext) => {
		// Body is already validated - safe to use
		const body = await ctx.json<Static<typeof CreateUserSchema>>();
		return ctx.json(await this.userService.create(body), 201);
	};
}
```

### Path Parameter Validation

Use the `Params` helper for common patterns:

```typescript
import { Params } from '@orijs/validation';

class UserController implements OriController {
	configure(r: RouteBuilder) {
		// Single UUID parameter
		r.get('/:id', this.findById, { params: Params.uuid('id') });

		// Multiple UUID parameters
		r.get('/:orgId/users/:userId', this.findUser, {
			params: Params.uuid('orgId', 'userId')
		});

		// String parameter with constraints
		r.get('/by-slug/:slug', this.findBySlug, {
			params: Params.string('slug', { minLength: 1, maxLength: 100 })
		});

		// Numeric parameter
		r.get('/page/:page', this.getPage, {
			params: Params.number('page', { min: 1 })
		});
	}

	private findById = async (ctx: RequestContext) => {
		const { id } = ctx.params; // Already validated as UUID
		return ctx.json(await this.userService.findById(id));
	};
}
```

### Query Parameter Validation

Use the `Query` helper for common patterns:

```typescript
import { Query, Type } from '@orijs/validation';

class UserController implements OriController {
	configure(r: RouteBuilder) {
		// Pagination
		r.get('/list', this.list, {
			query: Query.pagination({ maxLimit: 50, defaultLimit: 20 })
		});

		// Search
		r.get('/search', this.search, {
			query: Query.search({ minLength: 2 })
		});

		// Sorting
		r.get('/sorted', this.sorted, {
			query: Query.sort({
				allowed: ['name', 'createdAt', 'email'],
				defaultField: 'createdAt',
				defaultOrder: 'desc'
			})
		});

		// Combined
		r.get('/all', this.findAll, {
			query: Type.Intersect([
				Query.pagination({ maxLimit: 100 }),
				Query.search(),
				Query.sort({ allowed: ['name', 'createdAt'] })
			])
		});

		// Custom query schema
		r.get('/filter', this.filter, {
			query: Type.Object({
				status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
				since: Type.Optional(Type.String({ format: 'date' }))
			})
		});
	}

	private list = async (ctx: RequestContext) => {
		// Query is validated and coerced
		const { page, limit } = ctx.query; // page and limit are numbers
		return ctx.json(await this.userService.list({ page, limit }));
	};
}
```

### Query Helper Options

```typescript
// Pagination options
Query.pagination({
	defaultPage: 1, // Default page number (default: 1)
	defaultLimit: 20, // Default items per page (default: 20)
	maxLimit: 100, // Maximum allowed limit (default: 100)
	minLimit: 1 // Minimum allowed limit (default: 1)
});

// Search options
Query.search({
	minLength: 2, // Minimum search query length (default: 1)
	maxLength: 100 // Maximum search query length (default: 100)
});

// Sort options
Query.sort({
	allowed: ['name', 'date'], // Allowed sort fields (optional)
	defaultField: 'date', // Default sort field (optional)
	defaultOrder: 'desc' // Default sort order (default: 'asc')
});
```

---

## Manual Validation

Use `validate()` for programmatic validation:

```typescript
import { validate, Type } from '@orijs/validation';

const UserSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	email: Type.String({ format: 'email' })
});

async function processUser(data: unknown) {
	const result = await validate(UserSchema, data);

	if (!result.success) {
		// Handle validation errors
		console.error('Validation failed:', result.errors);
		// result.errors: [{ path: '/email', message: '...', value: ... }]
		return null;
	}

	// Use validated data
	const user = result.data; // Typed as { name: string; email: string }
	return user;
}
```

---

## Custom Validators

For complex validation logic that can't be expressed in JSON Schema:

```typescript
import { Type, Validator } from '@orijs/validation';

// Custom validator function
const validateUniqueEmail: Validator<{ email: string }> = async (data) => {
	if (!data || typeof data !== 'object') {
		throw new Error('Invalid data');
	}

	const { email } = data as { email: string };

	// Async validation (e.g., database check)
	const exists = await userRepository.emailExists(email);
	if (exists) {
		throw new Error('Email already registered');
	}

	return { email };
};

// Use in route
r.post('/register', this.register, { body: validateUniqueEmail });
```

### Combining Schema and Custom Validation

```typescript
const CreateUserSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	email: Type.String({ format: 'email' }),
	password: Type.String({ minLength: 8 })
});

// First validate schema, then custom logic
const validateCreateUser: Validator<Static<typeof CreateUserSchema>> = async (data) => {
	// Schema validation
	const schemaResult = await validate(CreateUserSchema, data);
	if (!schemaResult.success) {
		throw new Error(schemaResult.errors[0].message);
	}

	// Custom validation
	const exists = await userRepository.emailExists(schemaResult.data.email);
	if (exists) {
		throw new Error('Email already registered');
	}

	return schemaResult.data;
};
```

---

## Safe JSON Parsing

OriJS provides a safe JSON parser that prevents prototype pollution attacks:

```typescript
import { Json } from '@orijs/validation';

// UNSAFE - prototype pollution possible
const unsafe = JSON.parse('{"__proto__": {"admin": true}}');
// When spread or assigned, can modify Object.prototype

// SAFE - dangerous keys stripped
const safe = Json.parse('{"__proto__": {"admin": true}, "name": "test"}');
// Result: { name: "test" }

// Sanitize already-parsed objects
const external = someLibrary.getData(); // May contain __proto__
const sanitized = Json.sanitize(external);
```

**Keys stripped by `Json.sanitize()`:**

- `__proto__` - Direct prototype setter
- `constructor` - Access to constructor.prototype
- `prototype` - Direct prototype property

**Always use `Json.parse()` instead of `JSON.parse()` when parsing untrusted input.**

---

## Transform Types

TypeBox supports transformations for encoding/decoding:

```typescript
import { Type } from '@orijs/validation';

// Query params come as strings - transform to numbers
const PageParam = Type.Transform(Type.String({ pattern: '^[0-9]+$' }))
	.Decode((value) => parseInt(value, 10)) // string -> number
	.Encode((value) => String(value)); // number -> string

// Date transformation
const DateParam = Type.Transform(Type.String({ format: 'date-time' }))
	.Decode((value) => new Date(value)) // string -> Date
	.Encode((value) => value.toISOString()); // Date -> string

// Use in schema
const QuerySchema = Type.Object({
	page: PageParam,
	since: Type.Optional(DateParam)
});
```

---

## Composite Schemas

### Intersect (All Of)

Combine multiple schemas where all must be satisfied:

```typescript
const BaseEntity = Type.Object({
	id: Type.String({ format: 'uuid' }),
	createdAt: Type.String({ format: 'date-time' })
});

const UserFields = Type.Object({
	name: Type.String(),
	email: Type.String({ format: 'email' })
});

const User = Type.Intersect([BaseEntity, UserFields]);
// { id, createdAt, name, email }
```

### Pick and Omit

Extract or exclude properties:

```typescript
const User = Type.Object({
	id: Type.String(),
	name: Type.String(),
	email: Type.String(),
	password: Type.String()
});

// Pick specific properties
const UserPublic = Type.Pick(User, ['id', 'name', 'email']);

// Omit specific properties
const UserCreate = Type.Omit(User, ['id']);
```

### Partial and Required

Make properties optional or required:

```typescript
const User = Type.Object({
	name: Type.String(),
	email: Type.String()
});

// All properties optional
const UserUpdate = Type.Partial(User);
// { name?: string; email?: string }

// All properties required (undo partial)
const UserFull = Type.Required(UserUpdate);
```

---

## Validation Error Format

When validation fails, errors follow this structure:

```typescript
interface ValidationError {
	path: string; // JSON pointer to the failing field
	message: string; // Human-readable error message
	value?: unknown; // The invalid value (for debugging)
}

// Example errors
[
	{ path: '/name', message: 'Expected string length >= 1', value: '' },
	{ path: '/email', message: 'Expected string to match email format', value: 'not-an-email' },
	{ path: '/items/0/quantity', message: 'Expected integer', value: 1.5 }
];
```

### Error Response Format

In route validation, errors return a 422 response:

```json
{
	"type": "validation_error",
	"title": "Validation Error",
	"status": 422,
	"detail": "Request validation failed",
	"errors": [
		{ "path": "/name", "message": "Expected string length >= 1" },
		{ "path": "/email", "message": "Expected string to match email format" }
	]
}
```

---

## Type Inference

TypeBox provides excellent TypeScript type inference:

```typescript
import { Type, Static } from '@orijs/validation';

const UserSchema = Type.Object({
	id: Type.String({ format: 'uuid' }),
	name: Type.String(),
	email: Type.String({ format: 'email' }),
	role: Type.Union([Type.Literal('admin'), Type.Literal('user')]),
	tags: Type.Array(Type.String()),
	settings: Type.Optional(
		Type.Object({
			theme: Type.Union([Type.Literal('light'), Type.Literal('dark')]),
			notifications: Type.Boolean()
		})
	)
});

// Inferred type:
type User = Static<typeof UserSchema>;
// {
//   id: string;
//   name: string;
//   email: string;
//   role: 'admin' | 'user';
//   tags: string[];
//   settings?: {
//     theme: 'light' | 'dark';
//     notifications: boolean;
//   };
// }
```

---

## Best Practices

### 1. Use Strict Mode

Always use `additionalProperties: false` to reject unknown fields:

```typescript
// GOOD - Unknown fields rejected
const UserCreate = Type.Object(
	{
		name: Type.String(),
		email: Type.String()
	},
	{ additionalProperties: false }
);

// BAD - Unknown fields silently accepted
const UserCreate = Type.Object({
	name: Type.String(),
	email: Type.String()
});
```

### 2. Reuse Common Schemas

Define common schemas once and reuse:

```typescript
// schemas/common.ts
export const UuidSchema = Type.String({ format: 'uuid' });
export const EmailSchema = Type.String({ format: 'email' });
export const TimestampSchema = Type.String({ format: 'date-time' });

export const PaginatedResponse = <T extends TSchema>(itemSchema: T) =>
	Type.Object({
		items: Type.Array(itemSchema),
		total: Type.Integer({ minimum: 0 }),
		page: Type.Integer({ minimum: 1 }),
		limit: Type.Integer({ minimum: 1 })
	});
```

### 3. Validate at Boundaries

Validate data at system boundaries:

- Request body (from clients)
- External API responses
- Queue message payloads
- Config files

```typescript
// Controller validates input
r.post('/users', this.create, { body: CreateUserSchema });

// Service trusts already-validated data
class UserService {
	create(data: UserCreate) {
		// Typed, not validated again
		return this.repository.insert(data);
	}
}
```

### 4. Use Descriptive Error Messages

Add custom error messages when helpful:

```typescript
const PasswordSchema = Type.String({
	minLength: 8,
	pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).+$',
	description: 'Password must be 8+ chars with uppercase, lowercase, and number'
});
```

### 5. Don't Validate Internal Data

Trust data within your application boundaries:

```typescript
// DON'T validate data from your own services
const user = await userService.findById(id);
// user is already typed - no need to validate

// DO validate external input
const body = await ctx.json(); // Unknown until validated
```

---

## Next Steps

- [HTTP Routing](./http-routing.md) - Use validation in routes
- [API Reference](./api-reference.md) - Complete API documentation
- [TypeBox Documentation](https://github.com/sinclairzx81/typebox) - Full TypeBox reference
