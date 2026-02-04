/**
 * CPU profiling script for guard performance.
 * Uses Bun's programmatic profiler API.
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
console.log('Server ready');

// Run limited requests
const REQUESTS = 1000;
const headers = { Authorization: 'Bearer test-token' };

console.log(`Running ${REQUESTS} requests...`);

// Start profiling
const profiler = Bun.nanoseconds;
const startNs = profiler();

for (let i = 0; i < REQUESTS; i++) {
	await fetch(`http://localhost:${PORT}/api/test`, { headers });
}

const endNs = profiler();
const elapsedMs = (endNs - startNs) / 1_000_000;
console.log(`Done in ${elapsedMs.toFixed(0)}ms (${Math.round(REQUESTS / (elapsedMs / 1000))} req/sec)`);

server.stop(true);
process.exit(0);
