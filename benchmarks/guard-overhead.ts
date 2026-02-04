/**
 * Direct guard execution timing (no HTTP overhead)
 */

import type { Guard, RequestContext } from '@orijs/orijs';

// No-op guard
class NoOpGuard implements Guard {
	async canActivate(): Promise<boolean> {
		return true;
	}
}

// Simulate runGuards from request-pipeline.ts
async function runGuards(guards: Guard[], ctx: RequestContext): Promise<boolean> {
	for (const guard of guards) {
		const canActivate = await guard.canActivate(ctx);
		if (!canActivate) return false;
	}
	return true;
}

// Create mock context
const mockCtx = { request: { headers: new Headers() } } as unknown as RequestContext;

// Pre-create guard arrays
const guards0: Guard[] = [];
const guards1: Guard[] = [new NoOpGuard()];
const guards2: Guard[] = [new NoOpGuard(), new NoOpGuard()];
const guards3: Guard[] = [new NoOpGuard(), new NoOpGuard(), new NoOpGuard()];
const guards4: Guard[] = [new NoOpGuard(), new NoOpGuard(), new NoOpGuard(), new NoOpGuard()];
const guards6: Guard[] = [
	new NoOpGuard(),
	new NoOpGuard(),
	new NoOpGuard(),
	new NoOpGuard(),
	new NoOpGuard(),
	new NoOpGuard()
];

async function benchmark(name: string, guards: Guard[], iterations: number): Promise<number> {
	// Warmup
	for (let i = 0; i < 1000; i++) {
		await runGuards(guards, mockCtx);
	}

	const start = Bun.nanoseconds();
	for (let i = 0; i < iterations; i++) {
		await runGuards(guards, mockCtx);
	}
	const elapsed = Bun.nanoseconds() - start;
	const avgNs = elapsed / iterations;

	console.log(`${name.padEnd(12)} ${avgNs.toFixed(0).padStart(8)} ns/call`);
	return avgNs;
}

const ITERATIONS = 100000;

console.log('\n╔══════════════════════════════════════════╗');
console.log('║   Direct Guard Execution Timing          ║');
console.log('╚══════════════════════════════════════════╝\n');
console.log(`Iterations: ${ITERATIONS.toLocaleString()}\n`);

const t0 = await benchmark('0 guards', guards0, ITERATIONS);
const t1 = await benchmark('1 guard', guards1, ITERATIONS);
const t2 = await benchmark('2 guards', guards2, ITERATIONS);
const t3 = await benchmark('3 guards', guards3, ITERATIONS);
const t4 = await benchmark('4 guards', guards4, ITERATIONS);
const t6 = await benchmark('6 guards', guards6, ITERATIONS);

console.log('\n=== Scaling Analysis ===\n');

const perGuardCost = (t6 - t0) / 6;
console.log(`• Base cost (0 guards):     ${t0.toFixed(0)} ns`);
console.log(`• Cost with 6 guards:       ${t6.toFixed(0)} ns`);
console.log(`• Per-guard overhead:       ${perGuardCost.toFixed(0)} ns`);
console.log(`• Scaling ratio (6g/1g):    ${(t6 / t1).toFixed(2)}x`);

if (t6 > t1 * 4) {
	console.log('\n⚠️  O(n) scaling detected - each guard adds ~' + perGuardCost.toFixed(0) + 'ns');
} else {
	console.log('\n✅ Sub-linear scaling');
}

// Show linear expectation vs actual
console.log('\n=== Expected vs Actual ===\n');
console.log('Guards | Expected (O(n)) | Actual   | Diff');
console.log('───────┼─────────────────┼──────────┼──────');
const results = [t0, t1, t2, t3, t4, t6];
const counts = [0, 1, 2, 3, 4, 6];
for (let i = 0; i < results.length; i++) {
	const expected = t0 + perGuardCost * counts[i];
	const actual = results[i];
	const diff = (((actual - expected) / expected) * 100).toFixed(0);
	console.log(
		`  ${counts[i]}    | ${expected.toFixed(0).padStart(15)} | ${actual.toFixed(0).padStart(8)} | ${diff}%`
	);
}
