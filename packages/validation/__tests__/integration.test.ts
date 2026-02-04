import { describe, test, expect, afterEach } from 'bun:test';
import { Type, Params, Query } from '../src';
import { Ori, type OriController, type RouteBuilder, type RequestContext } from '@orijs/core';

let server: ReturnType<typeof Bun.serve> | null = null;
let portCounter = 30000;

function getNextPort(): number {
	return portCounter++;
}

afterEach(() => {
	if (server) {
		server.stop();
		server = null;
	}
});

describe('Validation Integration', () => {
	describe('Params validation', () => {
		test('should validate UUID params', async () => {
			const port = getNextPort();

			class UserController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/:id', (ctx: RequestContext) => Response.json({ id: ctx.params.id }), {
						params: Params.uuid('id')
					});
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/users', UserController, [])
				.listen(port);

			// Valid UUID
			const validRes = await fetch(`http://localhost:${port}/users/550e8400-e29b-41d4-a716-446655440000`);
			expect(validRes.status).toBe(200);
			const validData = (await validRes.json()) as { id: string };
			expect(validData.id).toBe('550e8400-e29b-41d4-a716-446655440000');

			// Invalid UUID
			const invalidRes = await fetch(`http://localhost:${port}/users/not-a-uuid`);
			expect(invalidRes.status).toBe(422);
			const errorData = (await invalidRes.json()) as { error: string; errors: unknown[] };
			expect(errorData.error).toBe('Validation Error');
			expect(errorData.errors).toBeArray();
		});

		test('should validate numeric params', async () => {
			const port = getNextPort();

			class ItemController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/:id', (ctx: RequestContext) => Response.json({ id: ctx.params.id }), {
						params: Params.number('id')
					});
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/items', ItemController, [])
				.listen(port);

			// Valid number
			const validRes = await fetch(`http://localhost:${port}/items/123`);
			expect(validRes.status).toBe(200);

			// Invalid (not a number)
			const invalidRes = await fetch(`http://localhost:${port}/items/abc`);
			expect(invalidRes.status).toBe(422);
		});
	});

	describe('Query validation', () => {
		test('should validate pagination query params', async () => {
			const port = getNextPort();

			class ListController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (ctx: RequestContext) => Response.json({ query: ctx.query }), {
						query: Query.pagination()
					});
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/items', ListController, [])
				.listen(port);

			// Valid pagination
			const validRes = await fetch(`http://localhost:${port}/items?page=1&limit=10`);
			expect(validRes.status).toBe(200);

			// Invalid page (not a number)
			const invalidRes = await fetch(`http://localhost:${port}/items?page=abc`);
			expect(invalidRes.status).toBe(422);
		});

		test('should validate search query params', async () => {
			const port = getNextPort();

			class SearchController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/', (ctx: RequestContext) => Response.json({ q: ctx.query.q }), {
						query: Query.search({ minLength: 3 })
					});
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/search', SearchController, [])
				.listen(port);

			// Valid search
			const validRes = await fetch(`http://localhost:${port}/search?q=hello`);
			expect(validRes.status).toBe(200);

			// Too short
			const shortRes = await fetch(`http://localhost:${port}/search?q=hi`);
			expect(shortRes.status).toBe(422);
		});
	});

	describe('Body validation', () => {
		test('should validate POST body', async () => {
			const port = getNextPort();

			class UserController implements OriController {
				configure(r: RouteBuilder) {
					r.post(
						'/',
						async (ctx: RequestContext) => {
							const body = await ctx.json();
							return Response.json({ created: body });
						},
						{
							body: Type.Object({
								name: Type.String({ minLength: 1 }),
								email: Type.String({ pattern: '^[^@]+@[^@]+\\.[^@]+$' })
							})
						}
					);
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/users', UserController, [])
				.listen(port);

			// Valid body
			const validRes = await fetch(`http://localhost:${port}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' })
			});
			expect(validRes.status).toBe(200);

			// Invalid email
			const invalidEmailRes = await fetch(`http://localhost:${port}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Bob', email: 'not-an-email' })
			});
			expect(invalidEmailRes.status).toBe(422);

			// Missing required field
			const missingFieldRes = await fetch(`http://localhost:${port}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Charlie' })
			});
			expect(missingFieldRes.status).toBe(422);
		});

		test('should validate PUT body', async () => {
			const port = getNextPort();

			class UserController implements OriController {
				configure(r: RouteBuilder) {
					r.put(
						'/:id',
						async (ctx: RequestContext) => {
							const body = (await ctx.json()) as Record<string, unknown>;
							return Response.json({ updated: { id: ctx.params.id, ...body } });
						},
						{
							params: Params.uuid('id'),
							body: Type.Object({
								name: Type.String()
							})
						}
					);
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/users', UserController, [])
				.listen(port);

			// Valid request
			const validRes = await fetch(`http://localhost:${port}/users/550e8400-e29b-41d4-a716-446655440000`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Updated Name' })
			});
			expect(validRes.status).toBe(200);

			// Invalid body (missing name)
			const invalidBodyRes = await fetch(
				`http://localhost:${port}/users/550e8400-e29b-41d4-a716-446655440000`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({})
				}
			);
			expect(invalidBodyRes.status).toBe(422);
		});

		test('should return 422 for invalid JSON body (parse error as validation error)', async () => {
			const port = getNextPort();

			class UserController implements OriController {
				configure(r: RouteBuilder) {
					r.post(
						'/',
						async (ctx: RequestContext) => {
							const body = await ctx.json();
							return Response.json({ created: body });
						},
						{
							body: Type.Object({
								name: Type.String()
							})
						}
					);
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/users', UserController, [])
				.listen(port);

			// Note: Invalid JSON is returned as 422 because the framework treats
			// parse errors as validation errors (body doesn't match expected schema)
			const res = await fetch(`http://localhost:${port}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'not valid json'
			});
			expect(res.status).toBe(422);
			const data = (await res.json()) as { error: string };
			expect(data.error).toBe('Validation Error');
		});
	});

	describe('Combined validation', () => {
		test('should validate params, query, and body together', async () => {
			const port = getNextPort();

			class ItemController implements OriController {
				configure(r: RouteBuilder) {
					r.put(
						'/:id',
						async (ctx: RequestContext) => {
							const body = await ctx.json();
							return Response.json({
								id: ctx.params.id,
								query: ctx.query,
								body
							});
						},
						{
							params: Params.uuid('id'),
							query: Query.search(),
							body: Type.Object({
								name: Type.String()
							})
						}
					);
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/items', ItemController, [])
				.listen(port);

			// All valid
			const validRes = await fetch(
				`http://localhost:${port}/items/550e8400-e29b-41d4-a716-446655440000?q=test`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: 'Test Item' })
				}
			);
			expect(validRes.status).toBe(200);

			// Invalid param
			const invalidParamRes = await fetch(`http://localhost:${port}/items/not-uuid?q=test`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Test Item' })
			});
			expect(invalidParamRes.status).toBe(422);
		});
	});

	describe('No validation', () => {
		test('should skip validation when no schema provided', async () => {
			const port = getNextPort();

			class SimpleController implements OriController {
				configure(r: RouteBuilder) {
					r.get('/:anything', (ctx: RequestContext) => Response.json({ param: ctx.params.anything }));
					r.post('/', async (ctx: RequestContext) => {
						const body = await ctx.json();
						return Response.json({ received: body });
					});
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/api', SimpleController, [])
				.listen(port);

			// Any param value works
			const paramRes = await fetch(`http://localhost:${port}/api/anything-goes`);
			expect(paramRes.status).toBe(200);

			// Any body works
			const bodyRes = await fetch(`http://localhost:${port}/api`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ anything: 'goes', here: 123 })
			});
			expect(bodyRes.status).toBe(200);
		});
	});

	describe('Custom validators', () => {
		test('should validate with sync custom function', async () => {
			const port = getNextPort();

			class UserController implements OriController {
				configure(r: RouteBuilder) {
					r.post(
						'/',
						async (ctx: RequestContext) => {
							const body = await ctx.json();
							return Response.json({ created: body });
						},
						{
							body: (data: unknown) => {
								if (!data || typeof data !== 'object') {
									throw new Error('Expected object');
								}
								const obj = data as Record<string, unknown>;
								if (!obj.name || typeof obj.name !== 'string') {
									throw new Error('Name is required');
								}
								return data as { name: string };
							}
						}
					);
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/users', UserController, [])
				.listen(port);

			// Valid body
			const validRes = await fetch(`http://localhost:${port}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Alice' })
			});
			expect(validRes.status).toBe(200);

			// Invalid body (missing name)
			const invalidRes = await fetch(`http://localhost:${port}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'alice@example.com' })
			});
			expect(invalidRes.status).toBe(422);
			const errorData = (await invalidRes.json()) as { error: string };
			expect(errorData.error).toBe('Validation Error');
		});

		test('should validate with async custom function', async () => {
			const port = getNextPort();

			// Simulate a "database" of existing emails
			const existingEmails = new Set(['taken@example.com', 'admin@example.com']);

			class UserController implements OriController {
				configure(r: RouteBuilder) {
					r.post(
						'/',
						async (ctx: RequestContext) => {
							const body = await ctx.json();
							return Response.json({ created: body });
						},
						{
							body: async (data: unknown) => {
								// Simulate async database lookup
								await new Promise((resolve) => setTimeout(resolve, 1));

								const obj = data as Record<string, unknown>;
								if (typeof obj.email !== 'string') {
									throw new Error('Email is required');
								}
								if (existingEmails.has(obj.email)) {
									throw new Error('Email already registered');
								}
								return data as { email: string };
							}
						}
					);
				}
			}

			server = await Ori.create()
				.logger({ level: 'error' })
				.controller('/users', UserController, [])
				.listen(port);

			// Valid email (not taken)
			const validRes = await fetch(`http://localhost:${port}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'new@example.com' })
			});
			expect(validRes.status).toBe(200);

			// Invalid (email already taken)
			const takenRes = await fetch(`http://localhost:${port}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'taken@example.com' })
			});
			expect(takenRes.status).toBe(422);
			const errorData = (await takenRes.json()) as { errors: Array<{ message: string }> };
			expect(errorData.errors[0]?.message).toBe('Email already registered');
		});
	});
});
