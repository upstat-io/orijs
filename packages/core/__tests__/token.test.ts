import { describe, test, expect, beforeEach } from 'bun:test';
import { Container } from '../src/container.ts';
import { createToken, isToken } from '../src/token.ts';

describe('Token', () => {
	describe('createToken', () => {
		test('should create a symbol with the given name', () => {
			const token = createToken<string>('TestToken');

			expect(typeof token).toBe('symbol');
			expect(token.description).toBe('TestToken');
		});

		test('should create unique tokens even with same name', () => {
			const token1 = createToken<string>('TestToken');
			const token2 = createToken<string>('TestToken');

			expect(token1).not.toBe(token2);
		});
	});

	describe('isToken', () => {
		test('should return true for symbols', () => {
			const token = createToken<string>('TestToken');
			expect(isToken(token)).toBe(true);
		});

		test('should return true for raw symbols', () => {
			expect(isToken(Symbol('test'))).toBe(true);
		});

		test('should return false for non-symbols', () => {
			expect(isToken('string')).toBe(false);
			expect(isToken(123)).toBe(false);
			expect(isToken({})).toBe(false);
			expect(isToken(null)).toBe(false);
			expect(isToken(undefined)).toBe(false);
			expect(isToken(class Test {})).toBe(false);
		});
	});
});

describe('Container with Tokens', () => {
	let container: Container;

	beforeEach(() => {
		container = new Container();
	});

	describe('registerInstance with Token', () => {
		test('should register and resolve instance by token', () => {
			const ConfigToken = createToken<{ port: number }>('Config');
			const config = { port: 3000 };

			container.registerInstance(ConfigToken, config);
			const resolved = container.resolve(ConfigToken);

			expect(resolved).toBe(config);
			expect(resolved.port).toBe(3000);
		});

		test('should support multiple tokens of same type', () => {
			interface CacheService {
				name: string;
				get(key: string): string | null;
			}

			const HotCache = createToken<CacheService>('HotCache');
			const ColdCache = createToken<CacheService>('ColdCache');

			const hotInstance: CacheService = {
				name: 'hot',
				get: () => 'hot-value'
			};
			const coldInstance: CacheService = {
				name: 'cold',
				get: () => 'cold-value'
			};

			container.registerInstance(HotCache, hotInstance);
			container.registerInstance(ColdCache, coldInstance);

			expect(container.resolve(HotCache).name).toBe('hot');
			expect(container.resolve(ColdCache).name).toBe('cold');
			expect(container.resolve(HotCache)).not.toBe(container.resolve(ColdCache));
		});
	});

	describe('services depending on tokens', () => {
		test('should resolve service with token dependency', () => {
			interface Database {
				query(sql: string): string[];
			}

			const PrimaryDB = createToken<Database>('PrimaryDB');
			const primaryDb: Database = {
				query: (sql) => [`primary: ${sql}`]
			};

			class UserRepository {
				constructor(public db: Database) {}

				findAll(): string[] {
					return this.db.query('SELECT * FROM users');
				}
			}

			container.registerInstance(PrimaryDB, primaryDb);
			// Register service with token dependency using public API
			container.registerWithTokenDeps(UserRepository, [PrimaryDB]);

			const repo = container.resolve(UserRepository);
			expect(repo.findAll()).toEqual(['primary: SELECT * FROM users']);
		});

		test('should support mixed constructor and token dependencies', () => {
			interface Config {
				apiKey: string;
			}

			const ConfigToken = createToken<Config>('Config');

			class Logger {
				log(msg: string): string {
					return `LOG: ${msg}`;
				}
			}

			class ApiService {
				constructor(
					public logger: Logger,
					public config: Config
				) {}

				call(): string {
					return this.logger.log(`Calling with ${this.config.apiKey}`);
				}
			}

			container.register(Logger);
			container.registerInstance(ConfigToken, { apiKey: 'secret123' });
			// Mixed deps: Constructor + Token - use public API
			container.registerWithTokenDeps(ApiService, [Logger, ConfigToken]);

			const service = container.resolve(ApiService);
			expect(service.call()).toBe('LOG: Calling with secret123');
		});
	});

	describe('validation with tokens', () => {
		test('should report missing token in validation', () => {
			// Enable debug mode so FrameworkError throws instead of process.exit
			const originalDebug = process.env.ORIJS_DEBUG;
			process.env.ORIJS_DEBUG = 'true';

			try {
				const MissingToken = createToken<string>('MissingToken');

				class ServiceWithMissingToken {
					constructor(public value: string) {}
				}

				container.registerWithTokenDeps(ServiceWithMissingToken, [MissingToken]);

				expect(() => container.validate()).toThrow(/depends on token 'MissingToken'/);
			} finally {
				// Restore original debug setting
				if (originalDebug === undefined) {
					delete process.env.ORIJS_DEBUG;
				} else {
					process.env.ORIJS_DEBUG = originalDebug;
				}
			}
		});

		test('should pass validation when token is registered', () => {
			const ValidToken = createToken<string>('ValidToken');

			class ServiceWithToken {
				constructor(public value: string) {}
			}

			container.registerInstance(ValidToken, 'token-value');
			container.registerWithTokenDeps(ServiceWithToken, [ValidToken]);

			expect(() => container.validate()).not.toThrow();
		});
	});
});
