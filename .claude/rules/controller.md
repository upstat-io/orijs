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
    r.post('/users', this.create, { body: CreateUserSchema });
    r.put('/users/:id', this.update, { body: UpdateUserSchema });
    r.delete('/users/:id', this.delete);
  }

  private list = async (ctx: RequestContext): Promise<Response> => {
    const users = await this.userService.list();
    return Response.json(users);
  };
}
```

## configure() Rules

- **Routing table ONLY** - No logic, no conditionals
- Define routes with HTTP method helpers: `r.get()`, `r.post()`, etc.
- Use arrow function properties for handlers (preserves `this`)

## Handler Rules

- **Arrow function properties** - Not methods (for correct `this` binding)
- Return `Response` via `Response.json()`, `new Response()`, etc.
- Validation is done at route level via schema options, not in handler

## Guards

```typescript
public configure(r: RouteBuilder): void {
  // Single guard applies to subsequent routes
  r.guard(AuthGuard).get('/profile', this.profile);

  // Multiple guards chain
  r.guard(AuthGuard)
    .guard(AdminGuard)
    .delete('/users/:id', this.delete);

  // Clear guards for public routes
  r.clearGuards().get('/public', this.publicData);
}
```

## Path Parameters

```typescript
private get = async (ctx: RequestContext): Promise<Response> => {
  const { id } = ctx.params;  // Type-safe params
  const user = await this.userService.get(id);
  return Response.json(user);
};
```

## Query Parameters

```typescript
// Define route with query schema
r.get('/users', this.list, { query: Query.pagination() });

// Access validated query in handler
private list = async (ctx: RequestContext): Promise<Response> => {
  // ctx.query is already validated by route schema
  const { page, limit } = ctx.query as { page: number; limit: number };
  const users = await this.userService.list({ page, limit });
  return Response.json(users);
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

// Register route with body schema
r.post('/users', this.create, { body: CreateUserSchema });

// Handler receives validated body
private create = async (ctx: RequestContext): Promise<Response> => {
  // ctx.body is already validated by route schema
  const input = ctx.body as CreateUserInput;
  const user = await this.userService.create(input);
  return Response.json(user, { status: 201 });
};
```

## Error Responses

```typescript
private get = async (ctx: RequestContext): Promise<Response> => {
  const user = await this.userService.get(ctx.params.id);
  if (!user) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }
  return Response.json(user);
};
```

## Schema Options

Routes accept an optional third argument for validation schemas:

```typescript
r.post('/users', this.create, {
  params: Params.uuid('id'),           // URL path parameters
  query: Query.pagination(),           // Query string parameters
  body: CreateUserSchema               // Request body
});
```

## Layer Order

```
Controller → Service → Repository → DbService
```

- Controllers handle HTTP concerns only
- Services contain business logic
- Repositories handle data access patterns
- DbServices execute queries
