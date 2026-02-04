import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { AppContext } from '../src/app-context.ts';
import { Container } from '../src/container.ts';
import { Logger } from '@orijs/logging';
import type { EventSystem } from '@orijs/events';
import type { SocketEmitter } from '@orijs/websocket';

describe('AppContext', () => {
	let container: Container;
	let logger: Logger;

	beforeEach(() => {
		container = new Container();
		logger = new Logger('Test', { level: 'error' });
	});

	describe('construction', () => {
		test('should initialize with created phase', () => {
			const appContext = new AppContext(logger, container);

			expect(appContext.phase).toBe('created');
		});

		test('should store provided logger', () => {
			const appContext = new AppContext(logger, container);

			expect(appContext.log).toBe(logger);
		});

		test('should have undefined event when not provided', () => {
			const appContext = new AppContext(logger, container);

			expect(appContext.event).toBeUndefined();
		});

		test('should store provided event system', () => {
			// Minimal mock for testing that event property is stored correctly
			const mockEvents = { emit: () => {}, on: () => {} } as unknown as EventSystem;
			const appContext = new AppContext(logger, container, mockEvents);

			expect(appContext.event).toBe(mockEvents);
		});
	});

	describe('resolve', () => {
		test('should resolve service from container', () => {
			class TestService {
				getValue() {
					return 42;
				}
			}
			container.register(TestService, []);

			const appContext = new AppContext(logger, container);
			const service = appContext.resolve(TestService);

			expect(service).toBeInstanceOf(TestService);
			expect(service.getValue()).toBe(42);
		});
	});

	describe('lifecycle phases', () => {
		test('should update phase via setPhase', () => {
			const appContext = new AppContext(logger, container);

			appContext.setPhase('bootstrapped');
			expect(appContext.phase).toBe('bootstrapped');

			appContext.setPhase('starting');
			expect(appContext.phase).toBe('starting');

			appContext.setPhase('ready');
			expect(appContext.phase).toBe('ready');

			appContext.setPhase('stopping');
			expect(appContext.phase).toBe('stopping');

			appContext.setPhase('stopped');
			expect(appContext.phase).toBe('stopped');
		});
	});

	describe('onStartup', () => {
		test('should register startup hooks', () => {
			const appContext = new AppContext(logger, container);
			const hook = mock(() => {});

			appContext.onStartup(hook);

			expect(appContext.getHookCounts().startup).toBe(1);
		});

		test('should warn when registering after startup phase', () => {
			const warnLogger = new Logger('Test', { level: 'warn' });
			const warnSpy = mock(() => {});
			warnLogger.warn = warnSpy;

			const appContext = new AppContext(warnLogger, container);
			appContext.setPhase('ready');

			appContext.onStartup(() => {});

			expect(warnSpy).toHaveBeenCalled();
		});

		test('should not warn when registering during created phase', () => {
			const warnLogger = new Logger('Test', { level: 'warn' });
			const warnSpy = mock(() => {});
			warnLogger.warn = warnSpy;

			const appContext = new AppContext(warnLogger, container);

			appContext.onStartup(() => {});

			expect(warnSpy).not.toHaveBeenCalled();
		});
	});

	describe('onReady', () => {
		test('should register ready hooks', () => {
			const appContext = new AppContext(logger, container);
			const hook = mock(() => {});

			appContext.onReady(hook);

			expect(appContext.getHookCounts().ready).toBe(1);
		});

		test('should warn when registering after ready phase', () => {
			const warnLogger = new Logger('Test', { level: 'warn' });
			const warnSpy = mock(() => {});
			warnLogger.warn = warnSpy;

			const appContext = new AppContext(warnLogger, container);
			appContext.setPhase('ready');

			appContext.onReady(() => {});

			expect(warnSpy).toHaveBeenCalled();
		});
	});

	describe('onShutdown', () => {
		test('should register shutdown hooks', () => {
			const appContext = new AppContext(logger, container);
			const hook = mock(() => {});

			appContext.onShutdown(hook);

			expect(appContext.getHookCounts().shutdown).toBe(1);
		});

		test('should warn when registering during shutdown', () => {
			const warnLogger = new Logger('Test', { level: 'warn' });
			const warnSpy = mock(() => {});
			warnLogger.warn = warnSpy;

			const appContext = new AppContext(warnLogger, container);
			appContext.setPhase('stopping');

			appContext.onShutdown(() => {});

			expect(warnSpy).toHaveBeenCalled();
		});
	});

	describe('executeStartupHooks', () => {
		test('should execute hooks in FIFO order', async () => {
			const appContext = new AppContext(logger, container);
			const order: number[] = [];

			appContext.onStartup(() => {
				order.push(1);
			});
			appContext.onStartup(() => {
				order.push(2);
			});
			appContext.onStartup(() => {
				order.push(3);
			});

			await appContext.executeStartupHooks();

			expect(order).toEqual([1, 2, 3]);
		});

		test('should set phase to starting during execution', async () => {
			const appContext = new AppContext(logger, container);
			let capturedPhase: string | undefined;

			appContext.onStartup(() => {
				capturedPhase = appContext.phase;
			});

			await appContext.executeStartupHooks();

			expect(capturedPhase).toBe('starting');
		});

		test('should support async hooks', async () => {
			const appContext = new AppContext(logger, container);
			const order: number[] = [];

			appContext.onStartup(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				order.push(1);
			});
			appContext.onStartup(() => {
				order.push(2);
			});

			await appContext.executeStartupHooks();

			expect(order).toEqual([1, 2]);
		});

		test('should fail fast on error', async () => {
			const appContext = new AppContext(logger, container);
			const order: number[] = [];

			appContext.onStartup(() => {
				order.push(1);
			});
			appContext.onStartup(() => {
				throw new Error('Startup failed');
			});
			appContext.onStartup(() => {
				order.push(3);
			});

			await expect(appContext.executeStartupHooks()).rejects.toThrow('Startup failed');
			expect(order).toEqual([1]);
		});
	});

	describe('executeReadyHooks', () => {
		test('should execute hooks in FIFO order', async () => {
			const appContext = new AppContext(logger, container);
			const order: number[] = [];

			appContext.onReady(() => {
				order.push(1);
			});
			appContext.onReady(() => {
				order.push(2);
			});
			appContext.onReady(() => {
				order.push(3);
			});

			await appContext.executeReadyHooks();

			expect(order).toEqual([1, 2, 3]);
		});

		test('should set phase to ready after execution', async () => {
			const appContext = new AppContext(logger, container);

			await appContext.executeReadyHooks();

			expect(appContext.phase).toBe('ready');
		});

		test('should fail fast on error', async () => {
			const appContext = new AppContext(logger, container);
			const order: number[] = [];

			appContext.onReady(() => {
				order.push(1);
			});
			appContext.onReady(() => {
				throw new Error('Ready failed');
			});
			appContext.onReady(() => {
				order.push(3);
			});

			await expect(appContext.executeReadyHooks()).rejects.toThrow('Ready failed');
			expect(order).toEqual([1]);
		});
	});

	describe('executeShutdownHooks', () => {
		test('should execute hooks in LIFO order', async () => {
			const appContext = new AppContext(logger, container);
			const order: number[] = [];

			appContext.onShutdown(() => {
				order.push(1);
			});
			appContext.onShutdown(() => {
				order.push(2);
			});
			appContext.onShutdown(() => {
				order.push(3);
			});

			await appContext.executeShutdownHooks();

			expect(order).toEqual([3, 2, 1]);
		});

		test('should set phase to stopping during execution', async () => {
			const appContext = new AppContext(logger, container);
			let capturedPhase: string | undefined;

			appContext.onShutdown(() => {
				capturedPhase = appContext.phase;
			});

			await appContext.executeShutdownHooks();

			expect(capturedPhase).toBe('stopping');
		});

		test('should set phase to stopped after execution', async () => {
			const appContext = new AppContext(logger, container);

			await appContext.executeShutdownHooks();

			expect(appContext.phase).toBe('stopped');
		});

		test('should continue on error and log it', async () => {
			const errorLogger = new Logger('Test', { level: 'error' });
			const errorSpy = mock(() => {});
			errorLogger.error = errorSpy;

			const appContext = new AppContext(errorLogger, container);
			const order: number[] = [];

			appContext.onShutdown(() => {
				order.push(1);
			});
			appContext.onShutdown(() => {
				throw new Error('Shutdown hook failed');
			});
			appContext.onShutdown(() => {
				order.push(3);
			});

			await appContext.executeShutdownHooks();

			// All hooks should run (LIFO: 3, error, 1)
			expect(order).toEqual([3, 1]);
			expect(errorSpy).toHaveBeenCalled();
			expect(appContext.phase).toBe('stopped');
		});

		test('should support async hooks', async () => {
			const appContext = new AppContext(logger, container);
			const order: number[] = [];

			appContext.onShutdown(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				order.push(1);
			});
			appContext.onShutdown(() => {
				order.push(2);
			});

			await appContext.executeShutdownHooks();

			// LIFO order: 2 first, then 1
			expect(order).toEqual([2, 1]);
		});
	});

	describe('getHookCounts', () => {
		test('should return correct counts for all hook types', () => {
			const appContext = new AppContext(logger, container);

			appContext.onStartup(() => {});
			appContext.onStartup(() => {});
			appContext.onReady(() => {});
			appContext.onShutdown(() => {});
			appContext.onShutdown(() => {});
			appContext.onShutdown(() => {});

			const counts = appContext.getHookCounts();

			expect(counts.startup).toBe(2);
			expect(counts.ready).toBe(1);
			expect(counts.shutdown).toBe(3);
		});
	});

	describe('config', () => {
		describe('NullConfigProvider (default)', () => {
			test('should throw helpful error when get() is called without config', async () => {
				const appContext = new AppContext(logger, container);

				await expect(appContext.config.get('SECRET')).rejects.toThrow(
					'Config not configured. Call .config(provider) when creating the application.'
				);
			});

			test('should throw helpful error when getRequired() is called without config', async () => {
				const appContext = new AppContext(logger, container);

				await expect(appContext.config.getRequired('SECRET')).rejects.toThrow(
					'Config not configured. Call .config(provider) when creating the application.'
				);
			});
		});

		describe('setConfig', () => {
			test('should replace NullConfigProvider with provided provider', async () => {
				const appContext = new AppContext(logger, container);
				const mockProvider = {
					get: async (key: string) => (key === 'TEST_KEY' ? 'test_value' : undefined),
					getRequired: async (key: string) => {
						const value = key === 'TEST_KEY' ? 'test_value' : undefined;
						if (!value) throw new Error(`Missing: ${key}`);
						return value;
					},
					loadKeys: async (keys: string[]) => {
						const result: Record<string, string | undefined> = {};
						for (const key of keys) {
							result[key] = key === 'TEST_KEY' ? 'test_value' : undefined;
						}
						return result;
					}
				};

				appContext.setConfig(mockProvider);

				expect(await appContext.config.get('TEST_KEY')).toBe('test_value');
				expect(await appContext.config.getRequired('TEST_KEY')).toBe('test_value');
			});

			test('should allow provider to be replaced multiple times', async () => {
				const appContext = new AppContext(logger, container);
				const provider1 = {
					get: async () => 'value1',
					getRequired: async () => 'value1',
					loadKeys: async () => ({})
				};
				const provider2 = {
					get: async () => 'value2',
					getRequired: async () => 'value2',
					loadKeys: async () => ({})
				};

				appContext.setConfig(provider1);
				expect(await appContext.config.get('KEY')).toBe('value1');

				appContext.setConfig(provider2);
				expect(await appContext.config.get('KEY')).toBe('value2');
			});
		});

		describe('serialization protection', () => {
			test('should not include _config in Object.keys', () => {
				const appContext = new AppContext(logger, container);
				const mockProvider = {
					get: async () => 'secret_value',
					getRequired: async () => 'secret_value',
					loadKeys: async () => ({})
				};
				appContext.setConfig(mockProvider);

				const keys = Object.keys(appContext);

				expect(keys).not.toContain('_config');
				expect(keys).not.toContain('config');
			});

			test('should not include _config in for...in loop', () => {
				const appContext = new AppContext(logger, container);
				const mockProvider = {
					get: async () => 'secret_value',
					getRequired: async () => 'secret_value',
					loadKeys: async () => ({})
				};
				appContext.setConfig(mockProvider);

				const keys: string[] = [];
				for (const key in appContext) {
					keys.push(key);
				}

				expect(keys).not.toContain('_config');
				expect(keys).not.toContain('config');
			});

			test('should exclude config from JSON.stringify via toJSON', () => {
				const appContext = new AppContext(logger, container);
				const mockProvider = {
					get: async () => 'super_secret_api_key_12345',
					getRequired: async () => 'super_secret_api_key_12345',
					loadKeys: async () => ({})
				};
				appContext.setConfig(mockProvider);

				const json = JSON.stringify(appContext);
				const parsed = JSON.parse(json);

				expect(parsed).toEqual({ phase: 'created' });
				expect(json).not.toContain('super_secret_api_key_12345');
				expect(json).not.toContain('config');
				expect(json).not.toContain('_config');
			});

			test('toJSON should only include phase', () => {
				const appContext = new AppContext(logger, container);
				appContext.setPhase('ready');

				const json = appContext.toJSON();

				expect(json).toEqual({ phase: 'ready' });
				expect(Object.keys(json)).toEqual(['phase']);
			});

			test('should redact config in custom inspect output', () => {
				const appContext = new AppContext(logger, container);
				const mockProvider = {
					get: async () => 'super_secret_value',
					getRequired: async () => 'super_secret_value',
					loadKeys: async () => ({})
				};
				appContext.setConfig(mockProvider);
				appContext.setPhase('ready');

				const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const inspectFn = (appContext as any)[inspectSymbol] as () => string;
				const inspectOutput = inspectFn.call(appContext);

				expect(inspectOutput).toBe("AppContext { phase: 'ready', config: [REDACTED] }");
				expect(inspectOutput).not.toContain('super_secret_value');
			});

			test('should protect secrets even when provider has sensitive data', async () => {
				const appContext = new AppContext(logger, container);
				const sensitiveProvider = {
					apiKey: 'sk_live_secret123456789',
					databasePassword: 'db_password_very_secret',
					get: async function (key: string) {
						return key === 'API_KEY' ? this.apiKey : undefined;
					},
					getRequired: async function (key: string) {
						const value = await this.get(key);
						if (!value) throw new Error(`Missing: ${key}`);
						return value;
					},
					loadKeys: async () => ({})
				};
				appContext.setConfig(sensitiveProvider);

				// Provider still works
				expect(await appContext.config.get('API_KEY')).toBe('sk_live_secret123456789');

				// But secrets don't leak through serialization
				const json = JSON.stringify(appContext);
				expect(json).not.toContain('sk_live_secret123456789');
				expect(json).not.toContain('db_password_very_secret');

				// And don't appear in keys
				expect(Object.keys(appContext)).not.toContain('_config');
			});
		});

		describe('config accessibility', () => {
			test('should be accessible via getter after setConfig', async () => {
				const appContext = new AppContext(logger, container);
				const provider = {
					get: async () => 'value',
					getRequired: async () => 'value',
					loadKeys: async () => ({})
				};

				appContext.setConfig(provider);

				expect(appContext.config).toBe(provider);
			});

			test('config property should return same instance on multiple accesses', () => {
				const appContext = new AppContext(logger, container);
				const provider = {
					get: async () => 'value',
					getRequired: async () => 'value',
					loadKeys: async () => ({})
				};
				appContext.setConfig(provider);

				const config1 = appContext.config;
				const config2 = appContext.config;

				expect(config1).toBe(config2);
				expect(config1).toBe(provider);
			});
		});
	});

	describe('socket', () => {
		describe('generic type parameter', () => {
			test('should provide typed socket when generic parameter is specified', () => {
				// Define a custom emitter that extends SocketEmitter
				interface CustomSocketEmitter extends SocketEmitter {
					emitToAccount(accountUuid: string, event: string, payload: unknown): void;
					customMethod(): string;
				}

				const customEmitter: CustomSocketEmitter = {
					publish: mock(() => Promise.resolve()),
					send: mock(() => true),
					broadcast: mock(() => {}),
					emit: mock(() => Promise.resolve()),
					emitToAccount: mock(() => {}),
					customMethod: () => 'custom'
				};

				// Create AppContext with the custom emitter type
				const appContext = new AppContext<CustomSocketEmitter>(logger, container);
				appContext.setSocketEmitterGetter(() => customEmitter);

				// TypeScript should see the custom methods
				const socket = appContext.socket;

				// Verify custom methods exist and work at runtime
				expect(typeof socket.emitToAccount).toBe('function');
				expect(typeof socket.customMethod).toBe('function');
				expect(socket.customMethod()).toBe('custom');

				// Base SocketEmitter methods also work
				expect(typeof socket.publish).toBe('function');
				expect(typeof socket.send).toBe('function');
				expect(typeof socket.broadcast).toBe('function');
			});

			test('should default to SocketEmitter when no generic parameter provided', () => {
				const appContext = new AppContext(logger, container);
				const mockEmitter: SocketEmitter = {
					publish: mock(() => Promise.resolve()),
					send: mock(() => true),
					broadcast: mock(() => {}),
					emit: mock(() => Promise.resolve())
				};

				appContext.setSocketEmitterGetter(() => mockEmitter);

				// Without generic parameter, socket is typed as SocketEmitter
				const socket = appContext.socket;

				// Base methods should work
				expect(typeof socket.publish).toBe('function');
				expect(typeof socket.send).toBe('function');
				expect(typeof socket.broadcast).toBe('function');
			});
		});

		describe('socket getter', () => {
			test('should return socket emitter when configured', () => {
				const appContext = new AppContext(logger, container);
				const mockEmitter: SocketEmitter = {
					publish: mock(() => Promise.resolve()),
					send: mock(() => true),
					broadcast: mock(() => {}),
					emit: mock(() => Promise.resolve())
				};

				appContext.setSocketEmitterGetter(() => mockEmitter);

				expect(appContext.socket).toBe(mockEmitter);
			});

			test('should throw helpful error when WebSocket not configured', () => {
				const appContext = new AppContext(logger, container);

				expect(() => appContext.socket).toThrow('WebSocket not configured');
				expect(() => appContext.socket).toThrow('.websocket()');
			});

			test('should include code example in error message', () => {
				const appContext = new AppContext(logger, container);

				expect(() => appContext.socket).toThrow('Ori.create()');
				expect(() => appContext.socket).toThrow('.listen(3000)');
			});

			test('should call getter function each time socket is accessed', () => {
				const appContext = new AppContext(logger, container);
				const getterFn = mock(() => ({
					publish: () => Promise.resolve(),
					send: () => true,
					broadcast: () => {},
					emit: () => Promise.resolve()
				}));

				appContext.setSocketEmitterGetter(getterFn);

				appContext.socket;
				appContext.socket;
				appContext.socket;

				expect(getterFn).toHaveBeenCalledTimes(3);
			});
		});

		describe('hasWebSocket', () => {
			test('should return false when socket emitter not configured', () => {
				const appContext = new AppContext(logger, container);

				expect(appContext.hasWebSocket).toBe(false);
			});

			test('should return true when socket emitter is configured', () => {
				const appContext = new AppContext(logger, container);
				const mockEmitter: SocketEmitter = {
					publish: mock(() => Promise.resolve()),
					send: mock(() => true),
					broadcast: mock(() => {}),
					emit: mock(() => Promise.resolve())
				};

				appContext.setSocketEmitterGetter(() => mockEmitter);

				expect(appContext.hasWebSocket).toBe(true);
			});
		});

		describe('setSocketEmitterGetter', () => {
			test('should set the socket emitter getter', () => {
				const appContext = new AppContext(logger, container);
				const mockEmitter: SocketEmitter = {
					publish: mock(() => Promise.resolve()),
					send: mock(() => true),
					broadcast: mock(() => {}),
					emit: mock(() => Promise.resolve())
				};

				appContext.setSocketEmitterGetter(() => mockEmitter);

				expect(appContext.hasWebSocket).toBe(true);
				expect(appContext.socket).toBe(mockEmitter);
			});

			test('should allow replacing the getter', () => {
				const appContext = new AppContext(logger, container);
				const emitter1: SocketEmitter = {
					publish: mock(() => Promise.resolve()),
					send: mock(() => true),
					broadcast: mock(() => {}),
					emit: mock(() => Promise.resolve())
				};
				const emitter2: SocketEmitter = {
					publish: mock(() => Promise.resolve()),
					send: mock(() => false),
					broadcast: mock(() => {}),
					emit: mock(() => Promise.resolve())
				};

				appContext.setSocketEmitterGetter(() => emitter1);
				expect(appContext.socket).toBe(emitter1);

				appContext.setSocketEmitterGetter(() => emitter2);
				expect(appContext.socket).toBe(emitter2);
			});
		});
	});
});
