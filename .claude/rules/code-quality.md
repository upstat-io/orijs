# Code Quality Rules

## NO @upstat/* Dependencies (ABSOLUTE)

This is a standalone OSS framework. **ZERO** dependencies on @upstat/* allowed.

Check before committing:
```bash
grep -r "@upstat/" packages/
# Must return nothing
```

## Type Assertions Banned

```typescript
// WRONG
const user = data as User;
const value = something as unknown as Other;

// CORRECT
if (isUser(data)) { /* use data */ }
// Or use proper type narrowing
```

## No `as const`

Use proper type definitions instead:

```typescript
// WRONG
const status = 'active' as const;

// CORRECT
type Status = 'active' | 'inactive';
const status: Status = 'active';
```

## Functions

- Max 20 lines ideal
- Max 3 parameters (use object for more)
- No boolean flag parameters
- Don't mutate inputs
- Single responsibility

```typescript
// WRONG
function processUser(user: User, shouldValidate: boolean, shouldNotify: boolean) {}

// CORRECT
function processUser(user: User) {}
function processAndValidateUser(user: User) {}
function processAndNotifyUser(user: User) {}
```

## Naming

- Name by domain responsibility
- NO pattern names: "Strategy", "Factory", "Manager", "Handler"
- Classes: PascalCase nouns
- Methods: camelCase verbs
- Booleans: `isActive`, `hasPermission`, `canExecute`

```typescript
// WRONG
class UserFactory {}
class NotificationManager {}

// CORRECT
class UserCreator {}  // Or just inline if simple
class NotificationSender {}
```

## SRP Detection

Warning signs:
- Constructor 6+ dependencies
- File >300 lines
- Method names with "And"
- Class name has "Manager"/"Handler"/"Processor"

## Error Handling

- Exceptions over return codes
- Include context: what failed, why, relevant IDs
- Don't return null (use empty collection, throw, or Optional)
- Don't pass null as parameters

```typescript
// WRONG
throw new Error('Not found');

// CORRECT
throw new NotFoundError(`User ${userId} not found in account ${accountId}`);
```

## No Barrel Files

Import from source directly:

```typescript
// WRONG
export * from './user.service';
export * from './user.repository';

// CORRECT - Import from source
import { UserService } from './user.service';
```

## Comments

- Code should be self-documenting
- Comments explain "why", not "what"
- No commented-out code
- JSDoc for public APIs only

## Before Committing

1. `bun run tsc --noEmit` - No type errors
2. `bun test` - All tests pass
3. `bun run lint` - No lint errors
4. No `console.log` statements
5. No @upstat/* imports
6. No commented-out code
