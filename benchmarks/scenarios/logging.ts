/**
 * Logger performance benchmark - tests async buffering vs sync logging.
 *
 * Run: bun benchmarks/scenarios/logging.ts
 */

import { Logger } from '@orijs/orijs';

console.log('=== Logger Buffering Benchmark ===\n');

// Test 1: Async buffered (default)
Logger.reset();
Logger.configure({ level: 'debug', async: true, bufferSize: 4096 });
const asyncLogger = new Logger('AsyncTest');

const asyncIterations = 50000;
console.log(`Async buffered: ${asyncIterations} logs...`);
const asyncStart = performance.now();
for (let i = 0; i < asyncIterations; i++) {
	asyncLogger.info('Test message', { i, data: 'some value' });
}
Logger.flush();
const asyncElapsed = performance.now() - asyncStart;
console.log(`  Time: ${asyncElapsed.toFixed(0)}ms`);
console.log(`  Throughput: ${(asyncIterations / (asyncElapsed / 1000)).toFixed(0)} logs/sec\n`);

// Test 2: Sync (for comparison)
Logger.reset();
Logger.configure({ level: 'debug', async: false });
const syncLogger = new Logger('SyncTest');

const syncIterations = 10000;
console.log(`Sync direct: ${syncIterations} logs...`);
const syncStart = performance.now();
for (let i = 0; i < syncIterations; i++) {
	syncLogger.info('Test message', { i, data: 'some value' });
}
const syncElapsed = performance.now() - syncStart;
console.log(`  Time: ${syncElapsed.toFixed(0)}ms`);
console.log(`  Throughput: ${(syncIterations / (syncElapsed / 1000)).toFixed(0)} logs/sec\n`);

// Test 3: Error level only (should skip most logs)
Logger.reset();
Logger.configure({ level: 'error', async: true });
const errorLogger = new Logger('ErrorTest');

const errorIterations = 100000;
console.log(`Error level only (skipped): ${errorIterations} info calls...`);
const errorStart = performance.now();
for (let i = 0; i < errorIterations; i++) {
	errorLogger.info('This should be skipped', { i });
}
const errorElapsed = performance.now() - errorStart;
console.log(`  Time: ${errorElapsed.toFixed(0)}ms`);
console.log(`  Throughput: ${(errorIterations / (errorElapsed / 1000)).toFixed(0)} calls/sec`);
console.log(`  (Represents max framework overhead when logging is filtered)\n`);

await Logger.shutdown();
console.log('Benchmark complete.');
