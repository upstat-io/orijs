/**
 * OriJS benchmark with guards and context usage.
 * Tests performance of the full middleware stack.
 *
 * Run: bun benchmarks/scenarios/orijs-guards.ts
 */

import { Application } from '@orijs/orijs';
import type { OriController, RouteBuilder, RequestContext, Guard } from '@orijs/orijs';
import {
	configureBenchmarkLogger,
	shutdownLogger,
	nullTransport,
	runScenarios,
	printSummary
} from '../runner.ts';

configureBenchmarkLogger();

const PORT = 9996;

// Simple auth guard that checks header
class AuthGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		const authHeader = ctx.request.headers.get('authorization');
		return authHeader === 'Bearer test-token';
	}
}

// Rate limit guard that uses context state
class RateLimitGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		ctx.set('rateLimit', { remaining: 99, limit: 100 });
		return true;
	}
}

// Controller that uses context heavily
class ApiController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard);
		r.guard(RateLimitGuard);

		r.get('/user', this.getUser);
		r.post('/user', this.createUser);
		r.get('/items', this.listItems);
	}

	private getUser = async (ctx: RequestContext) => {
		const userId = ctx.query.id;
		const rateLimit = ctx.state.get('rateLimit');
		const requestId = ctx.request.headers.get('x-request-id') || 'unknown';

		return Response.json({
			id: userId,
			name: 'Test User',
			requestId,
			rateLimit
		});
	};

	private createUser = async (ctx: RequestContext) => {
		const body = await ctx.json();
		const contentType = ctx.request.headers.get('content-type');

		return Response.json({
			created: true,
			data: body,
			contentType
		});
	};

	private listItems = async (ctx: RequestContext) => {
		const page = ctx.query.page || '1';
		const limit = ctx.query.limit || '10';
		const sort = ctx.query.sort || 'id';

		return Response.json({
			items: [{ id: 1 }, { id: 2 }],
			pagination: { page, limit, sort }
		});
	};
}

const app = new Application();
app.logger({ level: 'error', transports: [nullTransport] });
app.controller('/api', ApiController);

const server = await app.listen(PORT);
console.log('Server ready on port ' + PORT);

const results = await runScenarios([
	{
		name: 'GET /api/user with guards',
		url: `http://localhost:${PORT}/api/user?id=123&extra=value`,
		options: {
			headers: {
				Authorization: 'Bearer test-token',
				'X-Request-Id': 'bench-request'
			}
		}
	},
	{
		name: 'GET /api/items with query params',
		url: `http://localhost:${PORT}/api/items?page=1&limit=20&sort=name`,
		options: {
			headers: { Authorization: 'Bearer test-token' }
		}
	},
	{
		name: 'POST /api/user with JSON body',
		url: `http://localhost:${PORT}/api/user`,
		options: {
			method: 'POST',
			headers: {
				Authorization: 'Bearer test-token',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ name: 'Test', email: 'test@example.com' })
		}
	},
	{
		name: 'GET /api/user with failed auth',
		url: `http://localhost:${PORT}/api/user`,
		options: {
			headers: { Authorization: 'Bearer wrong-token' }
		}
	}
]);

printSummary(results);

server.stop();
shutdownLogger();
console.log('\nBenchmark complete.');
