/**
 * Shared benchmark runner utilities for OriJS performance testing.
 */

import type { Transport, LogObject } from '@orijs/logging';
import { Logger } from '@orijs/logging';

/** Null transport that discards all logs */
export const nullTransport: Transport = {
	write(_obj: LogObject) {},
	flush: async () => {},
	close: async () => {}
};

/** Configure logger for benchmarks (error-only, no async) */
export function configureBenchmarkLogger(): void {
	Logger.configure({ level: 'error', async: false, transports: [nullTransport] });
}

/** Shutdown logger after benchmark */
export async function shutdownLogger(): Promise<void> {
	await Logger.shutdown();
}

export interface BenchmarkOptions {
	/** Total number of requests to send */
	totalRequests?: number;
	/** Number of concurrent requests per batch */
	concurrency?: number;
	/** Number of warmup iterations (each sends concurrency requests) */
	warmupIterations?: number;
	/** Headers to include in requests */
	headers?: Record<string, string>;
}

export interface BenchmarkResult {
	totalRequests: number;
	elapsedMs: number;
	throughput: number;
}

/**
 * Run a concurrent HTTP benchmark against a URL.
 */
export async function runBenchmark(url: string, options: BenchmarkOptions = {}): Promise<BenchmarkResult> {
	const { totalRequests = 10000, concurrency = 50, warmupIterations = 10, headers = {} } = options;

	// Warmup
	console.log('Warming up...');
	for (let i = 0; i < warmupIterations; i++) {
		await Promise.all(
			Array(concurrency)
				.fill(0)
				.map(() => fetch(url, { headers }))
		);
	}

	// Run benchmark
	console.log(`Running ${totalRequests} requests with concurrency ${concurrency}...`);
	const start = performance.now();
	let completed = 0;

	while (completed < totalRequests) {
		const batch = Math.min(concurrency, totalRequests - completed);
		await Promise.all(
			Array(batch)
				.fill(0)
				.map(() => fetch(url, { headers }))
		);
		completed += batch;
	}

	const elapsedMs = performance.now() - start;
	const throughput = Math.round(totalRequests / (elapsedMs / 1000));

	console.log(`Completed in ${elapsedMs.toFixed(0)}ms`);
	console.log(`Throughput: ${throughput} req/sec`);

	return { totalRequests, elapsedMs, throughput };
}

/**
 * Run multiple benchmark scenarios and report results.
 */
export async function runScenarios(
	scenarios: Array<{
		name: string;
		url: string;
		options?: BenchmarkOptions & { method?: string; body?: string };
	}>
): Promise<Map<string, BenchmarkResult>> {
	const results = new Map<string, BenchmarkResult>();

	for (const scenario of scenarios) {
		console.log(`\n=== ${scenario.name} ===`);

		const { method = 'GET', body, ...options } = scenario.options ?? {};

		const fetchOptions: RequestInit = {
			method,
			headers: options.headers
		};
		if (body) {
			fetchOptions.body = body;
		}

		// Custom runner for non-GET methods
		if (method !== 'GET' || body) {
			const result = await runBenchmarkWithOptions(scenario.url, fetchOptions, options);
			results.set(scenario.name, result);
		} else {
			const result = await runBenchmark(scenario.url, options);
			results.set(scenario.name, result);
		}
	}

	return results;
}

async function runBenchmarkWithOptions(
	url: string,
	fetchOptions: RequestInit,
	options: BenchmarkOptions = {}
): Promise<BenchmarkResult> {
	const { totalRequests = 10000, concurrency = 50, warmupIterations = 10 } = options;

	// Warmup
	console.log('Warming up...');
	for (let i = 0; i < warmupIterations; i++) {
		await Promise.all(
			Array(concurrency)
				.fill(0)
				.map(() => fetch(url, fetchOptions))
		);
	}

	// Run benchmark
	console.log(`Running ${totalRequests} requests with concurrency ${concurrency}...`);
	const start = performance.now();
	let completed = 0;

	while (completed < totalRequests) {
		const batch = Math.min(concurrency, totalRequests - completed);
		await Promise.all(
			Array(batch)
				.fill(0)
				.map(() => fetch(url, fetchOptions))
		);
		completed += batch;
	}

	const elapsedMs = performance.now() - start;
	const throughput = Math.round(totalRequests / (elapsedMs / 1000));

	console.log(`Completed in ${elapsedMs.toFixed(0)}ms`);
	console.log(`Throughput: ${throughput} req/sec`);

	return { totalRequests, elapsedMs, throughput };
}

/**
 * Print a summary table of benchmark results.
 */
export function printSummary(results: Map<string, BenchmarkResult>): void {
	console.log('\n=== Summary ===');
	console.log('Scenario'.padEnd(40) + 'Throughput'.padStart(15));
	console.log('-'.repeat(55));

	for (const [name, result] of results) {
		console.log(name.padEnd(40) + `${result.throughput} req/sec`.padStart(15));
	}
}
