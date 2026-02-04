import { describe, test, expect } from 'bun:test';
import { waitFor, waitForAsync, withTimeout, delay } from '../src/helpers/async-test-helpers';

describe('async-test-helpers', () => {
	describe('waitFor', () => {
		test('should resolve immediately when condition is true', async () => {
			let called = false;
			await waitFor(() => {
				called = true;
				return true;
			});
			expect(called).toBe(true);
		});

		test('should poll until condition becomes true', async () => {
			let counter = 0;
			await waitFor(() => {
				counter++;
				return counter >= 3;
			}, { interval: 10 });
			expect(counter).toBe(3);
		});

		test('should throw error when timeout is reached', async () => {
			await expect(
				waitFor(() => false, { timeout: 50, interval: 10 })
			).rejects.toThrow('waitFor timeout after 50ms');
		});

		test('should use custom error message on timeout', async () => {
			await expect(
				waitFor(() => false, { timeout: 50, interval: 10, message: 'Custom error' })
			).rejects.toThrow('Custom error');
		});

		test('should respect custom timeout', async () => {
			const startTime = Date.now();
			await expect(
				waitFor(() => false, { timeout: 100, interval: 10 })
			).rejects.toThrow();
			const elapsed = Date.now() - startTime;
			expect(elapsed).toBeGreaterThanOrEqual(100);
			expect(elapsed).toBeLessThan(200);
		});
	});

	describe('waitForAsync', () => {
		test('should resolve immediately when async condition is true', async () => {
			let called = false;
			await waitForAsync(async () => {
				called = true;
				return true;
			});
			expect(called).toBe(true);
		});

		test('should poll until async condition becomes true', async () => {
			let counter = 0;
			await waitForAsync(async () => {
				await delay(5);
				counter++;
				return counter >= 3;
			}, { interval: 10 });
			expect(counter).toBe(3);
		});

		test('should throw error when timeout is reached', async () => {
			await expect(
				waitForAsync(async () => false, { timeout: 50, interval: 10 })
			).rejects.toThrow('waitForAsync timeout after 50ms');
		});

		test('should use custom error message on timeout', async () => {
			await expect(
				waitForAsync(async () => false, { timeout: 50, interval: 10, message: 'Async failed' })
			).rejects.toThrow('Async failed');
		});
	});

	describe('withTimeout', () => {
		test('should resolve with value when promise completes in time', async () => {
			const result = await withTimeout(
				Promise.resolve('success'),
				1000
			);
			expect(result).toBe('success');
		});

		test('should throw error when promise times out', async () => {
			const slowPromise = new Promise<string>((resolve) => {
				setTimeout(() => resolve('too late'), 200);
			});

			await expect(
				withTimeout(slowPromise, 50)
			).rejects.toThrow('Operation timed out (after 50ms)');
		});

		test('should use custom error message on timeout', async () => {
			const slowPromise = new Promise<string>((resolve) => {
				setTimeout(() => resolve('too late'), 200);
			});

			await expect(
				withTimeout(slowPromise, 50, 'Custom timeout message')
			).rejects.toThrow('Custom timeout message (after 50ms)');
		});

		test('should clear timeout when promise resolves', async () => {
			const fastPromise = Promise.resolve('fast');
			const result = await withTimeout(fastPromise, 1000);
			expect(result).toBe('fast');
			// If timeout wasn't cleared, this test would hang or error
		});

		test('should preserve rejected promise error', async () => {
			const failingPromise = Promise.reject(new Error('Original error'));

			await expect(
				withTimeout(failingPromise, 1000)
			).rejects.toThrow('Original error');
		});
	});

	describe('delay', () => {
		test('should wait for specified duration', async () => {
			const startTime = Date.now();
			await delay(50);
			const elapsed = Date.now() - startTime;
			expect(elapsed).toBeGreaterThanOrEqual(45); // Allow small variance
			expect(elapsed).toBeLessThan(100);
		});

		test('should resolve with undefined', async () => {
			const result = await delay(10);
			expect(result).toBeUndefined();
		});
	});
});
