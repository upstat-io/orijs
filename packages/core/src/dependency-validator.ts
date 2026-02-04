import type { Constructor, InjectionToken } from './types/index';
import { throwFrameworkError } from './framework-error';

/**
 * Validates dependency injection graph at startup.
 * Detects missing dependencies, circular dependencies, and missing external packages.
 */
export class DependencyValidator {
	/** Cache for package installation checks (avoids repeated Bun.resolveSync calls) */
	private packageCache = new Map<string, boolean>();

	/**
	 * Validates the dependency graph.
	 * Throws an error if:
	 * - A service declares dependencies that aren't registered
	 * - A service declares fewer dependencies than its constructor requires
	 * - Circular dependencies exist in the graph
	 * - External npm packages are not installed
	 *
	 * @param registry - Map of tokens to their dependencies
	 * @param instances - Map of tokens to their instances (for skipping pre-instantiated services)
	 * @param externalDeps - Map of services to their external package requirements
	 */
	public validate(
		registry: Map<InjectionToken, Constructor[]>,
		instances: Map<InjectionToken, unknown>,
		externalDeps: Map<Constructor, string[]>
	): void {
		const errors: string[] = [];

		for (const [token, deps] of registry) {
			// Skip token-based providers (symbols/strings) - they're always pre-instantiated
			if (!this.isConstructor(token)) {
				continue;
			}

			const service = token;

			// Skip services registered via registerInstance - they already have instances
			// and don't need constructor validation
			if (instances.has(service)) {
				continue;
			}

			// Check that all declared dependencies are registered
			for (const dep of deps) {
				if (!registry.has(dep)) {
					// Handle token-based dependencies (symbols/strings)
					const depName = this.getTokenName(dep);
					const isToken = typeof dep === 'symbol' || typeof dep === 'string';

					if (isToken) {
						errors.push(
							`${service.name} depends on token '${depName}', but it's not registered.\n` +
								`\n` +
								`     Fix: Register the token with a pre-created instance:\n` +
								`       .providerInstance(${depName}, instance)`
						);
					} else {
						errors.push(
							`${service.name} depends on ${depName}, but ${depName} is not registered as a provider.\n` +
								`\n` +
								`     Fix: Register ${depName} as a provider:\n` +
								`       .provider(${depName}, [/* dependencies */])\n` +
								`\n` +
								`     Or if ${depName} is pre-instantiated (e.g., from config):\n` +
								`       .providerInstance(${depName}, new ${depName}(...))`
						);
					}
				}
			}

			// Check constructor parameter count matches declared deps
			const constructorParamCount = service.length;

			if (deps.length < constructorParamCount) {
				const constructorParams = this.extractConstructorParams(service);
				const declaredNames = deps.map((d) => this.getTokenName(d));
				const missingParams = constructorParams.slice(deps.length);
				const allDepsPlaceholder = constructorParams.map((_, i) => `Dep${i + 1}`).join(', ');

				errors.push(
					`${service.name} has missing dependencies:\n` +
						`     Constructor: (${constructorParams.join(', ')})\n` +
						`     Declared:    [${declaredNames.join(', ') || 'none'}]\n` +
						`     Missing:     ${missingParams.join(', ')}\n` +
						`\n` +
						`     Fix: Update the provider registration to include all dependencies:\n` +
						`       .provider(${service.name}, [${allDepsPlaceholder}])\n` +
						`\n` +
						`     Common mistakes:\n` +
						`       - Dependencies listed in wrong order (must match constructor order)\n` +
						`       - Forgot to add a newly added constructor parameter`
				);
			}
		}

		// Detect circular dependencies using DFS
		const cycles = this.detectCycles(registry);
		for (const cycle of cycles) {
			const cycleStr = cycle.map((s) => s.name).join(' -> ');
			errors.push(
				`Circular dependency detected: ${cycleStr}\n` +
					`\n` +
					`     Fix options:\n` +
					`       1. Extract shared logic into a new service that both can depend on\n` +
					`       2. Use an event/callback pattern instead of direct dependency\n` +
					`       3. Inject one service lazily via a factory function`
			);
		}

		// Validate external npm package dependencies
		for (const [service, packages] of externalDeps) {
			for (const pkg of packages) {
				if (!this.isPackageInstalled(pkg)) {
					errors.push(
						`${service.name} requires npm package '${pkg}', but it's not installed.\n` +
							`     Fix: Run 'bun add ${pkg}' or 'npm install ${pkg}'`
					);
				}
			}
		}

		if (errors.length > 0) {
			throwFrameworkError(
				`Dependency injection validation failed:\n\n` +
					errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n') +
					`\n\nFix: Register missing providers with .provider(ServiceClass, [Dep1, Dep2, ...])`
			);
		}
	}

