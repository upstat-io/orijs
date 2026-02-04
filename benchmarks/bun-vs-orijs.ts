/**
 * Compare raw Bun.serve() vs OriJS to measure framework overhead.
 */
import { Application } from '../packages/core/src/index.ts';
import type { OriController, RouteBuilder, RequestContext, Guard } from '../packages/core/src/index.ts';

const WARMUP = 2000;
const ITERATIONS = 5000;
const RUNS = 5;

// ============ GUARDS (for OriJS) ============

class AuthGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		const authHeader = ctx.request.headers.get('authorization');
		return authHeader === 'Bearer test-token';
	}
}

class RateLimitGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		ctx.set('rateLimit', { remaining: 99, limit: 100 });
		return true;
	}
}

// ============ CONTROLLERS ============

class NoGuardController implements OriController {
	configure(r: RouteBuilder) {
		r.get('/test', () => Response.json({ ok: true }));
	}
}

class TwoGuardController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard);
		r.guard(RateLimitGuard);
		r.get('/test', () => Response.json({ ok: true }));
	}
}

// ============ BENCHMARK ============

async function singleRun(url: string, headers: HeadersInit): Promise<number> {
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		await fetch(url, { headers });
	}
	const elapsed = Bun.nanoseconds() - start;
	return elapsed / ITERATIONS;
}

async function benchmark(name: string, url: string, headers: HeadersInit): Promise<number> {
	for (let i = 0; i < WARMUP; i++) {
		await fetch(url, { headers });
	}

	const results: number[] = [];
	for (let run = 0; run < RUNS; run++) {
		results.push(await singleRun(url, headers));
	}

	results.sort((a, b) => a - b);
	const trimmed = results.slice(1, -1);
	const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
	const avgMs = avg / 1_000_000;
	const rps = Math.round(1000 / avgMs);

	console.log(
		`${name.padEnd(20)} ${avgMs.toFixed(3).padStart(8)} ms/req  ${rps.toLocaleString().padStart(8)} req/sec`
	);
	return avg;
}

// ============ MAIN ============

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║   Bun.serve() vs OriJS Framework Overhead                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

const headers = { Authorization: 'Bearer test-token' };

// Raw Bun.serve()
const bunServer = Bun.serve({
	port: 9980,
	fetch(req) {
		return Response.json({ ok: true });
	}
});

// OriJS no guards
const app0 = new Application();
app0.controller('/api', NoGuardController);
const server0 = await app0.listen(9981);

// OriJS with 2 guards
const app2 = new Application();
app2.controller('/api', TwoGuardController);
const server2 = await app2.listen(9982);

await new Promise((r) => setTimeout(r, 500));

console.log(
	`Warmup: ${WARMUP.toLocaleString()}, Iterations/run: ${ITERATIONS.toLocaleString()}, Runs: ${RUNS}\n`
);

const tBun = await benchmark('Raw Bun.serve()', 'http://localhost:9980/', headers);
const tOri0 = await benchmark('OriJS (0 guards)', 'http://localhost:9981/api/test', headers);
const tOri2 = await benchmark('OriJS (2 guards)', 'http://localhost:9982/api/test', headers);

bunServer.stop();
server0.stop();
server2.stop();

console.log('\n=== Analysis ===\n');

const frameworkOverhead = tOri0 - tBun;
const guardOverhead = tOri2 - tOri0;
const totalOverhead = tOri2 - tBun;

console.log(`Raw Bun.serve():         ${(tBun / 1_000_000).toFixed(3)} ms/req (baseline)`);
console.log(
	`OriJS framework:         +${(frameworkOverhead / 1000).toFixed(1)} µs (+${((frameworkOverhead / tBun) * 100).toFixed(1)}%)`
);
console.log(
	`Guards (2):              +${(guardOverhead / 1000).toFixed(1)} µs (+${((guardOverhead / tOri0) * 100).toFixed(1)}%)`
);
console.log(
	`Total overhead:          +${(totalOverhead / 1000).toFixed(1)} µs (+${((totalOverhead / tBun) * 100).toFixed(1)}%)`
);
