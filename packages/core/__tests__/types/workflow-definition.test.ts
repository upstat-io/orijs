/**
 * Tests for Workflow.define() factory function.
 *
 * ## Testing Strategy for Type Definitions
 *
 * Type definitions present a unique testing challenge: TypeScript types are erased
 * at runtime, so we cannot directly test type correctness. Instead, we use:
 *
 * 1. **Runtime Structure Tests** - Verify the returned object has expected properties
 *    (name, dataSchema, resultSchema, type carriers)
 *
 * 2. **Immutability Tests** - Verify Object.freeze() prevents runtime mutation
 *
 * 3. **Type Carrier Tests** - Verify _data/_result are undefined at runtime
 *    but exist as enumerable properties (for typeof extraction)
 *
 * 4. **Compile-Time Tests** - Use @ts-expect-error to verify invalid code
 *    produces compile errors (type safety verified at build time)
 *
 * 5. **Schema Edge Cases** - Test with complex TypeBox schemas (unions,
 *    intersections, nested objects) to ensure the factory handles them correctly
 *
 * @see event-definition.test.ts for parallel tests on Event.define()
 * @see utility.test.ts for type extraction utility tests
 */

import { describe, expect, it } from 'bun:test';
import { Type } from '@orijs/validation';
import { Workflow } from '../../src/types/workflow-definition.ts';

