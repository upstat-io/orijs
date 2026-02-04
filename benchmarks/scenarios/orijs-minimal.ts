/**
 * Minimal OriJS benchmark - simple health endpoint, no guards/interceptors.
 *
 * Run: bun benchmarks/scenarios/orijs-minimal.ts
 */

import { Application } from '@orijs/orijs';
import type { OriController, RouteBuilder, RequestContext } from '@orijs/orijs';
import { configureBenchmarkLogger, shutdownLogger, nullTransport, runBenchmark } from '../runner.ts';

configureBenchmarkLogger();

const PORT = 9998;

class HealthController implements OriController {
	configure(r: RouteBuilder) {
		r.get('/health', this.health);
	}

	private health = (_ctx: RequestContext) => {
		return Response.json({ status: 'ok' });
	};
}

const app = new Application();
app.logger({ level: 'error', transports: [nullTransport] });
app.controller('/api', HealthController);

const server = await app.listen(PORT);
console.log('OriJS server ready on port ' + PORT);

await runBenchmark(`http://localhost:${PORT}/api/health`, {
	totalRequests: 20000,
	concurrency: 50
});

server.stop();
shutdownLogger();
