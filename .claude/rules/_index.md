# OriJS Rules Index

## Rule Files

| File | Description |
|------|-------------|
| `code-quality.md` | No @upstat deps, naming, functions, SRP |
| `controller.md` | Route builder, handlers, guards, validation |
| `sql.md` | oriSql patterns, table definitions, Bun postgres |
| `testing.md` | Bun test, layers, mocking, assertions |

## Quick Reference

### Absolute Rules
1. **NO @upstat/* dependencies** - Zero tolerance
2. **Bun-native** - Use Bun APIs, not Node.js
3. **TypeBox validation** - Not Zod
4. **Fix ALL errors immediately** - No exceptions

### Controller Pattern
```typescript
public configure(r: RouteBuilder): void {
  r.get('/users', this.list);
  r.guard(AuthGuard).post('/users', this.create);
}

private list = async (ctx: RequestContext): Promise<Response> => {
  return ctx.json(await this.service.list());
};
```

### oriSql Pattern
```typescript
const sql = oriSql`
  SELECT ${[UserTable.id]}
  FROM ${[UserTable]}
  WHERE ${[UserTable.accountId]} = ${accountId}
`;
```

### Testing
- Use `bun test`
- Test names: `should [behavior] when [condition]`
- Strong assertions (exact values)
- Chain promise handlers: `.catch().finally()`

### Layer Order
```
Controller → Service → Repository → DbService
```
