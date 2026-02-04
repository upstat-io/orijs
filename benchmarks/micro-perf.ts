/**
 * Micro-benchmarks to isolate specific performance overhead.
 * Run: bun benchmarks/micro-perf.ts
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const ITERATIONS = 100_000;
const WARMUP = 10_000;

interface BenchResult {
	name: string;
	avgNs: number;
	ops: number;
}

async function bench(name: string, fn: () => void | Promise<void>): Promise<BenchResult> {
	// Warmup
	for (let i = 0; i < WARMUP; i++) {
		await fn();
	}

	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		await fn();
	}
	const elapsed = Bun.nanoseconds() - start;
	const avgNs = elapsed / ITERATIONS;
	const ops = Math.round(1_000_000_000 / avgNs);

	console.log(
		`${name.padEnd(45)} ${avgNs.toFixed(0).padStart(8)} ns/op  ${ops.toLocaleString().padStart(12)} ops/sec`
	);
	return { name, avgNs, ops };
}

console.log('\n╔═════════════════════════════════════════════════════════════════════════════╗');
console.log('║   Micro-Benchmarks: Isolating Framework Overhead                            ║');
console.log('╚═════════════════════════════════════════════════════════════════════════════╝\n');
console.log(`Iterations: ${ITERATIONS.toLocaleString()}\n`);

// ============ UUID Generation ============

console.log('--- UUID Generation ---\n');

await bench('crypto.randomUUID()', () => {
	crypto.randomUUID();
});

await bench('crypto.randomUUID() x2 (trace context)', () => {
	crypto.randomUUID();
	crypto.randomUUID();
});

// ============ AsyncLocalStorage ============

console.log('\n--- AsyncLocalStorage ---\n');

const storage = new AsyncLocalStorage<{ id: string }>();

await bench('AsyncLocalStorage.run() - sync function', () => {
	storage.run({ id: 'test' }, () => {
		// Empty
	});
});

await bench('AsyncLocalStorage.run() - async function', async () => {
	await storage.run({ id: 'test' }, async () => {
		// Empty
	});
});

await bench('AsyncLocalStorage.getStore()', () => {
	storage.getStore();
});

// With data access
await bench('ALS.run() + getStore() + access', () => {
	storage.run({ id: 'test' }, () => {
		const store = storage.getStore();
		const _ = store?.id;
	});
});

// ============ Header Parsing ============

console.log('\n--- Header Parsing ---\n');

const headers = new Headers({
	'content-type': 'application/json',
	authorization: 'Bearer token123',
	'x-request-id': 'req-123-456-789',
	traceparent: '00-abc123def456-span789-01'
});

await bench('headers.get() - single header', () => {
	headers.get('x-request-id');
});

await bench('headers.get() x3 - correlation check', () => {
	headers.get('x-correlation-id') ?? headers.get('x-request-id') ?? 'default';
});

await bench('headers.get() + split() - traceparent', () => {
	const tp = headers.get('traceparent');
	if (tp) {
		tp.split('-');
	}
});

// ============ Object Creation ============

console.log('\n--- Object Creation ---\n');

await bench('Object literal - simple', () => {
	const _ = { id: 'test', value: 123 };
});

await bench('Object literal - context shape', () => {
	const _ = {
		log: null,
		correlationId: 'test-123',
		trace: { traceId: 'abc', spanId: 'def' }
	};
});

await bench('Object literal - spread', () => {
	const base = { a: 1, b: 2 };
	const _ = { ...base, c: 3 };
});

// ============ Response Creation ============

console.log('\n--- Response Creation ---\n');

const cachedBody = '{"ok":true}';
const cachedHeaders = { 'Content-Type': 'application/json' };

await bench('new Response() - minimal', () => {
	new Response(cachedBody);
});

await bench('new Response() - with status', () => {
	new Response(cachedBody, { status: 200 });
});

await bench('new Response() - with headers object', () => {
	new Response(cachedBody, { status: 200, headers: cachedHeaders });
});

await bench('JSON.stringify() - small object', () => {
	JSON.stringify({ ok: true });
});

await bench('JSON.stringify() - medium object', () => {
	JSON.stringify({ ok: true, id: 123, name: 'test', items: [1, 2, 3] });
});

// ============ Full Request Context Simulation ============

console.log('\n--- Full Request Simulation ---\n');

// Simulate what happens per request
await bench('Full: UUID + ALS.run() + Response', async () => {
	const correlationId = crypto.randomUUID();
	await storage.run({ id: correlationId }, async () => {
		new Response('{"ok":true}', { status: 200, headers: cachedHeaders });
	});
});

await bench('Full: No UUID + ALS.run() + Response', async () => {
	await storage.run({ id: 'static-id' }, async () => {
		new Response('{"ok":true}', { status: 200, headers: cachedHeaders });
	});
});

await bench('Full: Just Response (no ALS)', () => {
	new Response('{"ok":true}', { status: 200, headers: cachedHeaders });
});

// ============ Summary ============

console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
console.log('Key findings:');
console.log('- UUID generation: ~X ns per call');
console.log('- AsyncLocalStorage: ~X ns overhead');
console.log('- Response creation: ~X ns');
console.log('');
