# Controller Rules

## Structure

```typescript
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly logger: Logger
  ) {}

  public configure(r: RouteBuilder): void {
    r.get('/users', this.list);
    r.get('/users/:id', this.get);
    r.post('/users', this.create);
    r.put('/users/:id', this.update);
    r.delete('/users/:id', this.delete);
  }

  private list = async (ctx: RequestContext): Promise<Response> => {
    const users = await this.userService.list();
    return ctx.json(users);
  };
}
```

## configure() Rules

- **Routing table ONLY** - No logic, no conditionals
- Define routes with HTTP method helpers: `r.get()`, `r.post()`, etc.
- Use arrow function properties for handlers (preserves `this`)

## Handler Rules

- **Arrow function properties** - Not methods (for correct `this` binding)
- Return `Response` via `ctx.json()`, `ctx.text()`, etc.
- Validate request body with schema: `await ctx.json(CreateUserSchema)`

## Guards

```typescript
public configure(r: RouteBuilder): void {
  // Single guard
  r.guard(AuthGuard).get('/profile', this.profile);

  // Guard group
  r.guard(AuthGuard).group('/admin', (r) => {
    r.guard(AdminGuard).delete('/users/:id', this.delete);
  });
}
```

## Path Parameters

```typescript
private get = async (ctx: RequestContext): Promise<Response> => {
  const { id } = ctx.params;  // Type-safe params
  const user = await this.userService.get(id);
  return ctx.json(user);
};
```

## Query Parameters

```typescript
private list = async (ctx: RequestContext): Promise<Response> => {
  const { page, limit } = ctx.query.parse(PaginationSchema);
  const users = await this.userService.list({ page, limit });
  return ctx.json(users);
};
```

## Request Body Validation

```typescript
import { Type, Static } from '@orijs/validation';

const CreateUserSchema = Type.Object({
  email: Type.String({ format: 'email' }),
  name: Type.String({ minLength: 1 })
});

type CreateUserInput = Static<typeof CreateUserSchema>;

private create = async (ctx: RequestContext): Promise<Response> => {
  const input = await ctx.json(CreateUserSchema);  // Validates & parses
  const user = await this.userService.create(input);
  return ctx.json(user, { status: 201 });
};
```

## Error Responses

```typescript
private get = async (ctx: RequestContext): Promise<Response> => {
  const user = await this.userService.get(ctx.params.id);
  if (!user) {
    return ctx.json({ error: 'User not found' }, { status: 404 });
  }
  return ctx.json(user);
};
```

## Layer Order

```
Controller → Service → Repository → DbService
```

- Controllers handle HTTP concerns only
- Services contain business logic
- Repositories handle data access patterns
- DbServices execute queries
