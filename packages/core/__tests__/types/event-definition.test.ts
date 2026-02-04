/**
 * Tests for Event.define() factory function.
 *
 * ## Testing Strategy for Type Definitions
 *
 * Type definitions present a unique testing challenge: TypeScript types are erased
 * at runtime, so we cannot directly test type correctness. Instead, we use:
 *
 * 1. **Runtime Structure Tests** - Verify the returned object has expected properties
 *    (name, payloadSchema, responseSchema, type carriers)
 *
 * 2. **Immutability Tests** - Verify Object.freeze() prevents runtime mutation
 *
 * 3. **Type Carrier Tests** - Verify _payload/_response are undefined at runtime
 *    but exist as enumerable properties (for typeof extraction)
 *
 * 4. **Compile-Time Tests** - Use @ts-expect-error to verify invalid code
 *    produces compile errors (type safety verified at build time)
 *
 * 5. **Schema Edge Cases** - Test with complex TypeBox schemas (unions,
 *    intersections, nested objects) to ensure the factory handles them correctly
 *
 * @see workflow-definition.test.ts for parallel tests on Workflow.define()
 * @see utility.test.ts for type extraction utility tests
 */

import { describe, expect, test } from 'bun:test';
import { Type } from '@orijs/validation';
import { Event } from '../../src/types/event-definition.ts';

