import { describe, test, expect } from 'bun:test';
import { coerceNumber, coerceDate, coerceBoolean, coerceString } from '../src/coercion';
import { MapperError } from '../src/mapper-error';

/**
 * Helper to verify MapperError is thrown with correct context.
 * Reduces repetition in error context verification tests.
 */
function expectMapperError(fn: () => void, expected: { table: string; column: string; type: string }): void {
	try {
		fn();
		expect.unreachable('should have thrown');
	} catch (e) {
		expect(e).toBeInstanceOf(MapperError);
		const err = e as MapperError;
		expect(err.tableName).toBe(expected.table);
		expect(err.columnName).toBe(expected.column);
		expect(err.expectedType).toBe(expected.type);
	}
}

describe('coercion functions', () => {
	describe('coerceNumber()', () => {
		test('should return number when input is valid numeric string', () => {
			const result = coerceNumber('42', 'test_table', 'test_col');
			expect(result).toBe(42);
		});

		test('should return number when input is numeric string with decimals', () => {
			const result = coerceNumber('3.14', 'test_table', 'test_col');
			expect(result).toBe(3.14);
		});

		test('should return number when input is already a number', () => {
			const result = coerceNumber(100, 'test_table', 'test_col');
			expect(result).toBe(100);
		});

		test('should return zero when input is string "0"', () => {
			const result = coerceNumber('0', 'test_table', 'test_col');
			expect(result).toBe(0);
		});

		test('should return zero when input is number 0', () => {
			const result = coerceNumber(0, 'test_table', 'test_col');
			expect(result).toBe(0);
		});

		test('should throw MapperError when input is non-numeric string', () => {
			expect(() => coerceNumber('abc', 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should throw MapperError with correct context when input is invalid', () => {
			expectMapperError(() => coerceNumber('not-a-number', 'user', 'age'), {
				table: 'user',
				column: 'age',
				type: 'number'
			});
		});

		test('should throw MapperError when input is null', () => {
			expect(() => coerceNumber(null, 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should throw MapperError when input is undefined', () => {
			expect(() => coerceNumber(undefined, 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should throw MapperError when input is empty string', () => {
			expect(() => coerceNumber('', 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should return negative number when input is negative string', () => {
			const result = coerceNumber('-5', 'test_table', 'test_col');
			expect(result).toBe(-5);
		});

		test('should return number when input is scientific notation string', () => {
			const result = coerceNumber('1e10', 'test_table', 'test_col');
			expect(result).toBe(1e10);
		});
	});

	describe('coerceNumber() boundary values', () => {
		test('should return MAX_SAFE_INTEGER when input equals MAX_SAFE_INTEGER', () => {
			const result = coerceNumber(Number.MAX_SAFE_INTEGER, 'test_table', 'test_col');
			expect(result).toBe(Number.MAX_SAFE_INTEGER);
		});

		test('should return MIN_SAFE_INTEGER when input equals MIN_SAFE_INTEGER', () => {
			const result = coerceNumber(Number.MIN_SAFE_INTEGER, 'test_table', 'test_col');
			expect(result).toBe(Number.MIN_SAFE_INTEGER);
		});

		test('should return Infinity when input is Infinity', () => {
			const result = coerceNumber(Infinity, 'test_table', 'test_col');
			expect(result).toBe(Infinity);
		});

		test('should return negative Infinity when input is negative Infinity', () => {
			const result = coerceNumber(-Infinity, 'test_table', 'test_col');
			expect(result).toBe(-Infinity);
		});

		test('should preserve negative zero when input is -0', () => {
			const result = coerceNumber(-0, 'test_table', 'test_col');
			expect(Object.is(result, -0)).toBe(true);
		});

		test('should return number when input is whitespace-padded string', () => {
			const result = coerceNumber('  42  ', 'test_table', 'test_col');
			expect(result).toBe(42);
		});

		test('should return very small decimal when input is very small decimal', () => {
			const result = coerceNumber(1e-20, 'test_table', 'test_col');
			expect(result).toBe(1e-20);
		});

		test('should return MAX_SAFE_INTEGER when input is string representation', () => {
			const result = coerceNumber('9007199254740991', 'test_table', 'test_col');
			expect(result).toBe(Number.MAX_SAFE_INTEGER);
		});

		test('should return number when input is string with leading zeros', () => {
			const result = coerceNumber('007', 'test_table', 'test_col');
			expect(result).toBe(7);
		});

		test('should return very small decimal when input is string in scientific notation', () => {
			const result = coerceNumber('1e-20', 'test_table', 'test_col');
			expect(result).toBe(1e-20);
		});
	});

	describe('coerceDate()', () => {
		test('should return Date when input is ISO string', () => {
			const result = coerceDate('2024-01-15T10:30:00.000Z', 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.toISOString()).toBe('2024-01-15T10:30:00.000Z');
		});

		test('should return Date when input is date-only string', () => {
			const result = coerceDate('2024-01-15', 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getFullYear()).toBe(2024);
		});

		test('should return same Date object when input is already Date', () => {
			const input = new Date('2024-01-15T10:30:00.000Z');
			const result = coerceDate(input, 'test_table', 'test_col');
			expect(result).toBe(input);
		});

		test('should return Date when input is timestamp number', () => {
			const timestamp = 1705317000000; // 2024-01-15T10:30:00.000Z
			const result = coerceDate(timestamp, 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getTime()).toBe(timestamp);
		});

		test('should throw MapperError when input is invalid date string', () => {
			expect(() => coerceDate('not-a-date', 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should throw MapperError with correct context when input is invalid', () => {
			expectMapperError(() => coerceDate('invalid', 'monitor', 'last_check'), {
				table: 'monitor',
				column: 'last_check',
				type: 'date'
			});
		});

		test('should throw MapperError when input is null', () => {
			expect(() => coerceDate(null, 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should throw MapperError when input is undefined', () => {
			expect(() => coerceDate(undefined, 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should throw MapperError when input is empty string', () => {
			expect(() => coerceDate('', 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should return Date before epoch when input is negative timestamp', () => {
			const timestamp = -86400000; // 1969-12-31
			const result = coerceDate(timestamp, 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getTime()).toBe(timestamp);
		});
	});

	describe('coerceDate() boundary values', () => {
		test('should return epoch date when timestamp is 0', () => {
			const result = coerceDate(0, 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getTime()).toBe(0);
		});

		test('should preserve milliseconds when input is ISO string with ms precision', () => {
			const result = coerceDate('2024-01-15T10:30:00.123Z', 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getMilliseconds()).toBe(123);
		});

		test('should convert to UTC when input has positive timezone offset', () => {
			// +05:30 is 5.5 hours ahead of UTC, so 10:30+05:30 = 05:00 UTC
			const result = coerceDate('2024-01-15T10:30:00+05:30', 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getUTCHours()).toBe(5);
			expect(result.getUTCMinutes()).toBe(0);
		});

		test('should convert to UTC when input has negative timezone offset', () => {
			// -05:00 is 5 hours behind UTC, so 10:30-05:00 = 15:30 UTC
			const result = coerceDate('2024-01-15T10:30:00-05:00', 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getUTCHours()).toBe(15);
			expect(result.getUTCMinutes()).toBe(30);
		});

		test('should return max date when input is maximum valid timestamp', () => {
			// Max date: 8640000000000000 (Sep 13, 275760)
			const maxTimestamp = 8640000000000000;
			const result = coerceDate(maxTimestamp, 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getTime()).toBe(maxTimestamp);
		});

		test('should throw MapperError when timestamp exceeds maximum', () => {
			const beyondMax = 8640000000000001;
			expect(() => coerceDate(beyondMax, 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should return min date when input is minimum valid timestamp', () => {
			// Min date: -8640000000000000 (Apr 20, -271821)
			const minTimestamp = -8640000000000000;
			const result = coerceDate(minTimestamp, 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getTime()).toBe(minTimestamp);
		});

		test('should return correct date when input is at year boundary', () => {
			const result = coerceDate('1999-12-31T23:59:59.999Z', 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getUTCFullYear()).toBe(1999);
			expect(result.getUTCMonth()).toBe(11); // December
			expect(result.getUTCDate()).toBe(31);
		});

		test('should return valid date when input is near leap second boundary', () => {
			// JavaScript Date doesn't support leap seconds, but should parse correctly
			// The exact timestamp for 2016-12-31T23:59:59Z is 1483228799000
			const result = coerceDate('2016-12-31T23:59:59Z', 'test_table', 'test_col');
			expect(result).toBeInstanceOf(Date);
			expect(result.getTime()).toBe(1483228799000);
		});
	});

	describe('coerceBoolean()', () => {
		test('should return true when input is boolean true', () => {
			const result = coerceBoolean(true);
			expect(result).toBe(true);
		});

		test('should return false when input is boolean false', () => {
			const result = coerceBoolean(false);
			expect(result).toBe(false);
		});

		test('should return true when input is number 1', () => {
			const result = coerceBoolean(1);
			expect(result).toBe(true);
		});

		test('should return false when input is number 0', () => {
			const result = coerceBoolean(0);
			expect(result).toBe(false);
		});

		test('should return true when input is truthy string', () => {
			const result = coerceBoolean('yes');
			expect(result).toBe(true);
		});

		test('should return false when input is empty string', () => {
			const result = coerceBoolean('');
			expect(result).toBe(false);
		});

		test('should return false when input is null', () => {
			const result = coerceBoolean(null);
			expect(result).toBe(false);
		});

		test('should return false when input is undefined', () => {
			const result = coerceBoolean(undefined);
			expect(result).toBe(false);
		});

		test('should return true when input is empty object', () => {
			const result = coerceBoolean({});
			expect(result).toBe(true);
		});

		test('should return true when input is empty array', () => {
			const result = coerceBoolean([]);
			expect(result).toBe(true);
		});

		test('should return true when input is non-zero number', () => {
			const result = coerceBoolean(42);
			expect(result).toBe(true);
		});
	});

	describe('coerceString()', () => {
		test('should return string when input is string value', () => {
			const result = coerceString('hello', 'test_table', 'test_col');
			expect(result).toBe('hello');
		});

		test('should return empty string when input is empty string', () => {
			const result = coerceString('', 'test_table', 'test_col');
			expect(result).toBe('');
		});

		test('should return string when input is number', () => {
			const result = coerceString(42, 'test_table', 'test_col');
			expect(result).toBe('42');
		});

		test('should return string when input is boolean', () => {
			const result = coerceString(true, 'test_table', 'test_col');
			expect(result).toBe('true');
		});

		test('should throw MapperError when input is null', () => {
			expect(() => coerceString(null, 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should throw MapperError with correct context when input is null', () => {
			expectMapperError(() => coerceString(null, 'account', 'display_name'), {
				table: 'account',
				column: 'display_name',
				type: 'string'
			});
		});

		test('should throw MapperError when input is undefined', () => {
			expect(() => coerceString(undefined, 'test_table', 'test_col')).toThrow(MapperError);
		});

		test('should return string when input contains special characters', () => {
			const result = coerceString('hello "world"!', 'test_table', 'test_col');
			expect(result).toBe('hello "world"!');
		});

		test('should return string when input contains unicode', () => {
			const result = coerceString('Hello 世界 🌍', 'test_table', 'test_col');
			expect(result).toBe('Hello 世界 🌍');
		});
	});

	describe('coerceString() boundary values', () => {
		test('should return full string when input is very long (10KB)', () => {
			const longString = 'x'.repeat(10000);
			const result = coerceString(longString, 'test_table', 'test_col');
			expect(result).toBe(longString);
			expect(result.length).toBe(10000);
		});

		test('should preserve null bytes when input contains them', () => {
			const stringWithNull = 'hello\0world';
			const result = coerceString(stringWithNull, 'test_table', 'test_col');
			expect(result).toBe('hello\0world');
			expect(result.length).toBe(11);
		});

		test('should use custom toString when input is object with toString()', () => {
			const customObj = {
				toString() {
					return 'custom-value';
				}
			};
			const result = coerceString(customObj, 'test_table', 'test_col');
			expect(result).toBe('custom-value');
		});

		test('should return [object Object] when input is plain object', () => {
			const result = coerceString({}, 'test_table', 'test_col');
			expect(result).toBe('[object Object]');
		});

		test('should return comma-separated values when input is array', () => {
			const result = coerceString([1, 2, 3], 'test_table', 'test_col');
			expect(result).toBe('1,2,3');
		});

		test('should return "null" when object toString() returns null', () => {
			const customObj = {
				toString() {
					return null as unknown as string;
				}
			};
			const result = coerceString(customObj, 'test_table', 'test_col');
			expect(result).toBe('null');
		});

		test('should return full string when input is very long unicode string', () => {
			const unicodeString = '🌍'.repeat(1000);
			const result = coerceString(unicodeString, 'test_table', 'test_col');
			expect(result).toBe(unicodeString);
		});

		test('should preserve whitespace when input is only whitespace', () => {
			const whitespace = '   \t\n   ';
			const result = coerceString(whitespace, 'test_table', 'test_col');
			expect(result).toBe(whitespace);
		});

		test('should preserve newlines when input contains newlines', () => {
			const multiline = 'line1\nline2\nline3';
			const result = coerceString(multiline, 'test_table', 'test_col');
			expect(result).toBe(multiline);
		});

		test('should preserve control characters when input contains them', () => {
			const withControls = 'a\x00\x01\x02b';
			const result = coerceString(withControls, 'test_table', 'test_col');
			expect(result).toBe(withControls);
		});
	});
});
