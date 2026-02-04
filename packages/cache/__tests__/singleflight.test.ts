import { describe, it, expect, beforeEach } from 'bun:test';
import { Singleflight, globalSingleflight } from '../src/singleflight';

describe('Singleflight', () => {
	let sf: Singleflight;

	beforeEach(() => {
		sf = new Singleflight();
	});

	describe('do()', () => {
		it('should execute the function and return its result', async () => {
			const result = await sf.do('key1', async () => {
				return 'hello';
			});

			expect(result).toBe('hello');
		});

		it('should execute the function only once for concurrent calls with same key', async () => {
			let callCount = 0;

			const fn = async () => {
				callCount++;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return 'result';
			};

			const [result1, result2, result3] = await Promise.all([
				sf.do('same-key', fn),
				sf.do('same-key', fn),
				sf.do('same-key', fn)
			]);

			expect(callCount).toBe(1);
			expect(result1).toBe('result');
			expect(result2).toBe('result');
			expect(result3).toBe('result');
		});

		it('should execute separate functions for different keys', async () => {
			let count1 = 0;
			let count2 = 0;

			const [result1, result2] = await Promise.all([
				sf.do('key-a', async () => {
					count1++;
					return 'a';
				}),
				sf.do('key-b', async () => {
					count2++;
					return 'b';
				})
			]);

			expect(count1).toBe(1);
			expect(count2).toBe(1);
			expect(result1).toBe('a');
			expect(result2).toBe('b');
		});

		it('should propagate errors to all waiting callers', async () => {
			const error = new Error('Test error');
			let callCount = 0;

			const fn = async () => {
				callCount++;
				await new Promise((resolve) => setTimeout(resolve, 10));
				throw error;
			};

			const results = await Promise.allSettled([
				sf.do('error-key', fn),
				sf.do('error-key', fn),
				sf.do('error-key', fn)
			]);

			expect(callCount).toBe(1);
			expect(results[0].status).toBe('rejected');
			expect(results[1].status).toBe('rejected');
			expect(results[2].status).toBe('rejected');

			if (results[0].status === 'rejected') {
				expect(results[0].reason).toBe(error);
			}
		});

		it('should clean up after completion', async () => {
			await sf.do('cleanup-key', async () => 'done');

			expect(sf.isInflight('cleanup-key')).toBe(false);
			expect(sf.getInflightCount()).toBe(0);
		});

		it('should clean up after error', async () => {
			try {
				await sf.do('error-cleanup', async () => {
					throw new Error('fail');
				});
			} catch {
				// Expected
			}

			expect(sf.isInflight('error-cleanup')).toBe(false);
			expect(sf.getInflightCount()).toBe(0);
		});

		it('should allow a new call after previous one completes', async () => {
			let callCount = 0;

			await sf.do('sequential', async () => {
				callCount++;
				return 'first';
			});

			await sf.do('sequential', async () => {
				callCount++;
				return 'second';
			});

			expect(callCount).toBe(2);
		});
	});

	describe('forget()', () => {
		it('should allow the next call to execute fresh', async () => {
			let callCount = 0;

			// Start a long-running operation
			const promise1 = sf.do('forget-key', async () => {
				callCount++;
				await new Promise((resolve) => setTimeout(resolve, 50));
				return 'first';
			});

			// Forget the key mid-flight
			sf.forget('forget-key');

			// Start a new operation - should execute independently
			const promise2 = sf.do('forget-key', async () => {
				callCount++;
				return 'second';
			});

			await Promise.all([promise1, promise2]);

			expect(callCount).toBe(2);
		});

		it('should be safe to call on non-existent key', () => {
			expect(() => sf.forget('non-existent')).not.toThrow();
		});
	});

	describe('isInflight()', () => {
		it('should return true while operation is running', async () => {
			const promise = sf.do('inflight-check', async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return 'done';
			});

			expect(sf.isInflight('inflight-check')).toBe(true);

			await promise;

			expect(sf.isInflight('inflight-check')).toBe(false);
		});

		it('should return false for non-existent key', () => {
			expect(sf.isInflight('non-existent')).toBe(false);
		});
	});

	describe('getInflightCount()', () => {
		it('should return 0 initially', () => {
			expect(sf.getInflightCount()).toBe(0);
		});

		it('should track multiple inflight operations', async () => {
			const promise1 = sf.do('count-1', async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return 1;
			});

			const promise2 = sf.do('count-2', async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return 2;
			});

			expect(sf.getInflightCount()).toBe(2);

			await Promise.all([promise1, promise2]);

			expect(sf.getInflightCount()).toBe(0);
		});
	});

	describe('clear()', () => {
		it('should remove all inflight operations', async () => {
			const promise1 = sf.do('clear-1', async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return 1;
			});

			const promise2 = sf.do('clear-2', async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return 2;
			});

			expect(sf.getInflightCount()).toBe(2);

			sf.clear();

			expect(sf.getInflightCount()).toBe(0);

			// Original promises still resolve
			await Promise.all([promise1, promise2]);
		});
	});
});