describe('Event.define()', () => {
	describe('basic functionality', () => {
		test('should create event definition with correct name', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			expect(UserCreated.name).toBe('user.created');
		});

		test('should store data schema', () => {
			const dataSchema = Type.Object({ userId: Type.String() });
			const UserCreated = Event.define({
				name: 'user.created',
				data: dataSchema,
				result: Type.Void()
			});

			expect(UserCreated.dataSchema).toBe(dataSchema);
		});

		test('should store result schema', () => {
			const resultSchema = Type.Object({ sent: Type.Boolean() });
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: resultSchema
			});

			expect(UserCreated.resultSchema).toBe(resultSchema);
		});

		test('should have undefined type carriers at runtime', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Object({ sent: Type.Boolean() })
			});

			// Type carriers are undefined at runtime
			expect(UserCreated._data).toBeUndefined();
			expect(UserCreated._result).toBeUndefined();
		});
	});

	describe('complex schemas', () => {
		test('should handle nested object schemas', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({
					user: Type.Object({
						id: Type.String(),
						profile: Type.Object({
							name: Type.String(),
							age: Type.Number()
						})
					})
				}),
				result: Type.Void()
			});

			expect(UserCreated.name).toBe('user.created');
			expect(UserCreated.dataSchema).toBeDefined();
		});

		test('should handle array schemas', () => {
			const UsersListed = Event.define({
				name: 'users.listed',
				data: Type.Object({
					filters: Type.Array(Type.String())
				}),
				result: Type.Object({
					users: Type.Array(
						Type.Object({
							id: Type.String(),
							name: Type.String()
						})
					)
				})
			});

			expect(UsersListed.name).toBe('users.listed');
		});

		test('should handle optional fields', () => {
			const UserUpdated = Event.define({
				name: 'user.updated',
				data: Type.Object({
					userId: Type.String(),
					name: Type.Optional(Type.String()),
					email: Type.Optional(Type.String())
				}),
				result: Type.Void()
			});

			expect(UserUpdated.name).toBe('user.updated');
		});

		test('should handle union types', () => {
			const NotificationSent = Event.define({
				name: 'notification.sent',
				data: Type.Object({
					channel: Type.Union([Type.Literal('email'), Type.Literal('sms'), Type.Literal('push')])
				}),
				result: Type.Void()
			});

			expect(NotificationSent.name).toBe('notification.sent');
		});
	});

	describe('void response', () => {
		test('should handle Type.Void() for fire-and-forget events', () => {
			const LogEvent = Event.define({
				name: 'log.event',
				data: Type.Object({ message: Type.String() }),
				result: Type.Void()
			});

			expect(LogEvent.resultSchema).toBeDefined();
			// Response type carrier is still undefined at runtime
			expect(LogEvent._result).toBeUndefined();
		});
	});

	describe('readonly properties', () => {
		test('should have readonly name property', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			// TypeScript would prevent: UserCreated.name = 'other';
			// At runtime, we verify the property exists
			expect(typeof UserCreated.name).toBe('string');
		});
	});

	describe('immutability', () => {
		test('should return a frozen object', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			expect(Object.isFrozen(UserCreated)).toBe(true);
		});

		test('should prevent property modification at runtime', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			// Attempting to modify should throw in strict mode or silently fail
			expect(() => {
				(UserCreated as { name: string }).name = 'modified';
			}).toThrow();
		});

		test('should prevent adding new properties', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			expect(() => {
				(UserCreated as unknown as Record<string, unknown>).newProp = 'value';
			}).toThrow();
		});
	});

	describe('type carrier runtime behavior', () => {
		test('should include type carriers in Object.keys', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			const keys = Object.keys(UserCreated);
			expect(keys).toContain('name');
			expect(keys).toContain('dataSchema');
			expect(keys).toContain('resultSchema');
			expect(keys).toContain('_data');
			expect(keys).toContain('_result');
		});

		test('should omit undefined type carriers in JSON.stringify', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			const json = JSON.stringify(UserCreated);
			const parsed = JSON.parse(json);

			expect(parsed.name).toBe('user.created');
			// JSON.stringify omits undefined values entirely
			expect('_data' in parsed).toBe(false);
			expect('_result' in parsed).toBe(false);
			expect(parsed._data).toBeUndefined();
			expect(parsed._result).toBeUndefined();
		});

		test('should preserve type carriers when spreading', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			const spread = { ...UserCreated };

			expect(spread.name).toBe('user.created');
			expect(spread._data).toBeUndefined();
			expect(spread._result).toBeUndefined();
			expect('_data' in spread).toBe(true);
			expect('_result' in spread).toBe(true);
		});

		test('should handle Object.values with type carriers', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			const values = Object.values(UserCreated);

			// Should include undefined values for type carriers
			expect(values).toContain(undefined);
			expect(values).toContain('user.created');
		});

		test('should handle Object.entries with type carriers', () => {
			const UserCreated = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			const entries = Object.entries(UserCreated);
			const entryMap = new Map(entries);

			expect(entryMap.get('name')).toBe('user.created');
			expect(entryMap.get('_data')).toBeUndefined();
			expect(entryMap.get('_result')).toBeUndefined();
			expect(entryMap.has('_data')).toBe(true);
			expect(entryMap.has('_result')).toBe(true);
		});
	});

	describe('edge cases - complex TypeBox schemas', () => {
		test('should handle deeply nested schemas (4+ levels)', () => {
			const DeepEvent = Event.define({
				name: 'deep.nested',
				data: Type.Object({
					level1: Type.Object({
						level2: Type.Object({
							level3: Type.Object({
								level4: Type.Object({
									value: Type.String()
								})
							})
						})
					})
				}),
				result: Type.Object({
					result: Type.Object({
						nested: Type.Object({
							data: Type.String()
						})
					})
				})
			});

			expect(DeepEvent.name).toBe('deep.nested');
			expect(DeepEvent.dataSchema).toBeDefined();
			expect(DeepEvent.resultSchema).toBeDefined();
		});

		test('should handle discriminated unions', () => {
			const ShapeEvent = Event.define({
				name: 'shape.created',
				data: Type.Union([
					Type.Object({
						type: Type.Literal('circle'),
						radius: Type.Number()
					}),
					Type.Object({
						type: Type.Literal('rectangle'),
						width: Type.Number(),
						height: Type.Number()
					}),
					Type.Object({
						type: Type.Literal('triangle'),
						base: Type.Number(),
						height: Type.Number()
					})
				]),
				result: Type.Object({
					area: Type.Number()
				})
			});

			expect(ShapeEvent.name).toBe('shape.created');
			expect(ShapeEvent.dataSchema).toBeDefined();
		});

		test('should handle intersection types', () => {
			const BaseEntity = Type.Object({
				id: Type.String(),
				createdAt: Type.String()
			});

			const UserFields = Type.Object({
				name: Type.String(),
				email: Type.String()
			});

			const UserEvent = Event.define({
				name: 'user.intersect',
				data: Type.Intersect([BaseEntity, UserFields]),
				result: Type.Void()
			});

			expect(UserEvent.name).toBe('user.intersect');
			expect(UserEvent.dataSchema).toBeDefined();
		});

		test('should handle empty object schemas', () => {
			const EmptyEvent = Event.define({
				name: 'empty.event',
				data: Type.Object({}),
				result: Type.Object({})
			});

			expect(EmptyEvent.name).toBe('empty.event');
			expect(EmptyEvent.dataSchema).toBeDefined();
			expect(EmptyEvent.resultSchema).toBeDefined();
		});

		test('should handle schemas with all optional fields', () => {
			const AllOptionalEvent = Event.define({
				name: 'all.optional',
				data: Type.Object({
					field1: Type.Optional(Type.String()),
					field2: Type.Optional(Type.Number()),
					field3: Type.Optional(Type.Boolean()),
					field4: Type.Optional(Type.Array(Type.String()))
				}),
				result: Type.Object({
					result: Type.Optional(Type.String())
				})
			});

			expect(AllOptionalEvent.name).toBe('all.optional');
		});

		test('should handle record types', () => {
			const RecordEvent = Event.define({
				name: 'record.event',
				data: Type.Object({
					metadata: Type.Record(Type.String(), Type.Unknown())
				}),
				result: Type.Void()
			});

			expect(RecordEvent.name).toBe('record.event');
		});

		test('should handle tuple types', () => {
			const TupleEvent = Event.define({
				name: 'tuple.event',
				data: Type.Object({
					coordinates: Type.Tuple([Type.Number(), Type.Number()]),
					range: Type.Tuple([Type.Number(), Type.Number(), Type.Optional(Type.Number())])
				}),
				result: Type.Void()
			});

			expect(TupleEvent.name).toBe('tuple.event');
		});

		test('should handle nullable types', () => {
			const NullableEvent = Event.define({
				name: 'nullable.event',
				data: Type.Object({
					requiredField: Type.String(),
					nullableField: Type.Union([Type.String(), Type.Null()])
				}),
				result: Type.Union([Type.Object({ data: Type.String() }), Type.Null()])
			});

			expect(NullableEvent.name).toBe('nullable.event');
		});

		test('should handle enum-like unions with many literals', () => {
			const StatusEvent = Event.define({
				name: 'status.changed',
				data: Type.Object({
					status: Type.Union([
						Type.Literal('pending'),
						Type.Literal('processing'),
						Type.Literal('completed'),
						Type.Literal('failed'),
						Type.Literal('cancelled'),
						Type.Literal('refunded'),
						Type.Literal('archived')
					]),
					previousStatus: Type.Union([
						Type.Literal('pending'),
						Type.Literal('processing'),
						Type.Literal('completed'),
						Type.Literal('failed'),
						Type.Literal('cancelled'),
						Type.Literal('refunded'),
						Type.Literal('archived')
					])
				}),
				result: Type.Void()
			});

			expect(StatusEvent.name).toBe('status.changed');
		});

		test('should handle mixed complex schema', () => {
			// Real-world complex event combining multiple patterns
			const OrderProcessedEvent = Event.define({
				name: 'order.processed',
				data: Type.Object({
					orderId: Type.String(),
					customer: Type.Object({
						id: Type.String(),
						type: Type.Union([Type.Literal('individual'), Type.Literal('business')]),
						metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
					}),
					items: Type.Array(
						Type.Object({
							sku: Type.String(),
							quantity: Type.Number(),
							price: Type.Object({
								amount: Type.Number(),
								currency: Type.Union([Type.Literal('USD'), Type.Literal('EUR'), Type.Literal('GBP')])
							}),
							discounts: Type.Optional(
								Type.Array(
									Type.Object({
										code: Type.String(),
										percentage: Type.Number()
									})
								)
							)
						})
					),
					shipping: Type.Union([
						Type.Object({
							type: Type.Literal('standard'),
							estimatedDays: Type.Number()
						}),
						Type.Object({
							type: Type.Literal('express'),
							guaranteedDate: Type.String()
						}),
						Type.Object({
							type: Type.Literal('pickup'),
							location: Type.String()
						})
					]),
					totals: Type.Object({
						subtotal: Type.Number(),
						tax: Type.Number(),
						shipping: Type.Number(),
						total: Type.Number()
					})
				}),
				result: Type.Object({
					confirmationNumber: Type.String(),
					estimatedDelivery: Type.Optional(Type.String()),
					warnings: Type.Optional(Type.Array(Type.String()))
				})
			});

			expect(OrderProcessedEvent.name).toBe('order.processed');
			expect(OrderProcessedEvent.dataSchema).toBeDefined();
			expect(OrderProcessedEvent.resultSchema).toBeDefined();
		});
	});
});
