/**
 * Rigorous HTTP benchmark with multiple runs and statistics.
 */
import { Application } from '../packages/core/src/index.ts';
import type { OriController, RouteBuilder, RequestContext, Guard } from '../packages/core/src/index.ts';

const WARMUP = 2000;
const ITERATIONS = 5000;
const RUNS = 5;

// ============ GUARDS ============

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
		r.get('/test', (ctx: RequestContext) => {
			const rateLimit = ctx.get('rateLimit');
			return Response.json({ ok: true, rateLimit });
		});
	}
}

// ============ BENCHMARK ============

async function singleRun(url: string, headers: HeadersInit): Promise<number> {
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		await fetch(url, { headers });
	}
	const elapsed = Bun.nanoseconds() - start;
	return elapsed / ITERATIONS; // ns per request
}

async function benchmark(name: string, url: string, headers: HeadersInit): Promise<number> {
	// Warmup
	for (let i = 0; i < WARMUP; i++) {
		await fetch(url, { headers });
	}

	const results: number[] = [];
	for (let run = 0; run < RUNS; run++) {
		results.push(await singleRun(url, headers));
	}

	// Remove outliers (min and max), average the rest
	results.sort((a, b) => a - b);
	const trimmed = results.slice(1, -1);
	const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
	const avgMs = avg / 1_000_000;
	const rps = Math.round(1000 / avgMs);

	console.log(
		`${name.padEnd(15)} ${avgMs.toFixed(3).padStart(8)} ms/req  ${rps.toLocaleString().padStart(8)} req/sec  (runs: ${results.map((r) => (r / 1_000_000).toFixed(3)).join(', ')})`
	);
	return avg;
}

// ============ MAIN ============

console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║   Rigorous HTTP Guard Benchmark (5 runs, trimmed mean)                   ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');

const headers = { Authorization: 'Bearer test-token' };

// Setup servers
const app0 = new Application();
app0.controller('/api', NoGuardController);
const server0 = await app0.listen(9990);

const app2 = new Application();
app2.controller('/api', TwoGuardController);
const server2 = await app2.listen(9992);

// Wait for servers to stabilize
await new Promise((r) => setTimeout(r, 500));

console.log(
	`Warmup: ${WARMUP.toLocaleString()}, Iterations/run: ${ITERATIONS.toLocaleString()}, Runs: ${RUNS}\n`
);

const t0 = await benchmark('0 guards', 'http://localhost:9990/api/test', headers);
const t2 = await benchmark('2 guards', 'http://localhost:9992/api/test', headers);

server0.stop();
server2.stop();

console.log('\n=== Analysis ===\n');
const overheadNs = t2 - t0;
const overheadUs = overheadNs / 1000;
const overheadPct = (overheadNs / t0) * 100;

console.log(`Baseline (0 guards):     ${(t0 / 1_000_000).toFixed(3)} ms/req`);
console.log(`With 2 guards:           ${(t2 / 1_000_000).toFixed(3)} ms/req`);
console.log(`Guard overhead:          ${overheadUs.toFixed(1)} µs (+${overheadPct.toFixed(1)}%)`);
console.log(`Per-guard overhead:      ${(overheadUs / 2).toFixed(1)} µs`);

if (overheadPct < 5) {
	console.log('\n✅ Overhead is minimal (<5%)');
} else if (overheadPct < 15) {
	console.log('\n⚠️  Moderate overhead (5-15%)');
} else {
	console.log('\n❌ High overhead (>15%) - investigate');
}
