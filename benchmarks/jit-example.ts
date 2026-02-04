/**
 * JIT Compilation Example for OriJS
 *
 * This shows how Elysia-style code generation would work.
 * Instead of runtime conditionals, we generate optimized handler code at startup.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// ============ CURRENT APPROACH (Runtime Conditionals) ============

/**
 * Current OriJS: Every request goes through these conditionals
 */
function createHandlerCurrent(config: {
	hasGuards: boolean;
	hasInterceptors: boolean;
	hasSchema: boolean;
	handler: (ctx: any) => Response;
	guards: any[];
}) {
	const { hasGuards, hasInterceptors, hasSchema, handler, guards } = config;

	// This function is called PER REQUEST - lots of conditionals
	return async (req: Request): Promise<Response> => {
		const ctx = { request: req, params: {} };
		const correlationId = req.headers.get('x-request-id') ?? crypto.randomUUID();

		// Runtime conditional #1
		if (hasGuards) {
			for (const guard of guards) {
				if (!(await guard.canActivate(ctx))) {
					return new Response('Forbidden', { status: 403 });
				}
			}
		}

		// Runtime conditional #2
		if (hasSchema) {
			// validate...
		}

		// Runtime conditional #3
		if (hasInterceptors) {
			// wrap with interceptors...
		}

		return handler(ctx);
	};
}

// ============ JIT APPROACH (Code Generation) ============

/**
 * JIT: Generate optimized code at route registration time.
 * The generated function has NO runtime conditionals for the route's specific config.
 */
function createHandlerJIT(config: {
	hasGuards: boolean;
	hasInterceptors: boolean;
	hasSchema: boolean;
	handler: (ctx: any) => Response;
	guards: any[];
}) {
	const { hasGuards, hasInterceptors, hasSchema, handler, guards } = config;

	// Build the function body as a string
	let code = '';

	// Always create context
	code += `const ctx = { request: req, params: {} };\n`;

	// Only add guard code if this route HAS guards
	if (hasGuards) {
		code += `
for (let i = 0; i < guards.length; i++) {
  if (!(await guards[i].canActivate(ctx))) {
    return new Response('Forbidden', { status: 403 });
  }
}
`;
	}
	// If no guards, NO CODE is added - zero overhead

	// Only add schema validation if this route HAS schema
	if (hasSchema) {
		code += `// schema validation code here\n`;
	}

	// Only add interceptor wrapping if this route HAS interceptors
	if (hasInterceptors) {
		code += `// interceptor wrapping code here\n`;
	}

	// Always call handler
	code += `return handler(ctx);\n`;

	// Generate the optimized function
	// The function has ONLY the code paths this specific route needs
	const fn = new Function(
		'req',
		'handler',
		'guards',
		`
return (async function optimizedHandler() {
${code}
})();
`
	);

	// Return a closure that calls the generated function
	return (req: Request): Promise<Response> => {
		return fn(req, handler, guards) as Promise<Response>;
	};
}

// ============ REAL-WORLD EXAMPLE ============

/**
 * What the generated code looks like for different route configurations:
 */

// Route with NO guards, NO schema, NO interceptors (fast path)
const fastPathCode = `
// GENERATED AT STARTUP - no conditionals at runtime
return (async function optimizedHandler() {
  const ctx = { request: req, params: {} };
  return handler(ctx);
})();
`;

// Route WITH 2 guards
const withGuardsCode = `
// GENERATED AT STARTUP - guard loop is inlined
return (async function optimizedHandler() {
  const ctx = { request: req, params: {} };

  // Guard 0: AuthGuard (inlined)
  if (!(await guards[0].canActivate(ctx))) {
    return new Response('Forbidden', { status: 403 });
  }

  // Guard 1: RateLimitGuard (inlined)
  if (!(await guards[1].canActivate(ctx))) {
    return new Response('Forbidden', { status: 403 });
  }

  return handler(ctx);
})();
`;

// Even more aggressive: inline the ACTUAL guard logic
const fullyInlinedCode = `
// ULTRA-OPTIMIZED: Guard logic itself is inlined
return (async function optimizedHandler() {
  const ctx = { request: req, params: {} };

  // AuthGuard logic inlined (no function call overhead)
  const authHeader = req.headers.get('authorization');
  if (authHeader !== 'Bearer test-token') {
    return new Response('Forbidden', { status: 403 });
  }

  // RateLimitGuard logic inlined
  ctx.rateLimit = { remaining: 99, limit: 100 };

  return handler(ctx);
})();
`;

// ============ BENCHMARK ============

const ITERATIONS = 100_000;
const WARMUP = 10_000;

async function bench(name: string, fn: () => void | Promise<void>): Promise<number> {
	for (let i = 0; i < WARMUP; i++) await fn();

	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) await fn();
	const elapsed = Bun.nanoseconds() - start;
	const avgNs = elapsed / ITERATIONS;

	console.log(`${name.padEnd(40)} ${avgNs.toFixed(0).padStart(6)} ns/op`);
	return avgNs;
}

// Mock handler and guards
const mockHandler = (ctx: any) => new Response('OK');
const mockGuard = { canActivate: async () => true };
const mockReq = new Request('http://localhost/test');

console.log('\n╔═══════════════════════════════════════════════════════════════╗');
console.log('║   JIT Compilation Example: Current vs Generated Code          ║');
console.log('╚═══════════════════════════════════════════════════════════════╝\n');

// Test 1: No guards - current approach
const currentNoGuards = createHandlerCurrent({
	hasGuards: false,
	hasInterceptors: false,
	hasSchema: false,
	handler: mockHandler,
	guards: []
});

// Test 2: No guards - JIT approach
const jitNoGuards = createHandlerJIT({
	hasGuards: false,
	hasInterceptors: false,
	hasSchema: false,
	handler: mockHandler,
	guards: []
});

// Test 3: With guards - current approach
const currentWithGuards = createHandlerCurrent({
	hasGuards: true,
	hasInterceptors: false,
	hasSchema: false,
	handler: mockHandler,
	guards: [mockGuard, mockGuard]
});

// Test 4: With guards - JIT approach
const jitWithGuards = createHandlerJIT({
	hasGuards: true,
	hasInterceptors: false,
	hasSchema: false,
	handler: mockHandler,
	guards: [mockGuard, mockGuard]
});

console.log('--- No Guards (Fast Path) ---\n');
const t1 = await bench('Current (runtime conditionals)', () => currentNoGuards(mockReq));
const t2 = await bench('JIT (generated code)', () => jitNoGuards(mockReq));
console.log(`\nJIT speedup: ${(((t1 - t2) / t1) * 100).toFixed(1)}%\n`);

console.log('--- With 2 Guards ---\n');
const t3 = await bench('Current (runtime conditionals)', () => currentWithGuards(mockReq));
const t4 = await bench('JIT (generated code)', () => jitWithGuards(mockReq));
console.log(`\nJIT speedup: ${(((t3 - t4) / t3) * 100).toFixed(1)}%\n`);

console.log('═══════════════════════════════════════════════════════════════════\n');
console.log('Key insight: JIT eliminates runtime conditionals by generating');
console.log('route-specific code at startup. Each route gets a custom function');
console.log('with only the code paths it actually needs.\n');

console.log('Generated code for fast path (no guards):');
console.log('─────────────────────────────────────────');
console.log(fastPathCode);

console.log('Generated code with guards (loop unrolled):');
console.log('─────────────────────────────────────────');
console.log(withGuardsCode);