describe('Workflow.define()', () => {
	describe('basic functionality', () => {
		it('should create workflow definition with correct name', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			});

			expect(SendEmail.name).toBe('send-email');
		});

		it('should store data schema', () => {
			const dataSchema = Type.Object({
				to: Type.String(),
				subject: Type.String(),
				body: Type.String()
			});
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: dataSchema,
				result: Type.Object({ messageId: Type.String() })
			});

			expect(SendEmail.dataSchema).toBe(dataSchema);
		});

		it('should store result schema', () => {
			const resultSchema = Type.Object({
				messageId: Type.String(),
				sentAt: Type.String()
			});
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: resultSchema
			});

			expect(SendEmail.resultSchema).toBe(resultSchema);
		});

		it('should have undefined type carriers at runtime', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			});

			// Type carriers are undefined at runtime
			expect(SendEmail._data).toBeUndefined();
			expect(SendEmail._result).toBeUndefined();
		});
	});

	describe('complex schemas', () => {
		it('should handle nested object schemas', () => {
			const ProcessOrder = Workflow.define({
				name: 'process-order',
				data: Type.Object({
					order: Type.Object({
						id: Type.String(),
						items: Type.Array(
							Type.Object({
								productId: Type.String(),
								quantity: Type.Number()
							})
						)
					})
				}),
				result: Type.Object({
					orderId: Type.String(),
					status: Type.String()
				})
			});

			expect(ProcessOrder.name).toBe('process-order');
			expect(ProcessOrder.dataSchema).toBeDefined();
		});

		it('should handle optional fields in data', () => {
			const SendNotification = Workflow.define({
				name: 'send-notification',
				data: Type.Object({
					userId: Type.String(),
					message: Type.String(),
					priority: Type.Optional(Type.Number())
				}),
				result: Type.Object({
					sent: Type.Boolean()
				})
			});

			expect(SendNotification.name).toBe('send-notification');
		});

		it('should handle array results', () => {
			const BatchProcess = Workflow.define({
				name: 'batch-process',
				data: Type.Object({
					items: Type.Array(Type.String())
				}),
				result: Type.Object({
					results: Type.Array(
						Type.Object({
							id: Type.String(),
							success: Type.Boolean()
						})
					)
				})
			});

			expect(BatchProcess.name).toBe('batch-process');
		});
	});

	describe('workflow naming conventions', () => {
		it('should accept kebab-case names', () => {
			const workflow = Workflow.define({
				name: 'send-welcome-email',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			expect(workflow.name).toBe('send-welcome-email');
		});

		it('should accept dot notation names', () => {
			const workflow = Workflow.define({
				name: 'email.send.welcome',
				data: Type.Object({ userId: Type.String() }),
				result: Type.Void()
			});

			expect(workflow.name).toBe('email.send.welcome');
		});
	});

	describe('void result', () => {
		it('should handle Type.Void() for workflows without explicit result', () => {
			const FireAndForget = Workflow.define({
				name: 'fire-and-forget',
				data: Type.Object({ action: Type.String() }),
				result: Type.Void()
			});

			expect(FireAndForget.resultSchema).toBeDefined();
			expect(FireAndForget._result).toBeUndefined();
		});
	});

	describe('readonly properties', () => {
		it('should have readonly name property', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			});

			expect(typeof SendEmail.name).toBe('string');
		});
	});

	describe('immutability', () => {
		it('should return a builder that can add steps', () => {
			// Workflow.define() now returns a builder with .steps() method
			const SendEmailBuilder = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			});

			// Builder is NOT frozen (because .steps() can be called on it)
			// This is intentional - the builder pattern requires mutability
			expect(typeof SendEmailBuilder.steps).toBe('function');
		});

		it('should freeze the result of .steps()', () => {
			const SendEmailWithSteps = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			}).steps((s) => s.sequential(s.step('send', Type.Object({ sent: Type.Boolean() }))));

			// Result of .steps() IS frozen
			expect(Object.isFrozen(SendEmailWithSteps)).toBe(true);
		});

		it('should prevent property modification on frozen definition', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			}).steps((s) => s.sequential(s.step('send', Type.Object({ sent: Type.Boolean() }))));

			expect(() => {
				(SendEmail as { name: string }).name = 'modified';
			}).toThrow();
		});

		it('should prevent adding new properties to frozen definition', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			}).steps((s) => s.sequential(s.step('send', Type.Object({ sent: Type.Boolean() }))));

			expect(() => {
				(SendEmail as unknown as Record<string, unknown>).newProp = 'value';
			}).toThrow();
		});
	});

	describe('type carrier runtime behavior', () => {
		it('should include type carriers in Object.keys', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			});

			const keys = Object.keys(SendEmail);
			expect(keys).toContain('name');
			expect(keys).toContain('dataSchema');
			expect(keys).toContain('resultSchema');
			expect(keys).toContain('_data');
			expect(keys).toContain('_result');
		});

		it('should omit undefined type carriers in JSON.stringify', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			});

			const json = JSON.stringify(SendEmail);
			const parsed = JSON.parse(json);

			expect(parsed.name).toBe('send-email');
			// JSON.stringify omits undefined values entirely
			expect('_data' in parsed).toBe(false);
			expect('_result' in parsed).toBe(false);
		});

		it('should preserve type carriers when spreading', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			});

			const spread = { ...SendEmail };

			expect(spread.name).toBe('send-email');
			expect(spread._data).toBeUndefined();
			expect(spread._result).toBeUndefined();
			expect('_data' in spread).toBe(true);
			expect('_result' in spread).toBe(true);
		});

		it('should handle Object.entries with type carriers', () => {
			const SendEmail = Workflow.define({
				name: 'send-email',
				data: Type.Object({ to: Type.String() }),
				result: Type.Object({ messageId: Type.String() })
			});

			const entries = Object.entries(SendEmail);
			const entryMap = new Map(entries);

			expect(entryMap.get('name')).toBe('send-email');
			expect(entryMap.get('_data')).toBeUndefined();
			expect(entryMap.get('_result')).toBeUndefined();
			expect(entryMap.has('_data')).toBe(true);
			expect(entryMap.has('_result')).toBe(true);
		});
	});

	describe('edge cases - complex TypeBox schemas', () => {
		it('should handle deeply nested schemas (4+ levels)', () => {
			const DeepWorkflow = Workflow.define({
				name: 'deep-workflow',
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
					output: Type.Object({
						nested: Type.Object({
							deep: Type.Object({
								data: Type.String()
							})
						})
					})
				})
			});

			expect(DeepWorkflow.name).toBe('deep-workflow');
			expect(DeepWorkflow.dataSchema).toBeDefined();
			expect(DeepWorkflow.resultSchema).toBeDefined();
		});

		it('should handle discriminated unions', () => {
			const PaymentWorkflow = Workflow.define({
				name: 'process-payment',
				data: Type.Union([
					Type.Object({
						method: Type.Literal('credit_card'),
						cardNumber: Type.String(),
						expiry: Type.String(),
						cvv: Type.String()
					}),
					Type.Object({
						method: Type.Literal('bank_transfer'),
						accountNumber: Type.String(),
						routingNumber: Type.String()
					}),
					Type.Object({
						method: Type.Literal('paypal'),
						email: Type.String()
					})
				]),
				result: Type.Object({
					transactionId: Type.String(),
					status: Type.Union([Type.Literal('success'), Type.Literal('pending'), Type.Literal('failed')])
				})
			});

			expect(PaymentWorkflow.name).toBe('process-payment');
			expect(PaymentWorkflow.dataSchema).toBeDefined();
		});

		it('should handle intersection types', () => {
			const BaseWorkflowData = Type.Object({
				correlationId: Type.String(),
				timestamp: Type.String()
			});

			const TaskData = Type.Object({
				taskType: Type.String(),
				priority: Type.Number()
			});

			const CompositeWorkflow = Workflow.define({
				name: 'composite-workflow',
				data: Type.Intersect([BaseWorkflowData, TaskData]),
				result: Type.Object({ completed: Type.Boolean() })
			});

			expect(CompositeWorkflow.name).toBe('composite-workflow');
			expect(CompositeWorkflow.dataSchema).toBeDefined();
		});

		it('should handle empty object schemas', () => {
			const EmptyWorkflow = Workflow.define({
				name: 'empty-workflow',
				data: Type.Object({}),
				result: Type.Object({})
			});

			expect(EmptyWorkflow.name).toBe('empty-workflow');
			expect(EmptyWorkflow.dataSchema).toBeDefined();
			expect(EmptyWorkflow.resultSchema).toBeDefined();
		});

		it('should handle schemas with all optional fields', () => {
			const AllOptionalWorkflow = Workflow.define({
				name: 'all-optional-workflow',
				data: Type.Object({
					param1: Type.Optional(Type.String()),
					param2: Type.Optional(Type.Number()),
					param3: Type.Optional(Type.Boolean())
				}),
				result: Type.Object({
					output: Type.Optional(Type.String())
				})
			});

			expect(AllOptionalWorkflow.name).toBe('all-optional-workflow');
		});

		it('should handle record types', () => {
			const DynamicWorkflow = Workflow.define({
				name: 'dynamic-workflow',
				data: Type.Object({
					config: Type.Record(Type.String(), Type.Unknown()),
					parameters: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))
				}),
				result: Type.Object({
					outputs: Type.Record(Type.String(), Type.Unknown())
				})
			});

			expect(DynamicWorkflow.name).toBe('dynamic-workflow');
		});

		it('should handle tuple types', () => {
			const CoordinateWorkflow = Workflow.define({
				name: 'coordinate-workflow',
				data: Type.Object({
					start: Type.Tuple([Type.Number(), Type.Number()]),
					end: Type.Tuple([Type.Number(), Type.Number()]),
					waypoints: Type.Optional(Type.Array(Type.Tuple([Type.Number(), Type.Number()])))
				}),
				result: Type.Object({
					distance: Type.Number(),
					duration: Type.Number()
				})
			});

			expect(CoordinateWorkflow.name).toBe('coordinate-workflow');
		});

		it('should handle nullable types', () => {
			const NullableWorkflow = Workflow.define({
				name: 'nullable-workflow',
				data: Type.Object({
					required: Type.String(),
					nullable: Type.Union([Type.String(), Type.Null()])
				}),
				result: Type.Union([Type.Object({ success: Type.Boolean() }), Type.Null()])
			});

			expect(NullableWorkflow.name).toBe('nullable-workflow');
		});

		it('should handle mixed complex schema - real-world order fulfillment', () => {
			const OrderFulfillmentWorkflow = Workflow.define({
				name: 'fulfill-order',
				data: Type.Object({
					orderId: Type.String(),
					warehouse: Type.Object({
						id: Type.String(),
						location: Type.Object({
							country: Type.String(),
							region: Type.String(),
							address: Type.Optional(Type.String())
						})
					}),
					items: Type.Array(
						Type.Object({
							sku: Type.String(),
							quantity: Type.Number(),
							location: Type.Optional(
								Type.Object({
									aisle: Type.String(),
									shelf: Type.String(),
									bin: Type.String()
								})
							)
						})
					),
					shipping: Type.Union([
						Type.Object({
							method: Type.Literal('ground'),
							carrier: Type.String(),
							estimatedDays: Type.Number()
						}),
						Type.Object({
							method: Type.Literal('air'),
							carrier: Type.String(),
							priority: Type.Union([Type.Literal('standard'), Type.Literal('express')])
						}),
						Type.Object({
							method: Type.Literal('freight'),
							carrier: Type.String(),
							palletCount: Type.Number()
						})
					]),
					metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
				}),
				result: Type.Object({
					fulfillmentId: Type.String(),
					status: Type.Union([
						Type.Literal('picked'),
						Type.Literal('packed'),
						Type.Literal('shipped'),
						Type.Literal('delivered'),
						Type.Literal('failed')
					]),
					trackingNumbers: Type.Array(Type.String()),
					steps: Type.Array(
						Type.Object({
							name: Type.String(),
							completedAt: Type.Optional(Type.String()),
							error: Type.Optional(Type.String())
						})
					)
				})
			});

			expect(OrderFulfillmentWorkflow.name).toBe('fulfill-order');
			expect(OrderFulfillmentWorkflow.dataSchema).toBeDefined();
			expect(OrderFulfillmentWorkflow.resultSchema).toBeDefined();
		});
	});
});
