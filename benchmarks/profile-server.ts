/**
 * Server for CPU profiling with bun --inspect.
 * Run: bun --inspect benchmarks/profile-server.ts
 * Then open the debug.bun.sh URL and use Timeline to record.
 */
import { Application } from '../packages/core/src/index.ts';
import type { OriController, RouteBuilder, RequestContext, Guard } from '../packages/core/src/index.ts';

const PORT = 9997;

class AuthGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		const authHeader = ctx.request.headers.get('authorization');
		return authHeader === 'Bearer test-token';
	}
}

class RateLimitGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		// Use ctx.set(), NOT ctx.state.set() (state is a plain object, not a Map)
		ctx.set('rateLimit', { remaining: 99, limit: 100 });
		return true;
	}
}

class TestController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard);
		r.guard(RateLimitGuard);
		r.get('/test', (ctx: RequestContext) => {
			// Use ctx.get() or ctx.state.rateLimit (state is a plain object)
			const rateLimit = ctx.get('rateLimit');
			return Response.json({ ok: true, rateLimit });
		});
	}
}

const app = new Application();
app.controller('/api', TestController);

const server = await app.listen(PORT);
console.log(`Server ready on port ${PORT}`);
console.log('Waiting for requests...');
console.log('Press Ctrl+C to stop');
