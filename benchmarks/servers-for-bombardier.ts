/**
 * Start all servers for bombardier benchmarking.
 * Run: bun benchmarks/servers-for-bombardier.ts
 * Then use bombardier to test each port.
 */
import { Application } from '../packages/core/src/index.ts';
import type { OriController, RouteBuilder, RequestContext, Guard } from '../packages/core/src/index.ts';

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
		r.get('/test', () => Response.json({ ok: true }));
	}
}

// ============ START SERVERS ============

// Port 9980: Raw Bun.serve()
const bunServer = Bun.serve({
	port: 9980,
	fetch() {
		return Response.json({ ok: true });
	}
});

// Port 9981: OriJS no guards
const app0 = new Application();
app0.controller('/api', NoGuardController);
await app0.listen(9981);

// Port 9982: OriJS with 2 guards
const app2 = new Application();
app2.controller('/api', TwoGuardController);
await app2.listen(9982);

console.log('Servers ready:');
console.log('  Port 9980: Raw Bun.serve()     → bombardier -d 10s http://localhost:9980/');
console.log('  Port 9981: OriJS (0 guards)    → bombardier -d 10s http://localhost:9981/api/test');
console.log(
	'  Port 9982: OriJS (2 guards)    → bombardier -d 10s -H "Authorization: Bearer test-token" http://localhost:9982/api/test'
);
console.log('\nPress Ctrl+C to stop');

// Keep alive
await new Promise(() => {});
