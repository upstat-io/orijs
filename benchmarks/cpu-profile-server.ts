/**
 * Server-only script for profiling.
 * Run with: bun --cpu-prof benchmarks/cpu-profile-server.ts
 * Then hit with: for i in {1..1000}; do curl -s -H "Authorization: Bearer test-token" localhost:9997/api/test; done
 */

import { Application } from '@orijs/orijs';
import type { OriController, RouteBuilder, RequestContext, Guard } from '@orijs/orijs';

const PORT = 9997;

class AuthGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		const authHeader = ctx.request.headers.get('authorization');
		return authHeader === 'Bearer test-token';
	}
}

class RateLimitGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		ctx.state.set('rateLimit', { remaining: 99, limit: 100 });
		return true;
	}
}

class TestController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard);
		r.guard(RateLimitGuard);
		r.get('/test', (ctx: RequestContext) => {
			const rateLimit = ctx.state.get('rateLimit');
			return Response.json({ ok: true, rateLimit });
		});
	}
}

const app = new Application();
app.controller('/api', TestController);

const server = await app.listen(PORT);
console.log(`Server ready on port ${PORT}`);
console.log('Waiting for requests... (Ctrl+C to stop and write profile)');

// Auto-exit after 10 seconds
setTimeout(() => {
	console.log('Auto-exiting after 10s');
	server.stop(true);
	process.exit(0);
}, 10000);
