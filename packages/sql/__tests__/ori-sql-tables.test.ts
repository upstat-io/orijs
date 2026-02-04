/**
 * Functional test verifying oriSql works with Tables-style definitions.
 *
 * This test uses mock Tables that follow the same pattern as the
 * Mapper.defineTable API, ensuring the integration will work correctly.
 */

import { describe, expect, it } from 'bun:test';
import { createOriSql } from '../src/ori-sql';
import { createMockSql } from './helpers/mock-sql';

// =============================================================================
// MOCK TABLES (follows Mapper.defineTable pattern)
// =============================================================================

/**
 * Mock Tables following the Mapper.defineTable pattern.
 *
 * Real Tables have:
 * - $name: table name (string)
 * - column properties: column name (string)
 */
const Tables = {
	User: {
		$name: 'user', // Reserved word - Bun/PostgreSQL will handle quoting
		id: 'id',
		uuid: 'uuid',
		email: 'email',
		displayName: 'display_name',
		fbAuthUid: 'fb_uid',
		createdTimestamp: 'created_timestamp'
	},
	Account: {
		$name: 'account', // Not reserved
		id: 'id',
		uuid: 'uuid',
		displayName: 'display_name'
	},
	Project: {
		$name: 'project', // Not reserved
		id: 'id',
		uuid: 'uuid',
		name: 'name',
		accountId: 'account_id'
	},
	Order: {
		$name: 'order', // Reserved word - Bun/PostgreSQL will handle quoting
		id: 'id',
		status: 'status'
	}
} as const;

// =============================================================================
// TESTS
// =============================================================================