	/**
	 * Detects circular dependencies using depth-first search.
	 * Returns array of cycles found (each cycle is array of services in the cycle).
	 * Uses O(V+E) algorithm where V=services, E=dependencies.
	 * Only checks Constructor tokens (symbols/strings can't have circular deps).
	 */
	private detectCycles(registry: Map<InjectionToken, Constructor[]>): Constructor[][] {
		const cycles: Constructor[][] = [];
		const visited = new Set<Constructor>();
		const recursionStack = new Set<Constructor>();
		const path: Constructor[] = [];

		const detectCycleFrom = (service: Constructor): void => {
			if (recursionStack.has(service)) {
				// Found a cycle - extract it from the path
				const cycleStart = path.indexOf(service);
				if (cycleStart !== -1) {
					cycles.push([...path.slice(cycleStart), service]);
				}
				return;
			}

			if (visited.has(service)) {
				return;
			}

			visited.add(service);
			recursionStack.add(service);
			path.push(service);

			const deps = registry.get(service) || [];
			for (const dep of deps) {
				// Skip token-based deps (symbols/strings) - they can't form cycles
				// as they're always pre-instantiated
				if (!this.isConstructor(dep)) {
					continue;
				}
				// Only check deps that are registered (unregistered deps are caught separately)
				if (registry.has(dep)) {
					detectCycleFrom(dep);
				}
			}

			path.pop();
			recursionStack.delete(service);
		};

		for (const token of registry.keys()) {
			// Only check Constructor tokens for cycles
			if (this.isConstructor(token) && !visited.has(token)) {
				detectCycleFrom(token);
			}
		}

		return cycles;
	}

	/**
	 * Extracts constructor parameter names from a class for error messages.
	 * Uses toString() parsing - works for most class definitions.
	 *
	 * @limitation Relies on parsing class source as a string. If code is minified,
	 * parameter names will be shortened (e.g., `a`, `b`, `c`) and error messages
	 * will show minified names. This only affects error message quality, not
	 * functionality. Server-side code is typically not minified.
	 */
	private extractConstructorParams(service: Constructor): string[] {
		const str = service.toString();
		const constructorMatch = str.match(/constructor\s*\(([^)]*)\)/);
		if (!constructorMatch || !constructorMatch[1]) {
			return Array.from({ length: service.length }, (_, i) => `param${i + 1}`);
		}

		const paramsStr = constructorMatch[1].trim();
		if (!paramsStr) return [];

		return paramsStr
			.split(',')
			.map((p) => {
				// Handle "private foo: FooService" or "foo: FooService" or "foo"
				const cleaned =
					p
						.trim()
						.replace(/^(private|public|protected|readonly)\s+/, '')
						.split(':')[0]
						?.trim() || '';
				return cleaned;
			})
			.filter(Boolean);
	}

	/**
	 * Checks if an npm package is installed and resolvable.
	 * Uses Bun.resolveSync for fast synchronous resolution.
	 * Results are cached to avoid repeated resolution during validation.
	 */
	private isPackageInstalled(packageName: string): boolean {
		// Check cache first to avoid repeated Bun.resolveSync calls
		const cached = this.packageCache.get(packageName);
		if (cached !== undefined) {
			return cached;
		}

		try {
			// Bun.resolveSync throws if package not found
			Bun.resolveSync(packageName, process.cwd());
			this.packageCache.set(packageName, true);
			return true;
		} catch {
			this.packageCache.set(packageName, false);
			return false;
		}
	}

	/** Checks if a token is a Constructor (class) rather than a symbol/string */
	private isConstructor(token: InjectionToken): token is Constructor {
		return typeof token === 'function';
	}

	/** Gets a readable name for a token (for error messages) */
	private getTokenName(token: InjectionToken): string {
		if (typeof token === 'symbol') return token.description ?? 'Symbol';
		if (typeof token === 'string') return token;
		return (token as Constructor).name;
	}

	/** Returns the number of cached package resolution results (for testing). */
	public getPackageCacheSize(): number {
		return this.packageCache.size;
	}

	/** Clears the package cache. */
	public clearPackageCache(): void {
		this.packageCache.clear();
	}
}
