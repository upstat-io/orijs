#!/usr/bin/env bun
/**
 * Run all OriJS benchmarks and generate a summary report.
 *
 * Usage:
 *   bun benchmarks/run-all.ts           # Run all benchmarks
 *   bun benchmarks/run-all.ts --quick   # Run with fewer requests
 */

import { $ } from 'bun';

const _isQuick = process.argv.includes('--quick'); // TODO: pass to scenarios

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║               OriJS Benchmark Suite                          ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

const scenarios = [
	{ name: 'Raw Bun (baseline)', file: 'scenarios/raw-bun.ts' },
	{ name: 'OriJS Minimal', file: 'scenarios/orijs-minimal.ts' },
	{ name: 'OriJS with Guards', file: 'scenarios/orijs-guards.ts' },
	{ name: 'Logger Performance', file: 'scenarios/logging.ts' }
];

const results: Array<{ name: string; output: string }> = [];

for (const scenario of scenarios) {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`Running: ${scenario.name}`);
	console.log('='.repeat(60));

	try {
		const result = await $`bun ${import.meta.dir}/${scenario.file}`.text();
		console.log(result);
		results.push({ name: scenario.name, output: result });
	} catch (error) {
		console.error(`Error running ${scenario.name}:`, error);
		results.push({ name: scenario.name, output: `ERROR: ${error}` });
	}
}

console.log('\n' + '='.repeat(60));
console.log('All benchmarks complete!');
console.log('='.repeat(60));
