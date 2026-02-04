import { describe, it, expect } from 'bun:test';
import { Mapper, field } from '../src';

describe('MapResult fluent API', () => {
	const UserTable = Mapper.defineTable({
		tableName: 'user',
		uuid: field('uuid').string(),
		displayName: field('display_name').string().optional(),
		email: field('email').string().optional()
	});

	interface User {
		uuid: string;
		displayName?: string;
		email?: string;
	}

	const UserMapper = Mapper.for<User>(UserTable).build();

	describe('.value()', () => {
		it('should return mapped result', () => {
			const row = { uuid: 'user-123', display_name: 'John' };
			const result = UserMapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'John',
				email: undefined
			});
		});

		it('should return undefined for null row', () => {
			const result = UserMapper.map(null).value();
			expect(result).toBeUndefined();
		});

		it('should return undefined for undefined row', () => {
			const result = UserMapper.map(undefined).value();
			expect(result).toBeUndefined();
		});
	});

	describe('.default()', () => {
		it('should return result when row exists', () => {
			const row = { uuid: 'user-123' };
			const result = UserMapper.map(row).default(null);

			expect(result).not.toBeNull();
			expect(result!.uuid).toBe('user-123');
		});

		it('should return default value when row is null', () => {
			const result = UserMapper.map(null).default(null);
			expect(result).toBeNull();
		});

		it('should return default value when row is undefined', () => {
			const result = UserMapper.map(undefined).default(null);
			expect(result).toBeNull();
		});

		it('should return custom default object when row is null', () => {
			const defaultUser: User = { uuid: 'default', displayName: 'Default User' };
			const result = UserMapper.map(null).default(defaultUser);

			expect(result).toEqual(defaultUser);
		});
	});

	describe('.mergeWhen()', () => {
		it('should merge extra fields when condition is true', () => {
			const row = { uuid: 'user-123' };
			const extra = { displayName: 'Merged Name', email: 'merged@example.com' };

			const result = UserMapper.map(row).mergeWhen(true, extra).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'Merged Name',
				email: 'merged@example.com'
			});
		});

		it('should NOT merge when condition is false', () => {
			const row = { uuid: 'user-123' };
			const extra = { displayName: 'Should Not Appear' };

			const result = UserMapper.map(row).mergeWhen(false, extra).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: undefined,
				email: undefined
			});
		});

		it('should NOT merge when extra is undefined', () => {
			const row = { uuid: 'user-123', display_name: 'Original' };

			const result = UserMapper.map(row).mergeWhen(true, undefined).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'Original',
				email: undefined
			});
		});

		it('should NOT merge when row is null', () => {
			const extra = { displayName: 'Should Not Appear' };

			const result = UserMapper.map(null).mergeWhen(true, extra).value();

			expect(result).toBeUndefined();
		});

		it('should be chainable', () => {
			const row = { uuid: 'user-123' };
			const extra1 = { displayName: 'Name' };
			const extra2 = { email: 'email@example.com' };

			const result = UserMapper.map(row).mergeWhen(true, extra1).mergeWhen(true, extra2).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'Name',
				email: 'email@example.com'
			});
		});
	});

	describe('combined usage', () => {
		it('should support .mergeWhen().default() chain', () => {
			const row = { uuid: 'user-123' };
			const extra = { displayName: 'Merged' };

			const result = UserMapper.map(row).mergeWhen(true, extra).default(null);

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'Merged',
				email: undefined
			});
		});

		it('should return default when row is null after mergeWhen', () => {
			const extra = { displayName: 'Merged' };

			const result = UserMapper.map(null).mergeWhen(true, extra).default(null);

			expect(result).toBeNull();
		});

		it('should handle the common pattern: map().mergeWhen(!!extra, extra).default(null)', () => {
			const row = { uuid: 'user-123' };

			// With extra
			const extra: Partial<User> | undefined = { displayName: 'Extra Name' };
			const withExtra = UserMapper.map(row).mergeWhen(!!extra, extra).default(null);
			expect(withExtra).toEqual({
				uuid: 'user-123',
				displayName: 'Extra Name',
				email: undefined
			});

			// Without extra
			const noExtra: Partial<User> | undefined = undefined;
			const withoutExtra = UserMapper.map(row).mergeWhen(!!noExtra, noExtra).default(null);
			expect(withoutExtra).toEqual({
				uuid: 'user-123',
				displayName: undefined,
				email: undefined
			});

			// Null row
			const nullRow = UserMapper.map(null).mergeWhen(!!extra, extra).default(null);
			expect(nullRow).toBeNull();
		});
	});
});
