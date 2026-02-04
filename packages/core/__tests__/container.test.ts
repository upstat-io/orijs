import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Container } from '../src/container.ts';

// Enable debug mode so FrameworkError throws instead of process.exit
// This allows tests to catch validation errors
const originalDebug = process.env.ORIJS_DEBUG;
process.env.ORIJS_DEBUG = 'true';

// Cleanup after all tests
afterAll(() => {
	if (originalDebug === undefined) {
		delete process.env.ORIJS_DEBUG;
	} else {
		process.env.ORIJS_DEBUG = originalDebug;
	}
});

describe('Container', () => {
	let container: Container;

	beforeEach(() => {
		container = new Container();
	});

	describe('register', () => {
		test('should register service without dependencies', () => {
			class SimpleService {}
			container.register(SimpleService);
			expect(container.has(SimpleService)).toBe(true);
		});

		test('should register service with dependencies', () => {
			class DepA {}
			class ServiceB {
				constructor(public dep: DepA) {}
			}
			container.register(DepA);
			container.register(ServiceB, [DepA]);
			expect(container.has(ServiceB)).toBe(true);
		});
	});

	describe('resolve', () => {
		test('should instantiate service with injected dependencies', () => {
			class DatabaseService {
				getConnection() {
					return 'connected';
				}
			}
			class UserService {
				constructor(public db: DatabaseService) {}
			}

			container.register(DatabaseService);
			container.register(UserService, [DatabaseService]);

			const userService = container.resolve(UserService);

			expect(userService).toBeInstanceOf(UserService);
			expect(userService.db).toBeInstanceOf(DatabaseService);
			expect(userService.db.getConnection()).toBe('connected');
		});

		test('should return same instance on multiple resolves (singleton)', () => {
			class SingletonService {}
			container.register(SingletonService);

			const first = container.resolve(SingletonService);
			const second = container.resolve(SingletonService);

			expect(first).toBe(second);
		});

		test('should throw when resolving unregistered service', () => {
			class UnregisteredService {}

			expect(() => container.resolve(UnregisteredService)).toThrow(
				'Service UnregisteredService is not registered'
			);
		});

		test('should include fix suggestions when resolving unregistered service', () => {
			class UnregisteredService {}

			expect(() => container.resolve(UnregisteredService)).toThrow('.provider(UnregisteredService');
			expect(() => container.resolve(UnregisteredService)).toThrow('.providerInstance(UnregisteredService');
		});

		test('should include fix suggestions for unregistered token', () => {
			const ConfigToken = Symbol('Config');

			expect(() => container.resolve(ConfigToken)).toThrow('Token Symbol(Config) is not registered');
			expect(() => container.resolve(ConfigToken)).toThrow('registerInstance');
			expect(() => container.resolve(ConfigToken)).toThrow('providerInstance');
		});

		test('should throw on circular dependencies', () => {
			class ServiceA {
				constructor(public b: ServiceB) {}
			}
			class ServiceB {
				constructor(public a: ServiceA) {}
			}

			container.register(ServiceA, [ServiceB]);
			container.register(ServiceB, [ServiceA]);

			expect(() => container.resolve(ServiceA)).toThrow('Circular dependency detected');
		});

		test('should resolve transitive dependencies', () => {
			class ConfigService {
				value = 'config';
			}
			class LogService {
				constructor(public config: ConfigService) {}
			}
			class AppService {
				constructor(public log: LogService) {}
			}

			container.register(ConfigService);
			container.register(LogService, [ConfigService]);
			container.register(AppService, [LogService]);

			const app = container.resolve(AppService);

			expect(app.log.config.value).toBe('config');
		});
	});

	describe('registerInstance', () => {
		test('should use pre-created instance', () => {
			class ConfigService {
				constructor(public value: string) {}
			}
			const config = new ConfigService('test-value');

			container.registerInstance(ConfigService, config);
			const resolved = container.resolve(ConfigService);

			expect(resolved).toBe(config);
			expect(resolved.value).toBe('test-value');
		});

		test('should skip constructor validation for registered instances', () => {
			// This service has a constructor parameter, but we're providing
			// an instance directly, so validation should skip it
			class DatabaseConnection {
				constructor(public connectionString: string) {}
				query() {
					return 'result';
				}
			}

			class ServiceUsingDb {
				constructor(public db: DatabaseConnection) {}
			}

			// Register pre-instantiated database connection
			const dbConnection = new DatabaseConnection('postgres://...');
			container.registerInstance(DatabaseConnection, dbConnection);

			// Register service that depends on it
			container.register(ServiceUsingDb, [DatabaseConnection]);

			// Validation should pass (not complain about DatabaseConnection's missing 'connectionString')
			expect(() => container.validate()).not.toThrow();

			// And resolution should work
			const service = container.resolve(ServiceUsingDb);
			expect(service.db).toBe(dbConnection);
		});
	});

	describe('has', () => {
		test('should return true for registered service', () => {
			class TestService {}
			container.register(TestService);
			expect(container.has(TestService)).toBe(true);
		});

		test('should return false for unregistered service', () => {
			class TestService {}
			expect(container.has(TestService)).toBe(false);
		});
	});

	describe('clearInstances', () => {
		test('should preserve registrations but clear instances', () => {
			class TestService {
				id = Math.random();
			}
			container.register(TestService);
			const first = container.resolve(TestService);

			container.clearInstances();

			expect(container.has(TestService)).toBe(true);
			const second = container.resolve(TestService);
			expect(second).not.toBe(first);
		});
	});

	describe('clear', () => {
		test('should remove all registrations and instances', () => {
			class TestService {}
			container.register(TestService);
			container.resolve(TestService);

			container.clear();

			expect(container.has(TestService)).toBe(false);
		});
	});

	describe('validate', () => {
		test('should pass when all dependencies are registered', () => {
			class DepA {}
			class DepB {}
			class ServiceC {
				constructor(
					public a: DepA,
					public b: DepB
				) {}
			}

			container.register(DepA);
			container.register(DepB);
			container.register(ServiceC, [DepA, DepB]);

			expect(() => container.validate()).not.toThrow();
		});

		test('should throw when dependency is not registered', () => {
			class UnregisteredDep {}
			class ServiceA {
				constructor(public dep: UnregisteredDep) {}
			}

			container.register(ServiceA, [UnregisteredDep]);

			expect(() => container.validate()).toThrow(
				'ServiceA depends on UnregisteredDep, but UnregisteredDep is not registered'
			);
		});

		test('should include fix suggestions for missing dependency', () => {
			class UnregisteredDep {}
			class ServiceA {
				constructor(public dep: UnregisteredDep) {}
			}

			container.register(ServiceA, [UnregisteredDep]);

			expect(() => container.validate()).toThrow('.provider(UnregisteredDep');
			expect(() => container.validate()).toThrow('.providerInstance(UnregisteredDep');
		});

		test('should throw when declared deps are fewer than constructor params', () => {
			class DepA {}
			class DepB {}
			class ServiceWithTwoDeps {
				constructor(
					public a: DepA,
					public b: DepB
				) {}
			}

			container.register(DepA);
			// Intentionally wrong deps to test runtime validation (bypass compile-time check)
			container.register(ServiceWithTwoDeps, [DepA] as any);

			expect(() => container.validate()).toThrow('ServiceWithTwoDeps has missing dependencies');
			expect(() => container.validate()).toThrow('Missing:     b');
		});

		test('should include fix suggestions for missing constructor deps', () => {
			class DepA {}
			class DepB {}
			class ServiceWithTwoDeps {
				constructor(
					public a: DepA,
					public b: DepB
				) {}
			}

			container.register(DepA);
			container.register(ServiceWithTwoDeps, [DepA] as any);

			expect(() => container.validate()).toThrow('Fix: Update the provider registration');
			expect(() => container.validate()).toThrow('Common mistakes:');
			expect(() => container.validate()).toThrow('Dependencies listed in wrong order');
		});

		test('should report multiple errors at once', () => {
			class MissingDepA {}
			class MissingDepB {}
			class ServiceX {
				constructor(
					public a: MissingDepA,
					public b: MissingDepB
				) {}
			}

			container.register(ServiceX, [MissingDepA, MissingDepB]);

			expect(() => container.validate()).toThrow(/1\./);
			expect(() => container.validate()).toThrow(/2\./);
			expect(() => container.validate()).toThrow('MissingDepA is not registered');
			expect(() => container.validate()).toThrow('MissingDepB is not registered');
		});

		test('should pass for services with no dependencies', () => {
			class SimpleService {}
			container.register(SimpleService);

			expect(() => container.validate()).not.toThrow();
		});

		test('should detect circular dependencies at startup', () => {
			class ServiceA {
				constructor(public b: ServiceB) {}
			}
			class ServiceB {
				constructor(public a: ServiceA) {}
			}

			container.register(ServiceA, [ServiceB]);
			container.register(ServiceB, [ServiceA]);

			expect(() => container.validate()).toThrow('Circular dependency');
			expect(() => container.validate()).toThrow('ServiceA -> ServiceB -> ServiceA');
		});

		test('should include fix suggestions for circular dependency', () => {
			class ServiceA {
				constructor(public b: ServiceB) {}
			}
			class ServiceB {
				constructor(public a: ServiceA) {}
			}

			container.register(ServiceA, [ServiceB]);
			container.register(ServiceB, [ServiceA]);

			expect(() => container.validate()).toThrow('Fix options:');
			expect(() => container.validate()).toThrow('Extract shared logic into a new service');
			expect(() => container.validate()).toThrow('event/callback pattern');
		});

		test('should detect longer circular dependency chains', () => {
			class ServiceA {
				constructor(public b: ServiceB) {}
			}
			class ServiceB {
				constructor(public c: ServiceC) {}
			}
			class ServiceC {
				constructor(public a: ServiceA) {}
			}

			container.register(ServiceA, [ServiceB]);
			container.register(ServiceB, [ServiceC]);
			container.register(ServiceC, [ServiceA]);

			expect(() => container.validate()).toThrow('Circular dependency');
		});

		test('should pass for deep but non-circular chains', () => {
			class Level1 {}
			class Level2 {
				constructor(public l1: Level1) {}
			}
			class Level3 {
				constructor(public l2: Level2) {}
			}
			class Level4 {
				constructor(public l3: Level3) {}
			}
			class Level5 {
				constructor(public l4: Level4) {}
			}

			container.register(Level1);
			container.register(Level2, [Level1]);
			container.register(Level3, [Level2]);
			container.register(Level4, [Level3]);
			container.register(Level5, [Level4]);

			expect(() => container.validate()).not.toThrow();
		});
	});

	describe('registerWithExternal', () => {
		test('should register service with external dependencies', () => {
			class CacheService {}
			container.registerWithExternal(CacheService, [], ['ioredis']);

			expect(container.has(CacheService)).toBe(true);
		});

		test('should register service with both internal and external dependencies', () => {
			class ConfigService {}
			class CacheService {
				constructor(public config: ConfigService) {}
			}

			container.register(ConfigService);
			container.registerWithExternal(CacheService, [ConfigService], ['ioredis']);

			expect(container.has(CacheService)).toBe(true);
			expect(container.has(ConfigService)).toBe(true);
		});

		test('should validate passes when external package is installed', () => {
			// 'bun:test' is always available in Bun environment
			class TestService {}
			container.registerWithExternal(TestService, [], ['typescript']);

			expect(() => container.validate()).not.toThrow();
		});

		test('should validate fails when external package is not installed', () => {
			class CacheService {}
			container.registerWithExternal(CacheService, [], ['nonexistent-package-xyz-12345']);

			expect(() => container.validate()).toThrow(
				"CacheService requires npm package 'nonexistent-package-xyz-12345', but it's not installed"
			);
			expect(() => container.validate()).toThrow('bun add nonexistent-package-xyz-12345');
		});

		test('should include fix suggestion in missing external package error', () => {
			class CacheService {}
			container.registerWithExternal(CacheService, [], ['nonexistent-package-xyz-12345']);

			expect(() => container.validate()).toThrow('npm install nonexistent-package-xyz-12345');
		});

		test('should report multiple missing external packages', () => {
			class QueueService {}
			container.registerWithExternal(
				QueueService,
				[],
				['nonexistent-pkg-a-12345', 'nonexistent-pkg-b-12345']
			);

			expect(() => container.validate()).toThrow('nonexistent-pkg-a-12345');
			expect(() => container.validate()).toThrow('nonexistent-pkg-b-12345');
		});

		test('should report missing external packages from multiple services', () => {
			class ServiceA {}
			class ServiceB {}

			container.registerWithExternal(ServiceA, [], ['missing-for-a-12345']);
			container.registerWithExternal(ServiceB, [], ['missing-for-b-12345']);

			expect(() => container.validate()).toThrow("ServiceA requires npm package 'missing-for-a-12345'");
			expect(() => container.validate()).toThrow("ServiceB requires npm package 'missing-for-b-12345'");
		});

		test('should clear external dependencies on container.clear()', () => {
			class CacheService {}
			container.registerWithExternal(CacheService, [], ['nonexistent-pkg-12345']);

			container.clear();

			// After clear, validation should pass (no services to validate)
			expect(() => container.validate()).not.toThrow();
			expect(container.has(CacheService)).toBe(false);
		});

		test('should combine internal and external validation errors', () => {
			class MissingDep {}
			class ServiceWithBothIssues {
				constructor(public dep: MissingDep) {}
			}

			container.registerWithExternal(ServiceWithBothIssues, [MissingDep], ['nonexistent-external-12345']);

			// Should report both the missing internal dependency and the missing external package
			expect(() => container.validate()).toThrow('MissingDep is not registered');
			expect(() => container.validate()).toThrow('nonexistent-external-12345');
		});
	});

	describe('async constructor support', () => {
		test('resolve() should throw error when constructor returns Promise', () => {
			class AsyncIIFEService {
				public initialized = false;
				constructor() {
					return (async () => {
						await Promise.resolve();
						this.initialized = true;
						return this;
					})() as unknown as AsyncIIFEService;
				}
			}

			container.register(AsyncIIFEService);

			expect(() => container.resolve(AsyncIIFEService)).toThrow('AsyncIIFEService has an async constructor');
			expect(() => container.resolve(AsyncIIFEService)).toThrow('resolveAsync()');
		});

		test('resolveAsync() should resolve async IIFE constructor pattern', async () => {
			class AsyncIIFEService {
				public initialized = false;
				constructor() {
					return (async () => {
						await Promise.resolve();
						this.initialized = true;
						return this;
					})() as unknown as AsyncIIFEService;
				}
			}

			container.register(AsyncIIFEService);

			const instance = await container.resolveAsync(AsyncIIFEService);

			expect(instance).toBeInstanceOf(AsyncIIFEService);
			expect(instance.initialized).toBe(true);
		});

		test('resolveAsync() should resolve Promise return in constructor', async () => {
			class PromiseReturnService {
				public value!: number;
				constructor() {
					return new Promise<PromiseReturnService>((resolve) => {
						this.value = 42;
						resolve(this);
					}) as unknown as PromiseReturnService;
				}
			}

			container.register(PromiseReturnService);

			const instance = await container.resolveAsync(PromiseReturnService);

			expect(instance).toBeInstanceOf(PromiseReturnService);
			expect(instance.value).toBe(42);
		});

		test('resolveAsync() should resolve dependency chain with async constructors', async () => {
			class AsyncDep {
				public ready = false;
				constructor() {
					return (async () => {
						await Promise.resolve();
						this.ready = true;
						return this;
					})() as unknown as AsyncDep;
				}
			}

			class ServiceWithAsyncDep {
				constructor(public dep: AsyncDep) {}
			}

			container.register(AsyncDep);
			container.register(ServiceWithAsyncDep, [AsyncDep]);

			const instance = await container.resolveAsync(ServiceWithAsyncDep);

			expect(instance).toBeInstanceOf(ServiceWithAsyncDep);
			expect(instance.dep).toBeInstanceOf(AsyncDep);
			expect(instance.dep.ready).toBe(true);
		});

		test('resolveAsync() should cache instances like resolve()', async () => {
			class AsyncService {
				public id = Math.random();
				constructor() {
					return (async () => {
						await Promise.resolve();
						return this;
					})() as unknown as AsyncService;
				}
			}

			container.register(AsyncService);

			const instance1 = await container.resolveAsync(AsyncService);
			const instance2 = await container.resolveAsync(AsyncService);

			expect(instance1).toBe(instance2);
			expect(instance1.id).toBe(instance2.id);
		});

		test('resolveAsync() should work with normal sync constructors too', async () => {
			class NormalService {
				value = 42;
			}

			container.register(NormalService);

			const instance = await container.resolveAsync(NormalService);

			expect(instance).toBeInstanceOf(NormalService);
			expect(instance.value).toBe(42);
		});

		test('resolve() should work with normal sync constructors', () => {
			class NormalService {
				value = 42;
			}

			class ServiceWithAsyncMethod {
				async init() {
					await Promise.resolve();
				}
			}

			container.register(NormalService);
			container.register(ServiceWithAsyncMethod);

			const normal = container.resolve(NormalService);
			const withAsync = container.resolve(ServiceWithAsyncMethod);

			expect(normal.value).toBe(42);
			expect(withAsync).toBeInstanceOf(ServiceWithAsyncMethod);
		});

		test('resolveAsync() should propagate errors from async constructors', async () => {
			class FailingAsyncService {
				constructor() {
					return (async () => {
						await Promise.resolve();
						throw new Error('Initialization failed');
					})() as unknown as FailingAsyncService;
				}
			}

			container.register(FailingAsyncService);

			await expect(container.resolveAsync(FailingAsyncService)).rejects.toThrow('Initialization failed');
		});

		test('resolveAsync() should propagate rejection from Promise constructor', async () => {
			class RejectingService {
				constructor() {
					return new Promise((_, reject) => {
						reject(new Error('Connection refused'));
					}) as unknown as RejectingService;
				}
			}

			container.register(RejectingService);

			await expect(container.resolveAsync(RejectingService)).rejects.toThrow('Connection refused');
		});

		test('resolve() should throw when sync service depends on async service', () => {
			class AsyncDependency {
				constructor() {
					return (async () => {
						await Promise.resolve();
						return this;
					})() as unknown as AsyncDependency;
				}
			}

			class SyncServiceWithAsyncDep {
				constructor(public dep: AsyncDependency) {}
			}

			container.register(AsyncDependency);
			container.register(SyncServiceWithAsyncDep, [AsyncDependency]);

			// resolve() should fail because the dependency has an async constructor
			expect(() => container.resolve(SyncServiceWithAsyncDep)).toThrow(
				'AsyncDependency has an async constructor'
			);
			expect(() => container.resolve(SyncServiceWithAsyncDep)).toThrow('resolveAsync()');
		});

		test('resolveAsync() should handle deep mixed dependency chains', async () => {
			class SyncServiceA {
				value = 'A';
			}

			class AsyncServiceB {
				public initialized = false;
				constructor(public depA: SyncServiceA) {
					return (async () => {
						await Promise.resolve();
						this.initialized = true;
						return this;
					})() as unknown as AsyncServiceB;
				}
			}

			class SyncServiceC {
				constructor(public depB: AsyncServiceB) {}
			}

			class AsyncServiceD {
				public ready = false;
				constructor(public depC: SyncServiceC) {
					return (async () => {
						await Promise.resolve();
						this.ready = true;
						return this;
					})() as unknown as AsyncServiceD;
				}
			}

			container.register(SyncServiceA);
			container.register(AsyncServiceB, [SyncServiceA]);
			container.register(SyncServiceC, [AsyncServiceB]);
			container.register(AsyncServiceD, [SyncServiceC]);

			const instance = await container.resolveAsync(AsyncServiceD);

			expect(instance).toBeInstanceOf(AsyncServiceD);
			expect(instance.ready).toBe(true);
			expect(instance.depC).toBeInstanceOf(SyncServiceC);
			expect(instance.depC.depB).toBeInstanceOf(AsyncServiceB);
			expect(instance.depC.depB.initialized).toBe(true);
			expect(instance.depC.depB.depA).toBeInstanceOf(SyncServiceA);
			expect(instance.depC.depB.depA.value).toBe('A');
		});

		test('resolveAsync() should handle Promise.resolve() pattern', async () => {
			class PromiseResolveService {
				public value = 'resolved';
				constructor() {
					return Promise.resolve(this) as unknown as PromiseResolveService;
				}
			}

			container.register(PromiseResolveService);

			const instance = await container.resolveAsync(PromiseResolveService);

			expect(instance).toBeInstanceOf(PromiseResolveService);
			expect(instance.value).toBe('resolved');
		});

		test('resolveAsync() should detect circular dependencies', async () => {
			class ServiceA {
				constructor(public dep: ServiceB) {}
			}

			class ServiceB {
				constructor(public dep: ServiceA) {}
			}

			container.register(ServiceA, [ServiceB]);
			container.register(ServiceB, [ServiceA]);

			await expect(container.resolveAsync(ServiceA)).rejects.toThrow('Circular dependency');
		});

		test('resolveAsync() should handle multiple async services in parallel deps', async () => {
			class AsyncServiceX {
				public id = 'X';
				constructor() {
					return (async () => {
						await Promise.resolve();
						return this;
					})() as unknown as AsyncServiceX;
				}
			}

			class AsyncServiceY {
				public id = 'Y';
				constructor() {
					return (async () => {
						await Promise.resolve();
						return this;
					})() as unknown as AsyncServiceY;
				}
			}

			class ServiceWithMultipleAsyncDeps {
				constructor(
					public x: AsyncServiceX,
					public y: AsyncServiceY
				) {}
			}

			container.register(AsyncServiceX);
			container.register(AsyncServiceY);
			container.register(ServiceWithMultipleAsyncDeps, [AsyncServiceX, AsyncServiceY]);

			const instance = await container.resolveAsync(ServiceWithMultipleAsyncDeps);

			expect(instance.x).toBeInstanceOf(AsyncServiceX);
			expect(instance.y).toBeInstanceOf(AsyncServiceY);
			expect(instance.x.id).toBe('X');
			expect(instance.y.id).toBe('Y');
		});

		test('resolveAsync() should not re-await cached instances', async () => {
			let constructorCallCount = 0;

			class AsyncServiceWithCounter {
				public callNumber!: number;
				constructor() {
					return (async () => {
						constructorCallCount++;
						this.callNumber = constructorCallCount;
						await Promise.resolve();
						return this;
					})() as unknown as AsyncServiceWithCounter;
				}
			}

			container.register(AsyncServiceWithCounter);

			const instance1 = await container.resolveAsync(AsyncServiceWithCounter);
			const instance2 = await container.resolveAsync(AsyncServiceWithCounter);
			const instance3 = await container.resolveAsync(AsyncServiceWithCounter);

			expect(constructorCallCount).toBe(1);
			expect(instance1).toBe(instance2);
			expect(instance2).toBe(instance3);
			expect(instance1.callNumber).toBe(1);
		});

		test('resolveAsync() should handle thenable objects (duck-typed promises)', async () => {
			class ThenableService {
				public resolved = false;
				constructor() {
					// Return a thenable (duck-typed Promise)
					return {
						// oxlint-disable-next-line unicorn/no-thenable -- Intentional: testing thenable/duck-typed Promise behavior
						then: (resolve: (value: ThenableService) => void) => {
							this.resolved = true;
							resolve(this);
						}
					} as unknown as ThenableService;
				}
			}

			container.register(ThenableService);

			const instance = await container.resolveAsync(ThenableService);

			expect(instance.resolved).toBe(true);
		});
	});

	describe('resolution timeout warning', () => {
		test('should log warning but still resolve when resolution is slow', () => {
			// Create services with slow constructors that collectively exceed timeout
			class SlowService1 {
				constructor() {
					// Simulate slow operation by blocking for 100ms
					const start = Date.now();
					while (Date.now() - start < 100) {
						// Busy wait
					}
				}
			}

			class SlowService2 {
				constructor(public dep: SlowService1) {
					const start = Date.now();
					while (Date.now() - start < 100) {
						// Busy wait
					}
				}
			}

			class SlowService3 {
				constructor(public dep: SlowService2) {
					const start = Date.now();
					while (Date.now() - start < 100) {
						// Busy wait
					}
				}
			}

			container.register(SlowService1);
			container.register(SlowService2, [SlowService1]);
			container.register(SlowService3, [SlowService2]);

			// Set timeout to 150ms - this will be exceeded after 2 services (200ms total)
			container.setResolutionTimeout(150);

			// Should NOT throw - just warn and continue
			const result = container.resolve(SlowService3);
			expect(result).toBeInstanceOf(SlowService3);
			expect(result.dep).toBeInstanceOf(SlowService2);
			expect(result.dep.dep).toBeInstanceOf(SlowService1);
		});

		test('should not warn for fast resolutions', () => {
			class FastService1 {}
			class FastService2 {
				constructor(public dep: FastService1) {}
			}
			class FastService3 {
				constructor(public dep: FastService2) {}
			}

			container.register(FastService1);
			container.register(FastService2, [FastService1]);
			container.register(FastService3, [FastService2]);

			// Default timeout is 5 seconds, fast services should resolve instantly
			const result = container.resolve(FastService3);
			expect(result).toBeInstanceOf(FastService3);
		});

		test('should allow configuring resolution timeout threshold', () => {
			class TestService {}
			container.register(TestService);

			// Should be able to set custom timeout threshold
			container.setResolutionTimeout(10000);

			// Service should still resolve
			const result = container.resolve(TestService);
			expect(result).toBeInstanceOf(TestService);
		});

		test('should reset timeout tracking between resolve calls', () => {
			class SlowService {
				constructor() {
					const start = Date.now();
					while (Date.now() - start < 40) {}
				}
			}

			container.register(SlowService);
			container.setResolutionTimeout(100);

			// First call should succeed (40ms < 100ms)
			const first = container.resolve(SlowService);
			expect(first).toBeInstanceOf(SlowService);

			// Clear instances to force re-resolution
			container.clearInstances();

			// Second call should also succeed (fresh timeout tracking)
			const second = container.resolve(SlowService);
			expect(second).toBeInstanceOf(SlowService);
		});

		test('resolveAsync() should also track timeout for async constructors', async () => {
			class SlowAsyncService {
				constructor() {
					return (async () => {
						// Simulate slow async initialization
						await new Promise((resolve) => setTimeout(resolve, 200));
						return this;
					})() as unknown as SlowAsyncService;
				}
			}

			container.register(SlowAsyncService);
			container.setResolutionTimeout(100);

			// Should NOT throw - just warn and continue resolving
			const result = await container.resolveAsync(SlowAsyncService);
			expect(result).toBeInstanceOf(SlowAsyncService);
		});

		test('resolveAsync() should reset timeout tracking between calls', async () => {
			class FastAsyncService {
				constructor() {
					return (async () => {
						await Promise.resolve();
						return this;
					})() as unknown as FastAsyncService;
				}
			}

			container.register(FastAsyncService);
			container.setResolutionTimeout(100);

			// First call
			const first = await container.resolveAsync(FastAsyncService);
			expect(first).toBeInstanceOf(FastAsyncService);

			// Clear instances to force re-resolution
			container.clearInstances();

			// Second call - timeout tracking should be fresh
			const second = await container.resolveAsync(FastAsyncService);
			expect(second).toBeInstanceOf(FastAsyncService);
		});
	});

	describe('package cache', () => {
		test('should start with empty package cache', () => {
			expect(container.getPackageCacheSize()).toBe(0);
		});

		test('should cache package resolution results after validate()', () => {
			class ServiceWithExternal {}
			container.registerWithExternal(ServiceWithExternal, [], ['typescript']);

			expect(container.getPackageCacheSize()).toBe(0);

			container.validate();

			// After validate, the package should be cached
			expect(container.getPackageCacheSize()).toBe(1);
		});

		test('should cache both found and not-found packages', () => {
			class ServiceA {}
			class ServiceB {}
			container.registerWithExternal(ServiceA, [], ['typescript']);
			container.registerWithExternal(ServiceB, [], ['nonexistent-package-cache-test-12345']);

			try {
				container.validate();
			} catch {
				// Expected to throw due to missing package
			}

			// Both packages should be cached (one found, one not found)
			expect(container.getPackageCacheSize()).toBe(2);
		});

		test('should clear package cache on container.clear()', () => {
			class ServiceWithExternal {}
			container.registerWithExternal(ServiceWithExternal, [], ['typescript']);
			container.validate();

			expect(container.getPackageCacheSize()).toBe(1);

			container.clear();

			expect(container.getPackageCacheSize()).toBe(0);
		});

		test('should reuse cached results on repeated validate() calls', () => {
			class ServiceWithMultipleExternal {}
			container.registerWithExternal(ServiceWithMultipleExternal, [], ['typescript', 'bun:test']);

			// First validate populates cache
			container.validate();
			const cacheSizeAfterFirst = container.getPackageCacheSize();

			// Second validate should use cached results (size unchanged)
			container.validate();
			const cacheSizeAfterSecond = container.getPackageCacheSize();

			expect(cacheSizeAfterFirst).toBe(2);
			expect(cacheSizeAfterSecond).toBe(2);
		});
	});
});
