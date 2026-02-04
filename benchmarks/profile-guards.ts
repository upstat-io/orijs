/**
 * Profile individual components of the guard pipeline.
 */

import { Application } from '@orijs/orijs';
import type { OriController, RouteBuilder, RequestContext, Guard } from '@orijs/orijs';
import { configureBenchmarkLogger, shutdownLogger, nullTransport } from './runner.ts';

configureBenchmarkLogger();

const PORT = 9997;
const WARMUP = 100;
const REQUESTS = 2000;

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

class NoGuardController implements OriController {
	configure(r: RouteBuilder) {
		r.get('/fast', () => Response.json({ ok: true }));
	}
}

class OneGuardController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard);
		r.get('/one', () => Response.json({ ok: true }));
	}
}

class TwoGuardsController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard);
		r.guard(RateLimitGuard);
		r.get('/two', (ctx: RequestContext) => {
			const rateLimit = ctx.state.get('rateLimit');
			return Response.json({ ok: true, rateLimit });
		});
	}
}

const app = new Application();
app.logger({ level: 'error', transports: [nullTransport] });
app.controller('/api', NoGuardController);
app.controller('/api', OneGuardController);
app.controller('/api', TwoGuardsController);

const server = await app.listen(PORT);
console.log('Server ready on port ' + PORT);

const CONCURRENCY = 50;

async function runBench(name: string, url: string, headers: Record<string, string> = {}) {
	// Warmup
	for (let i = 0; i < 10; i++) {
		await Promise.all(
			Array(CONCURRENCY)
				.fill(0)
				.map(() => fetch(url, { headers }))
		);
	}

	// Timed run
	const start = performance.now();
	let completed = 0;
	while (completed < REQUESTS) {
		const batch = Math.min(CONCURRENCY, REQUESTS - completed);
		await Promise.all(
			Array(batch)
				.fill(0)
				.map(() => fetch(url, { headers }))
		);
		completed += batch;
	}
	const elapsed = performance.now() - start;
	const rps = Math.round((REQUESTS / elapsed) * 1000);
	console.log(`${name.padEnd(30)} ${rps.toLocaleString().padStart(8)} req/sec (${elapsed.toFixed(0)}ms)`);
}

console.log(`\n=== Concurrent Fetch Comparison (concurrency=${CONCURRENCY}) ===\n`);

await runBench('No guards (fast path)', `http://localhost:${PORT}/api/fast`);
await runBench('1 guard', `http://localhost:${PORT}/api/one`, { Authorization: 'Bearer test-token' });
await runBench('2 guards + state', `http://localhost:${PORT}/api/two`, {
	Authorization: 'Bearer test-token'
});

server.stop();
await shutdownLogger();
process.exit(0);