describe('error caching', () => {
	it('should cache errors and re-throw on subsequent calls', async () => {
		const sf = new Singleflight({ errorTtlMs: 1000 });
		const error = new Error('Database connection failed');
		let callCount = 0;

		// First call - should execute and cache error
		try {
			await sf.do('db-query', async () => {
				callCount++;
				throw error;
			});
		} catch (e) {
			expect(e).toBe(error);
		}

		expect(callCount).toBe(1);

		// Second call - should throw cached error without executing
		try {
			await sf.do('db-query', async () => {
				callCount++;
				return 'success';
			});
		} catch (e) {
			expect(e).toBe(error);
		}

		expect(callCount).toBe(1); // Still 1, function was not called
	});

	it('should prevent thundering herd on error (only one DB call)', async () => {
		const sf = new Singleflight({ errorTtlMs: 1000 });
		const error = new Error('Database overloaded');
		let dbCallCount = 0;

		// Simulate 100 concurrent requests all hitting a failing database
		const requests = Array.from({ length: 100 }, () =>
			sf
				.do('failing-query', async () => {
					dbCallCount++;
					await new Promise((resolve) => setTimeout(resolve, 10));
					throw error;
				})
				.catch((e) => e)
		);

		await Promise.all(requests);

		// Only 1 DB call should have been made
		expect(dbCallCount).toBe(1);

		// Additional calls should also not hit DB (error is cached)
		const moreRequests = Array.from({ length: 50 }, () =>
			sf
				.do('failing-query', async () => {
					dbCallCount++;
					return 'should not run';
				})
				.catch((e) => e)
		);

		await Promise.all(moreRequests);

		// Still only 1 DB call
		expect(dbCallCount).toBe(1);
	});

	it('should allow retry after error TTL expires', async () => {
		const sf = new Singleflight({ errorTtlMs: 50 }); // 50ms TTL
		const error = new Error('Temporary failure');
		let callCount = 0;

		// First call - fails
		try {
			await sf.do('retry-key', async () => {
				callCount++;
				throw error;
			});
		} catch {
			// Expected
		}

		expect(callCount).toBe(1);

		// Wait for error TTL to expire
		await new Promise((resolve) => setTimeout(resolve, 60));

		// Now should execute again
		const result = await sf.do('retry-key', async () => {
			callCount++;
			return 'success after retry';
		});

		expect(callCount).toBe(2);
		expect(result).toBe('success after retry');
	});

	it('should clear error cache on successful execution', async () => {
		const sf = new Singleflight({ errorTtlMs: 5000 });
		const error = new Error('First failure');
		let callCount = 0;

		// First call - fails
		try {
			await sf.do('clear-on-success', async () => {
				callCount++;
				throw error;
			});
		} catch {
			// Expected
		}

		expect(sf.hasError('clear-on-success')).toBe(true);

		// Manually clear error to allow retry
		sf.forgetError('clear-on-success');

		expect(sf.hasError('clear-on-success')).toBe(false);

		// Now succeeds
		const result = await sf.do('clear-on-success', async () => {
			callCount++;
			return 'success';
		});

		expect(result).toBe('success');
		expect(callCount).toBe(2);

		// Error cache should be clear (from successful execution)
		expect(sf.hasError('clear-on-success')).toBe(false);
	});

	it('should use default error TTL of 5 seconds', async () => {
		const sf = new Singleflight(); // No options = default 5s TTL
		const error = new Error('Test error');

		try {
			await sf.do('default-ttl', async () => {
				throw error;
			});
		} catch {
			// Expected
		}

		// Error should be cached
		expect(sf.hasError('default-ttl')).toBe(true);
	});

	it('should support custom error TTL via options', async () => {
		const sf = new Singleflight({ errorTtlMs: 100 });
		const error = new Error('Custom TTL error');

		try {
			await sf.do('custom-ttl', async () => {
				throw error;
			});
		} catch {
			// Expected
		}

		expect(sf.hasError('custom-ttl')).toBe(true);

		// Wait for custom TTL to expire
		await new Promise((resolve) => setTimeout(resolve, 110));

		expect(sf.hasError('custom-ttl')).toBe(false);
	});
});