describe('oriSql with Tables integration', () => {
	describe('column references', () => {
		it('should pass Tables.User.uuid to Bun sql()', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT ${[Tables.User.uuid]} FROM ${[Tables.User.$name]}`;

			// Both should be converted to identifier markers
			expect(mockSql.lastCall!.values).toHaveLength(2);
			expect(mockSql.isIdentifierMarker(mockSql.lastCall!.values[0])).toBe(true);
			expect(mockSql.isIdentifierMarker(mockSql.lastCall!.values[1])).toBe(true);
			expect((mockSql.lastCall!.values[0] as any).name).toBe('uuid');
			expect((mockSql.lastCall!.values[1] as any).name).toBe('user');
		});

		it('should handle multiple column references', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT ${[Tables.User.uuid]}, ${[Tables.User.email]}, ${[Tables.User.displayName]} FROM ${[Tables.User.$name]}`;

			expect(mockSql.lastCall!.values).toHaveLength(4);
			expect((mockSql.lastCall!.values[0] as any).name).toBe('uuid');
			expect((mockSql.lastCall!.values[1] as any).name).toBe('email');
			expect((mockSql.lastCall!.values[2] as any).name).toBe('display_name');
			expect((mockSql.lastCall!.values[3] as any).name).toBe('user');
		});

		it('should handle snake_case column names', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT ${[Tables.User.createdTimestamp]} FROM ${[Tables.User.$name]}`;

			expect((mockSql.lastCall!.values[0] as any).name).toBe('created_timestamp');
		});
	});

	describe('table name handling', () => {
		it('should pass Tables.User.$name to Bun for reserved word handling', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM ${[Tables.User.$name]}`;

			// 'user' is passed to Bun - Bun/PostgreSQL handles quoting
			expect((mockSql.lastCall!.values[0] as any).name).toBe('user');
		});

		it('should pass Tables.Account.$name to Bun', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM ${[Tables.Account.$name]}`;

			expect((mockSql.lastCall!.values[0] as any).name).toBe('account');
		});

		it('should pass Tables.Order.$name to Bun for reserved word handling', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			oriSql`SELECT * FROM ${[Tables.Order.$name]}`;

			// 'order' is passed to Bun - Bun/PostgreSQL handles quoting
			expect((mockSql.lastCall!.values[0] as any).name).toBe('order');
		});
	});

	describe('JOIN queries with Tables', () => {
		it('should handle JOIN between User and Account', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const userId = 42;

			oriSql`
				SELECT u.${[Tables.User.uuid]}, a.${[Tables.Account.displayName]}
				FROM ${[Tables.User.$name]} u
				INNER JOIN ${[Tables.Account.$name]} a ON a.${[Tables.Account.id]} = u.${[Tables.User.id]}
				WHERE u.${[Tables.User.id]} = ${userId}
			`;

			// Count identifiers and parameters
			const identifiers = mockSql.lastCall!.values.filter((v) => mockSql.isIdentifierMarker(v));
			const params = mockSql.lastCall!.values.filter((v) => !mockSql.isIdentifierMarker(v));

			expect(identifiers).toHaveLength(7);
			expect(params).toEqual([42]);
		});

		it('should handle complex multi-table JOIN', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const accountId = 1;

			oriSql`
				SELECT
					u.${[Tables.User.uuid]} AS user_uuid,
					a.${[Tables.Account.displayName]} AS account_name,
					p.${[Tables.Project.name]} AS project_name
				FROM ${[Tables.Account.$name]} a
				INNER JOIN ${[Tables.User.$name]} u ON u.${[Tables.User.id]} = a.${[Tables.Account.id]}
				INNER JOIN ${[Tables.Project.$name]} p ON p.${[Tables.Project.accountId]} = a.${[Tables.Account.id]}
				WHERE a.${[Tables.Account.id]} = ${accountId}
			`;

			const params = mockSql.lastCall!.values.filter((v) => !mockSql.isIdentifierMarker(v));
			expect(params).toEqual([1]);
		});
	});

	describe('INSERT with Tables', () => {
		it('should handle INSERT using Tables column references', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const userData = {
				email: 'test@example.com',
				displayName: 'Test User',
				fbUid: 'firebase-123'
			};

			oriSql`
				INSERT INTO ${[Tables.User.$name]} (${[Tables.User.email]}, ${[Tables.User.displayName]}, ${[Tables.User.fbAuthUid]})
				VALUES (${userData.email}, ${userData.displayName}, ${userData.fbUid})
				RETURNING ${[Tables.User.id]}, ${[Tables.User.uuid]}
			`;

			const params = mockSql.lastCall!.values.filter((v) => !mockSql.isIdentifierMarker(v));
			expect(params).toEqual(['test@example.com', 'Test User', 'firebase-123']);
		});
	});

	describe('UPDATE with Tables', () => {
		it('should handle UPDATE using Tables references', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const userId = 42;
			const newName = 'Updated Name';

			oriSql`
				UPDATE ${[Tables.User.$name]}
				SET ${[Tables.User.displayName]} = ${newName}
				WHERE ${[Tables.User.id]} = ${userId}
				RETURNING ${[Tables.User.uuid]}
			`;

			const params = mockSql.lastCall!.values.filter((v) => !mockSql.isIdentifierMarker(v));
			expect(params).toEqual(['Updated Name', 42]);
		});
	});

	describe('DELETE with Tables', () => {
		it('should handle DELETE using Tables references', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const userId = 42;

			oriSql`
				DELETE FROM ${[Tables.User.$name]}
				WHERE ${[Tables.User.id]} = ${userId}
			`;

			const params = mockSql.lastCall!.values.filter((v) => !mockSql.isIdentifierMarker(v));
			expect(params).toEqual([42]);
		});
	});

	describe('realistic query patterns', () => {
		it('should handle query pattern from db-user.service.ts', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const firebaseUID = 'firebase-uid-123';

			oriSql`
				SELECT
					${[Tables.User.id]},
					${[Tables.User.uuid]},
					${[Tables.User.displayName]},
					${[Tables.User.email]}
				FROM ${[Tables.User.$name]}
				WHERE ${[Tables.User.fbAuthUid]} = ${firebaseUID}
			`;

			const params = mockSql.lastCall!.values.filter((v) => !mockSql.isIdentifierMarker(v));
			expect(params).toEqual(['firebase-uid-123']);

			// Verify all identifiers were passed
			const identifiers = mockSql.lastCall!.values.filter((v) => mockSql.isIdentifierMarker(v));
			expect(identifiers).toHaveLength(6); // id, uuid, displayName, email, user, fbAuthUid
		});

		it('should handle pagination pattern', () => {
			const mockSql = createMockSql();
			const oriSql = createOriSql(mockSql);

			const accountId = 1;
			const limit = 10;
			const offset = 0;

			oriSql`
				SELECT ${[Tables.User.uuid]}, ${[Tables.User.displayName]}
				FROM ${[Tables.User.$name]}
				WHERE ${[Tables.Account.id]} = ${accountId}
				ORDER BY ${[Tables.User.createdTimestamp]} DESC
				LIMIT ${limit} OFFSET ${offset}
			`;

			const params = mockSql.lastCall!.values.filter((v) => !mockSql.isIdentifierMarker(v));
			expect(params).toEqual([1, 10, 0]);
		});
	});
});
