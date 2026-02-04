/**
 * HTTP benchmark comparing baseline vs guards.
 * Tests the ACTUAL overhead of guards in HTTP context.
 */
import { Application } from '../packages/core/src/index.ts';
import type { OriController, RouteBuilder, RequestContext, Guard } from '../packages/core/src/index.ts';

const WARMUP = 1000;
const ITERATIONS = 10000;

// ============ GUARDS ============

class AuthGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		const authHeader = ctx.request.headers.get('authorization');
		return authHeader === 'Bearer test-token';
	}
}

class RateLimitGuard implements Guard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		// CORRECT API: ctx.set(), not ctx.state.set()
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

class OneGuardController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard);
		r.get('/test', () => Response.json({ ok: true }));
	}
}

class TwoGuardController implements OriController {
	configure(r: RouteBuilder) {
		r.guard(AuthGuard);
		r.guard(RateLimitGuard);
		r.get('/test', (ctx: RequestContext) => {
			// CORRECT API: ctx.state.rateLimit or ctx.get('rateLimit')
			const rateLimit = ctx.get('rateLimit');
			return Response.json({ ok: true, rateLimit });
		});
	}
}

// ============ BENCHMARK ============

async function benchmark(name: string, url: string, headers: HeadersInit): Promise<number> {
	// Warmup
	for (let i = 0; i < WARMUP; i++) {
		await fetch(url, { headers });
	}

	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		const res = await fetch(url, { headers });
		if (!res.ok) {
			throw new Error(`Request failed: ${res.status}`);
		}
	}
	const elapsed = Bun.nanoseconds() - start;
	const avgMs = elapsed / ITERATIONS / 1_000_000;
	const rps = Math.round(1000 / avgMs);

	console.log(
		`${name.padEnd(20)} ${avgMs.toFixed(3).padStart(8)} ms/req  ${rps.toLocaleString().padStart(8)} req/sec`
	);
	return avgMs;
}

// ============ MAIN ============

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║   HTTP Guard Overhead Benchmark (Correct API)                ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

const headers = { Authorization: 'Bearer test-token' };

// Test 1: No guards
const app0 = new Application();
app0.controller('/api', NoGuardController);
const server0 = await app0.listen(9990);
const t0 = await benchmark('0 guards', 'http://localhost:9990/api/test', headers);
server0.stop();

// Test 2: 1 guard
const app1 = new Application();
app1.controller('/api', OneGuardController);
const server1 = await app1.listen(9991);
const t1 = await benchmark('1 guard (auth)', 'http://localhost:9991/api/test', headers);
server1.stop();

// Test 3: 2 guards
const app2 = new Application();
app2.controller('/api', TwoGuardController);
const server2 = await app2.listen(9992);
const t2 = await benchmark('2 guards (auth+rate)', 'http://localhost:9992/api/test', headers);
server2.stop();

console.log('\n=== Analysis ===\n');
console.log(`Baseline (0 guards):     ${t0.toFixed(3)} ms/req`);
console.log(
	`1 guard overhead:        +${(((t1 - t0) / t0) * 100).toFixed(1)}% (${((t1 - t0) * 1000).toFixed(0)} µs)`
);
console.log(
	`2 guards overhead:       +${(((t2 - t0) / t0) * 100).toFixed(1)}% (${((t2 - t0) * 1000).toFixed(0)} µs)`
);
console.log(`Per-guard overhead:      ${(((t2 - t0) / 2) * 1000).toFixed(0)} µs`);

// Also test with concurrent requests for more realistic scenario
console.log('\n=== Concurrent Requests (10 parallel) ===\n');

async function benchmarkConcurrent(
	name: string,
	url: string,
	headers: HeadersInit,
	concurrency: number
): Promise<number> {
	// Warmup
	for (let i = 0; i < 100; i++) {
		await fetch(url, { headers });
	}

	const iterations = 5000;
	const start = Bun.nanoseconds();

	for (let i = 0; i < iterations; i += concurrency) {
		const batch = Array(Math.min(concurrency, iterations - i))
			.fill(null)
			.map(() => fetch(url, { headers }));
		await Promise.all(batch);
	}

	const elapsed = Bun.nanoseconds() - start;
	const totalMs = elapsed / 1_000_000;
	const rps = Math.round(iterations / (totalMs / 1000));

	console.log(`${name.padEnd(20)} ${rps.toLocaleString().padStart(8)} req/sec`);
	return rps;
}

// Restart servers for concurrent test
const appC0 = new Application();
appC0.controller('/api', NoGuardController);
const serverC0 = await appC0.listen(9993);

const appC2 = new Application();
appC2.controller('/api', TwoGuardController);
const serverC2 = await appC2.listen(9994);

const rps0 = await benchmarkConcurrent('0 guards', 'http://localhost:9993/api/test', headers, 10);
const rps2 = await benchmarkConcurrent('2 guards', 'http://localhost:9994/api/test', headers, 10);

serverC0.stop();
serverC2.stop();

console.log(`\nConcurrent overhead:     ${(((rps0 - rps2) / rps0) * 100).toFixed(1)}%`);

console.log('\n✅ Benchmark complete\n');