describe('hasError()', () => {
	it('should return true when error is cached and not expired', async () => {
		const sf = new Singleflight({ errorTtlMs: 1000 });

		try {
			await sf.do('has-error-key', async () => {
				throw new Error('Test');
			});
		} catch {
			// Expected
		}

		expect(sf.hasError('has-error-key')).toBe(true);
	});

	it('should return false when no error is cached', () => {
		const sf = new Singleflight();

		expect(sf.hasError('no-error-key')).toBe(false);
	});

	it('should return false when error has expired', async () => {
		const sf = new Singleflight({ errorTtlMs: 30 });

		try {
			await sf.do('expired-error', async () => {
				throw new Error('Test');
			});
		} catch {
			// Expected
		}

		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(sf.hasError('expired-error')).toBe(false);
	});
});

describe('forgetError()', () => {
	it('should clear cached error allowing retry', async () => {
		const sf = new Singleflight({ errorTtlMs: 5000 });
		let callCount = 0;

		try {
			await sf.do('forget-error-key', async () => {
				callCount++;
				throw new Error('Fail');
			});
		} catch {
			// Expected
		}

		expect(callCount).toBe(1);
		expect(sf.hasError('forget-error-key')).toBe(true);

		sf.forgetError('forget-error-key');

		expect(sf.hasError('forget-error-key')).toBe(false);

		// Should execute again
		const result = await sf.do('forget-error-key', async () => {
			callCount++;
			return 'success';
		});

		expect(callCount).toBe(2);
		expect(result).toBe('success');
	});

	it('should be safe to call on non-existent key', () => {
		const sf = new Singleflight();

		expect(() => sf.forgetError('non-existent')).not.toThrow();
	});
});

describe('getErrorCount()', () => {
	it('should return 0 initially', () => {
		const sf = new Singleflight();

		expect(sf.getErrorCount()).toBe(0);
	});

	it('should track cached errors', async () => {
		const sf = new Singleflight({ errorTtlMs: 1000 });

		try {
			await sf.do('error-1', async () => {
				throw new Error('Error 1');
			});
		} catch {
			// Expected
		}

		expect(sf.getErrorCount()).toBe(1);

		try {
			await sf.do('error-2', async () => {
				throw new Error('Error 2');
			});
		} catch {
			// Expected
		}

		expect(sf.getErrorCount()).toBe(2);
	});
});

describe('forget() with errors', () => {
	it('should clear both inflight and error cache', async () => {
		const sf = new Singleflight({ errorTtlMs: 5000 });

		try {
			await sf.do('forget-both', async () => {
				throw new Error('Fail');
			});
		} catch {
			// Expected
		}

		expect(sf.hasError('forget-both')).toBe(true);

		sf.forget('forget-both');

		expect(sf.hasError('forget-both')).toBe(false);
		expect(sf.isInflight('forget-both')).toBe(false);
	});
});

describe('clear() with errors', () => {
	it('should clear all flights and all errors', async () => {
		const sf = new Singleflight({ errorTtlMs: 5000 });

		// Create some errors
		try {
			await sf.do('clear-e1', async () => {
				throw new Error('E1');
			});
		} catch {
			// Expected
		}

		try {
			await sf.do('clear-e2', async () => {
				throw new Error('E2');
			});
		} catch {
			// Expected
		}

		expect(sf.getErrorCount()).toBe(2);

		sf.clear();

		expect(sf.getInflightCount()).toBe(0);
		expect(sf.getErrorCount()).toBe(0);
	});
});

describe('globalSingleflight', () => {
	beforeEach(() => {
		globalSingleflight.clear();
	});

	it('should be a Singleflight instance', () => {
		expect(globalSingleflight).toBeInstanceOf(Singleflight);
	});

	it('should work as expected', async () => {
		let callCount = 0;

		const [a, b] = await Promise.all([
			globalSingleflight.do('global-test', async () => {
				callCount++;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return 'global';
			}),
			globalSingleflight.do('global-test', async () => {
				callCount++;
				return 'global2';
			})
		]);

		expect(callCount).toBe(1);
		expect(a).toBe('global');
		expect(b).toBe('global');
	});
});
