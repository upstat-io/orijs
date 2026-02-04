import { describe, it, expect } from 'bun:test';
import { parseDuration, formatDuration, MAX_DURATION_SECONDS } from '../src/duration';
import type { Duration } from '../src/types';

describe('parseDuration', () => {
	describe('numeric input (passthrough)', () => {
		it('should return the same value for positive numbers', () => {
			expect(parseDuration(60)).toBe(60);
			expect(parseDuration(300)).toBe(300);
			expect(parseDuration(3600)).toBe(3600);
		});

		it('should return 0 for zero', () => {
			expect(parseDuration(0)).toBe(0);
		});

		it('should throw for negative numbers', () => {
			expect(() => parseDuration(-5)).toThrow('Duration must be non-negative');
			expect(() => parseDuration(-1)).toThrow('Duration must be non-negative');
		});

		it('should throw for Infinity', () => {
			expect(() => parseDuration(Infinity)).toThrow('Duration must be a finite number');
			expect(() => parseDuration(-Infinity)).toThrow('Duration must be a finite number');
		});

		it('should throw for NaN', () => {
			expect(() => parseDuration(NaN)).toThrow('Duration must be a finite number');
		});

		it('should throw for durations exceeding 365 days', () => {
			const oneYearPlusOne = MAX_DURATION_SECONDS + 1;
			expect(() => parseDuration(oneYearPlusOne)).toThrow('Duration exceeds maximum of 365 days');
		});

		it('should accept durations at exactly 365 days', () => {
			expect(parseDuration(MAX_DURATION_SECONDS)).toBe(MAX_DURATION_SECONDS);
		});
	});

	describe('string input - seconds', () => {
		it('should parse seconds correctly', () => {
			expect(parseDuration('30s')).toBe(30);
			expect(parseDuration('1s')).toBe(1);
			expect(parseDuration('60s')).toBe(60);
		});

		it('should handle case-insensitive input', () => {
			expect(parseDuration('30S' as Duration)).toBe(30);
		});
	});

	describe('string input - minutes', () => {
		it('should parse minutes correctly', () => {
			expect(parseDuration('5m')).toBe(300);
			expect(parseDuration('1m')).toBe(60);
			expect(parseDuration('10m')).toBe(600);
		});

		it('should handle case-insensitive input', () => {
			expect(parseDuration('5M' as Duration)).toBe(300);
		});
	});

	describe('string input - hours', () => {
		it('should parse hours correctly', () => {
			expect(parseDuration('1h')).toBe(3600);
			expect(parseDuration('2h')).toBe(7200);
			expect(parseDuration('24h')).toBe(86400);
		});

		it('should handle case-insensitive input', () => {
			expect(parseDuration('1H' as Duration)).toBe(3600);
		});
	});

	describe('string input - days', () => {
		it('should parse days correctly', () => {
			expect(parseDuration('1d')).toBe(86400);
			expect(parseDuration('7d')).toBe(604800);
		});

		it('should handle case-insensitive input', () => {
			expect(parseDuration('1D' as Duration)).toBe(86400);
		});
	});

	describe('zero duration', () => {
		it('should handle zero with any unit', () => {
			expect(parseDuration('0s')).toBe(0);
			expect(parseDuration('0m')).toBe(0);
			expect(parseDuration('0h')).toBe(0);
			expect(parseDuration('0d')).toBe(0);
		});

		it('should handle plain zero string', () => {
			expect(parseDuration('0')).toBe(0);
		});
	});

	describe('error cases', () => {
		it('should throw for empty string', () => {
			expect(() => parseDuration('' as Duration)).toThrow('Invalid duration format');
		});

		it('should throw for invalid unit', () => {
			expect(() => parseDuration('5x' as Duration)).toThrow('Invalid duration format: 5x');
			expect(() => parseDuration('10w' as Duration)).toThrow('Invalid duration format: 10w');
		});

		it('should throw for decimal values', () => {
			expect(() => parseDuration('1.5h' as Duration)).toThrow('Invalid duration format');
			expect(() => parseDuration('2.5m' as Duration)).toThrow('Invalid duration format');
		});

		it('should throw for missing value', () => {
			expect(() => parseDuration('m' as Duration)).toThrow('Invalid duration format');
			expect(() => parseDuration('h' as Duration)).toThrow('Invalid duration format');
		});

		it('should throw for spaces', () => {
			expect(() => parseDuration('5 m' as Duration)).toThrow('Invalid duration format');
			expect(() => parseDuration(' 5m' as Duration)).toThrow('Invalid duration format');
		});

		it('should throw for multiple units', () => {
			expect(() => parseDuration('1h30m' as Duration)).toThrow('Invalid duration format');
		});

		it('should throw for string durations exceeding 365 days', () => {
			expect(() => parseDuration('366d' as Duration)).toThrow('Duration exceeds maximum of 365 days');
			expect(() => parseDuration('400d' as Duration)).toThrow('Duration exceeds maximum of 365 days');
		});

		it('should accept string durations at exactly 365 days', () => {
			expect(parseDuration('365d')).toBe(365 * 86400);
		});
	});
});

describe('formatDuration', () => {
	it('should format zero', () => {
		expect(formatDuration(0)).toBe('0s');
	});

	it('should format seconds', () => {
		expect(formatDuration(30)).toBe('30s');
		expect(formatDuration(1)).toBe('1s');
		expect(formatDuration(59)).toBe('59s');
	});

	it('should format minutes when evenly divisible', () => {
		expect(formatDuration(60)).toBe('1m');
		expect(formatDuration(300)).toBe('5m');
		expect(formatDuration(600)).toBe('10m');
	});

	it('should format hours when evenly divisible', () => {
		expect(formatDuration(3600)).toBe('1h');
		expect(formatDuration(7200)).toBe('2h');
	});

	it('should format days when evenly divisible', () => {
		expect(formatDuration(86400)).toBe('1d');
		expect(formatDuration(604800)).toBe('7d');
	});

	it('should prefer larger units when evenly divisible', () => {
		expect(formatDuration(86400)).toBe('1d'); // not 24h
		expect(formatDuration(3600)).toBe('1h'); // not 60m
	});

	it('should fall back to seconds for non-even divisions', () => {
		expect(formatDuration(90)).toBe('90s'); // 1.5m (not divisible by 60)
		expect(formatDuration(5401)).toBe('5401s'); // not divisible by 60
		expect(formatDuration(3601)).toBe('3601s'); // 1h + 1s, not evenly divisible
	});

	it('should throw for negative values', () => {
		expect(() => formatDuration(-1)).toThrow('Duration must be non-negative');
	});
});
