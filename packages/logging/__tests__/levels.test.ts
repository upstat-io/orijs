import { describe, test, expect } from 'bun:test';
import {
	levels,
	getLevelName,
	getLevelNumber,
	isLevelEnabled,
	type LevelName,
	type LevelNumber
} from '../src/levels.ts';

describe('levels constant', () => {
	test('should have correct numeric value for debug', () => {
		expect(levels.debug).toBe(10);
	});

	test('should have correct numeric value for info', () => {
		expect(levels.info).toBe(20);
	});

	test('should have correct numeric value for warn', () => {
		expect(levels.warn).toBe(30);
	});

	test('should have correct numeric value for error', () => {
		expect(levels.error).toBe(40);
	});

	test('should have levels in ascending order by severity', () => {
		expect(levels.debug).toBeLessThan(levels.info);
		expect(levels.info).toBeLessThan(levels.warn);
		expect(levels.warn).toBeLessThan(levels.error);
	});
});

describe('getLevelName', () => {
	test('should return debug for level 10', () => {
		const name = getLevelName(10);
		expect(name).toBe('debug');
	});

	test('should return info for level 20', () => {
		const name = getLevelName(20);
		expect(name).toBe('info');
	});

	test('should return warn for level 30', () => {
		const name = getLevelName(30);
		expect(name).toBe('warn');
	});

	test('should return error for level 40', () => {
		const name = getLevelName(40);
		expect(name).toBe('error');
	});
});

describe('getLevelNumber', () => {
	test('should return 10 for debug', () => {
		const num = getLevelNumber('debug');
		expect(num).toBe(10);
	});

	test('should return 20 for info', () => {
		const num = getLevelNumber('info');
		expect(num).toBe(20);
	});

	test('should return 30 for warn', () => {
		const num = getLevelNumber('warn');
		expect(num).toBe(30);
	});

	test('should return 40 for error', () => {
		const num = getLevelNumber('error');
		expect(num).toBe(40);
	});
});

describe('getLevelName and getLevelNumber roundtrip', () => {
	const levelPairs: Array<[LevelName, LevelNumber]> = [
		['debug', 10],
		['info', 20],
		['warn', 30],
		['error', 40]
	];

	test.each(levelPairs)('should roundtrip %s <-> %d', (name, num) => {
		expect(getLevelNumber(name)).toBe(num);
		expect(getLevelName(num)).toBe(name);
	});
});

describe('isLevelEnabled', () => {
	describe('when threshold is debug (10)', () => {
		const threshold: LevelNumber = 10;

		test('should enable debug messages', () => {
			expect(isLevelEnabled(10, threshold)).toBe(true);
		});

		test('should enable info messages', () => {
			expect(isLevelEnabled(20, threshold)).toBe(true);
		});

		test('should enable warn messages', () => {
			expect(isLevelEnabled(30, threshold)).toBe(true);
		});

		test('should enable error messages', () => {
			expect(isLevelEnabled(40, threshold)).toBe(true);
		});
	});

	describe('when threshold is info (20)', () => {
		const threshold: LevelNumber = 20;

		test('should disable debug messages', () => {
			expect(isLevelEnabled(10, threshold)).toBe(false);
		});

		test('should enable info messages', () => {
			expect(isLevelEnabled(20, threshold)).toBe(true);
		});

		test('should enable warn messages', () => {
			expect(isLevelEnabled(30, threshold)).toBe(true);
		});

		test('should enable error messages', () => {
			expect(isLevelEnabled(40, threshold)).toBe(true);
		});
	});

	describe('when threshold is warn (30)', () => {
		const threshold: LevelNumber = 30;

		test('should disable debug messages', () => {
			expect(isLevelEnabled(10, threshold)).toBe(false);
		});

		test('should disable info messages', () => {
			expect(isLevelEnabled(20, threshold)).toBe(false);
		});

		test('should enable warn messages', () => {
			expect(isLevelEnabled(30, threshold)).toBe(true);
		});

		test('should enable error messages', () => {
			expect(isLevelEnabled(40, threshold)).toBe(true);
		});
	});

	describe('when threshold is error (40)', () => {
		const threshold: LevelNumber = 40;

		test('should disable debug messages', () => {
			expect(isLevelEnabled(10, threshold)).toBe(false);
		});

		test('should disable info messages', () => {
			expect(isLevelEnabled(20, threshold)).toBe(false);
		});

		test('should disable warn messages', () => {
			expect(isLevelEnabled(30, threshold)).toBe(false);
		});

		test('should enable error messages', () => {
			expect(isLevelEnabled(40, threshold)).toBe(true);
		});
	});

	test('should handle same level as threshold', () => {
		expect(isLevelEnabled(20, 20)).toBe(true);
		expect(isLevelEnabled(30, 30)).toBe(true);
	});
});
