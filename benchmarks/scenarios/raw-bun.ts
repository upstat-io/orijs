/**
 * Raw Bun.serve benchmark - baseline for comparison.
 *
 * Run: bun benchmarks/scenarios/raw-bun.ts
 */

import { runBenchmark } from '../runner.ts';

const PORT = 9999;

const server = Bun.serve({
	port: PORT,
	fetch(request) {
		// Fast path extraction - avoid new URL()
		const requestUrl = request.url;
		const pathStart = requestUrl.indexOf('/', 8);
		const queryStart = requestUrl.indexOf('?', pathStart);
		const path = queryStart === -1 ? requestUrl.slice(pathStart) : requestUrl.slice(pathStart, queryStart);

		if (path === '/api/health') {
			return Response.json({ status: 'ok' });
		}
		return new Response('Not Found', { status: 404 });
	}
});

console.log('Raw Bun server ready on port ' + PORT);

await runBenchmark(`http://localhost:${PORT}/api/health`, {
	totalRequests: 20000,
	concurrency: 50
});

server.stop();
