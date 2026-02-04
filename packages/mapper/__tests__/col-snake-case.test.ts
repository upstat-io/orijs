import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper';
import { field } from '../src/field';

describe('.col() auto snake_case conversion', () => {
	const Tables = Mapper.defineTables({
		User: {
			tableName: 'user',
			uuid: field('uuid').string()
		}
	});

	describe('automatic column inference', () => {
		test('should convert camelCase to snake_case', () => {
			interface UserWithCols {
				uuid: string;
				activeIncidentCount: number;
				isOnCall: boolean;
				createdByUuid: string;
			}

			const mapper = Mapper.for<UserWithCols>(Tables.User)
				.col<number>('activeIncidentCount')
				.default(0)
				.col<boolean>('isOnCall')
				.default(false)
				.col<string>('createdByUuid')
				.default('')
				.build();

			const row = {
				uuid: 'user-123',
				active_incident_count: 5,
				is_on_call: true,
				created_by_uuid: 'abc-456'
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				activeIncidentCount: 5,
				isOnCall: true,
				createdByUuid: 'abc-456'
			});
		});

		test('should handle single-word property names', () => {
			interface UserWithScore {
				uuid: string;
				score: number;
				count: number;
			}

			const mapper = Mapper.for<UserWithScore>(Tables.User)
				.col<number>('score')
				.default(0)
				.col<number>('count')
				.default(0)
				.build();

			const row = {
				uuid: 'user-123',
				score: 100,
				count: 42
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				score: 100,
				count: 42
			});
		});

		test('should handle multiple uppercase letters', () => {
			interface UserWithHTTP {
				uuid: string;
				httpStatusCode: number;
				apiResponseTime: number;
			}

			const mapper = Mapper.for<UserWithHTTP>(Tables.User)
				.col<number>('httpStatusCode')
				.default(0)
				.col<number>('apiResponseTime')
				.default(0)
				.build();

			const row = {
				uuid: 'user-123',
				http_status_code: 200,
				api_response_time: 150
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				httpStatusCode: 200,
				apiResponseTime: 150
			});
		});
	});

	describe('explicit column override', () => {
		test('should use explicit column when provided', () => {
			interface UserWithAuthor {
				uuid: string;
				createdBy: string;
			}

			const mapper = Mapper.for<UserWithAuthor>(Tables.User)
				.col<string>('createdBy', 'author_uuid')
				.default('')
				.build();

			const row = {
				uuid: 'user-123',
				author_uuid: 'author-456',
				created_by: 'should-be-ignored' // This won't be used
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				createdBy: 'author-456'
			});
		});

		test('should allow same property and column name with explicit override', () => {
			interface UserWithTotal {
				uuid: string;
				total: number;
			}

			const mapper = Mapper.for<UserWithTotal>(Tables.User)
				.col<number>('total', 'grand_total')
				.default(0)
				.build();

			const row = {
				uuid: 'user-123',
				grand_total: 999,
				total: 0 // This won't be used
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				total: 999
			});
		});
	});

	describe('edge cases', () => {
		test('should handle property starting with lowercase', () => {
			interface UserWithId {
				uuid: string;
				id: number;
			}

			const mapper = Mapper.for<UserWithId>(Tables.User).col<number>('id').default(0).build();

			const row = {
				uuid: 'user-123',
				id: 42
			};

			const result = mapper.map(row).value();

			expect(result?.id).toBe(42);
		});

		test('should handle consecutive uppercase letters (acronym at end)', () => {
			interface UserWithURL {
				uuid: string;
				webhookURL: string;
			}

			const mapper = Mapper.for<UserWithURL>(Tables.User).col<string>('webhookURL').default('').build();

			// webhookURL → webhook_url (URL treated as single unit)
			const row = {
				uuid: 'user-123',
				webhook_url: 'https://example.com'
			};

			const result = mapper.map(row).value();

			expect(result?.webhookURL).toBe('https://example.com');
		});

		test('should handle acronym at start of property name', () => {
			interface UserWithXML {
				uuid: string;
				xmlParser: string;
			}

			const mapper = Mapper.for<UserWithXML>(Tables.User).col<string>('xmlParser').default('').build();

			// xmlParser → xml_parser (starts lowercase, normal conversion)
			const row = {
				uuid: 'user-123',
				xml_parser: 'libxml'
			};

			const result = mapper.map(row).value();

			expect(result?.xmlParser).toBe('libxml');
		});

		test('should handle acronym in middle of property name', () => {
			interface UserWithXML {
				uuid: string;
				parseXMLDocument: string;
			}

			const mapper = Mapper.for<UserWithXML>(Tables.User).col<string>('parseXMLDocument').default('').build();

			// parseXMLDocument → parse_xml_document (XML is single unit)
			const row = {
				uuid: 'user-123',
				parse_xml_document: 'doc.xml'
			};

			const result = mapper.map(row).value();

			expect(result?.parseXMLDocument).toBe('doc.xml');
		});

		test('should handle multiple acronyms', () => {
			interface UserWithHTTPS {
				uuid: string;
				httpsURLValidator: string;
			}

			const mapper = Mapper.for<UserWithHTTPS>(Tables.User)
				.col<string>('httpsURLValidator')
				.default('')
				.build();

			// httpsURLValidator → https_url_validator
			const row = {
				uuid: 'user-123',
				https_url_validator: 'strict'
			};

			const result = mapper.map(row).value();

			expect(result?.httpsURLValidator).toBe('strict');
		});

		test('should handle single uppercase followed by lowercase', () => {
			interface UserWithName {
				uuid: string;
				firstName: string;
				lastName: string;
			}

			const mapper = Mapper.for<UserWithName>(Tables.User)
				.col<string>('firstName')
				.default('')
				.col<string>('lastName')
				.default('')
				.build();

			const row = {
				uuid: 'user-123',
				first_name: 'John',
				last_name: 'Doe'
			};

			const result = mapper.map(row).value();

			expect(result?.firstName).toBe('John');
			expect(result?.lastName).toBe('Doe');
		});

		test('should handle property that is all lowercase', () => {
			interface UserWithStatus {
				uuid: string;
				status: string;
			}

			const mapper = Mapper.for<UserWithStatus>(Tables.User).col<string>('status').default('').build();

			// status → status (no change)
			const row = {
				uuid: 'user-123',
				status: 'active'
			};

			const result = mapper.map(row).value();

			expect(result?.status).toBe('active');
		});

		test('should handle two-letter acronym at end', () => {
			interface UserWithIO {
				uuid: string;
				diskIO: number;
			}

			const mapper = Mapper.for<UserWithIO>(Tables.User).col<number>('diskIO').default(0).build();

			// diskIO → disk_io
			const row = {
				uuid: 'user-123',
				disk_io: 100
			};

			const result = mapper.map(row).value();

			expect(result?.diskIO).toBe(100);
		});

		test('should handle three-letter acronym followed by word', () => {
			interface UserWithAPI {
				uuid: string;
				apiKeyHash: string;
			}

			const mapper = Mapper.for<UserWithAPI>(Tables.User).col<string>('apiKeyHash').default('').build();

			// apiKeyHash → api_key_hash (starts lowercase)
			const row = {
				uuid: 'user-123',
				api_key_hash: 'abc123'
			};

			const result = mapper.map(row).value();

			expect(result?.apiKeyHash).toBe('abc123');
		});

		test('should handle ID suffix correctly', () => {
			interface UserWithIDs {
				uuid: string;
				parentID: number;
				teamID: number;
			}

			const mapper = Mapper.for<UserWithIDs>(Tables.User)
				.col<number>('parentID')
				.default(0)
				.col<number>('teamID')
				.default(0)
				.build();

			// parentID → parent_id, teamID → team_id
			const row = {
				uuid: 'user-123',
				parent_id: 1,
				team_id: 2
			};

			const result = mapper.map(row).value();

			expect(result?.parentID).toBe(1);
			expect(result?.teamID).toBe(2);
		});

		test('should handle UUID suffix correctly', () => {
			interface UserWithUUIDs {
				uuid: string;
				accountUUID: string;
				projectUUID: string;
			}

			const mapper = Mapper.for<UserWithUUIDs>(Tables.User)
				.col<string>('accountUUID')
				.default('')
				.col<string>('projectUUID')
				.default('')
				.build();

			// accountUUID → account_uuid, projectUUID → project_uuid
			const row = {
				uuid: 'user-123',
				account_uuid: 'acc-456',
				project_uuid: 'proj-789'
			};

			const result = mapper.map(row).value();

			expect(result?.accountUUID).toBe('acc-456');
			expect(result?.projectUUID).toBe('proj-789');
		});

		test('should work with .default() chaining', () => {
			interface UserWithOptional {
				uuid: string;
				lastLoginAt?: string;
			}

			const mapper = Mapper.for<UserWithOptional>(Tables.User)
				.col<string | undefined>('lastLoginAt')
				.default(undefined)
				.build();

			const row = {
				uuid: 'user-123'
				// last_login_at not present
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				lastLoginAt: undefined
			});
		});

		test('should work with .optional() for null columns', () => {
			interface UserWithOptional {
				uuid: string;
				lastLoginAt?: string;
			}

			const mapper = Mapper.for<UserWithOptional>(Tables.User).col<string>('lastLoginAt').optional().build();

			const row = {
				uuid: 'user-123',
				last_login_at: null
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				lastLoginAt: undefined
			});
		});

		test('should work with .optional() for missing columns', () => {
			interface UserWithOptional {
				uuid: string;
				lastLoginAt?: string;
			}

			const mapper = Mapper.for<UserWithOptional>(Tables.User).col<string>('lastLoginAt').optional().build();

			const row = {
				uuid: 'user-123'
				// last_login_at not present
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				lastLoginAt: undefined
			});
		});

		test('should return value when present with .optional()', () => {
			interface UserWithOptional {
				uuid: string;
				lastLoginAt?: string;
			}

			const mapper = Mapper.for<UserWithOptional>(Tables.User).col<string>('lastLoginAt').optional().build();

			const row = {
				uuid: 'user-123',
				last_login_at: '2024-01-15T10:30:00Z'
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				lastLoginAt: '2024-01-15T10:30:00Z'
			});
		});

		test('should work with other builder methods', () => {
			interface UserWithExtras {
				uuid: string;
				displayName?: string;
				incidentCount: number;
			}

			const Tables2 = Mapper.defineTables({
				User: {
					tableName: 'user',
					uuid: field('uuid').string(),
					displayName: field('display_name').string().optional()
				}
			});

			const mapper = Mapper.for<UserWithExtras>(Tables2.User)
				.col<number>('incidentCount')
				.default(0)
				.transform('displayName', (v) => v?.toUpperCase())
				.build();

			const row = {
				uuid: 'user-123',
				display_name: 'john doe',
				incident_count: 3
			};

			const result = mapper.map(row).value();

			expect(result).toEqual({
				uuid: 'user-123',
				displayName: 'JOHN DOE',
				incidentCount: 3
			});
		});
	});
});
