/**
 * Tests to verify if TypeBox validation protects against prototype pollution.
 *
 * Question: When JSON with __proto__ is validated through TypeBox,
 * does TypeBox strip the dangerous keys or pass them through?
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Type, Value, validate } from '../src/index.ts';

describe('TypeBox Prototype Pollution Protection', () => {
	let originalPrototype: PropertyDescriptor | undefined;

	beforeEach(() => {
		originalPrototype = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');
	});

	afterEach(() => {
		if ('polluted' in Object.prototype) {
			delete (Object.prototype as Record<string, unknown>)['polluted'];
		}
		if (originalPrototype) {
			Object.defineProperty(Object.prototype, 'polluted', originalPrototype);
		}
	});

	describe('Value.Decode behavior', () => {
		it('should check if TypeBox strips __proto__ during decode', () => {
			const schema = Type.Object({
				name: Type.String()
			});

			// Simulate what happens when request body has __proto__
			const malicious = JSON.parse('{"name": "test", "__proto__": {"polluted": true}}');

			// Decode through TypeBox
			const decoded = Value.Decode(schema, malicious) as Record<string, unknown>;

			// Does TypeBox strip __proto__?
			console.log('Decoded object:', decoded);
			console.log('Has own __proto__:', Object.prototype.hasOwnProperty.call(decoded, '__proto__'));
			console.log('Keys:', Object.keys(decoded));

			// Check if __proto__ was stripped
			const hasProto = Object.prototype.hasOwnProperty.call(decoded, '__proto__');
			console.log('TypeBox strips __proto__:', !hasProto);
		});

		it('should check if Object.assign with decoded value pollutes', () => {
			const schema = Type.Object({
				name: Type.String()
			});

			const malicious = JSON.parse('{"name": "test", "__proto__": {"polluted": true}}');
			const decoded = Value.Decode(schema, malicious) as Record<string, unknown>;

			// Now use Object.assign like we might in app code
			const target: Record<string, unknown> = {};
			Object.assign(target, decoded);

			// Is target's prototype modified?
			const prototypeModified = Object.getPrototypeOf(target) !== Object.prototype;
			console.log('Target prototype modified:', prototypeModified);
			console.log('Target prototype:', Object.getPrototypeOf(target));

			// Is global Object.prototype polluted?
			const globalPolluted = ({} as Record<string, unknown>)['polluted'] !== undefined;
			console.log('Global Object.prototype polluted:', globalPolluted);
		});
	});

	describe('Value.Clean behavior', () => {
		it('should check if Value.Clean removes unknown properties', () => {
			const schema = Type.Object({
				name: Type.String()
			});

			const malicious = JSON.parse('{"name": "test", "__proto__": {"polluted": true}, "extra": "field"}');

			// Clean removes properties not in schema
			const cleaned = Value.Clean(schema, malicious) as Record<string, unknown>;

			console.log('Cleaned object:', cleaned);
			console.log('Has __proto__:', Object.prototype.hasOwnProperty.call(cleaned, '__proto__'));
			console.log('Has extra:', Object.prototype.hasOwnProperty.call(cleaned, 'extra'));
			console.log('Keys:', Object.keys(cleaned));
		});
	});

	describe('validate() function behavior', () => {
		it('should check if validate() with strict schema rejects __proto__', async () => {
			// Strict schema - no additional properties
			const schema = Type.Object(
				{
					name: Type.String()
				},
				{ additionalProperties: false }
			);

			const malicious = JSON.parse('{"name": "test", "__proto__": {"polluted": true}}');

			const result = await validate(schema, malicious);

			console.log('Validation result:', result);
			console.log('Success:', result.success);
			if (!result.success) {
				console.log('Errors:', result.errors);
			} else {
				console.log('Data:', result.data);
				console.log('Data has __proto__:', Object.prototype.hasOwnProperty.call(result.data, '__proto__'));
			}
		});

		it('should check if validate() without strict schema passes __proto__', async () => {
			// Non-strict schema - allows additional properties
			const schema = Type.Object({
				name: Type.String()
			});

			const malicious = JSON.parse('{"name": "test", "__proto__": {"polluted": true}}');

			const result = await validate(schema, malicious);

			console.log('Validation result (non-strict):', result);
			if (result.success) {
				const data = result.data as Record<string, unknown>;
				console.log('Data:', data);
				console.log('Data has __proto__:', Object.prototype.hasOwnProperty.call(data, '__proto__'));
				console.log('Keys:', Object.keys(data));
			}
		});
	});

	describe('Real-world controller simulation', () => {
		it('should simulate controller body parsing flow', async () => {
			// This simulates: ctx.json() -> validate(schema, body) -> use data

			const schema = Type.Object({
				name: Type.String(),
				email: Type.String()
			});

			// 1. Request body parsed (simulating ctx.json())
			const requestBody = JSON.parse(
				'{"name": "test", "email": "test@example.com", "__proto__": {"isAdmin": true}}'
			);

			// 2. Validated through TypeBox (simulating request-pipeline.ts)
			const validationResult = await validate(schema, requestBody);

			if (validationResult.success) {
				const data = validationResult.data as Record<string, unknown>;

				// 3. Used in service (simulating Object.assign or spread)
				const serviceInput: Record<string, unknown> = { ...data };

				console.log('\n=== Controller Simulation Results ===');
				console.log('Validated data:', data);
				console.log('Data has __proto__:', Object.prototype.hasOwnProperty.call(data, '__proto__'));
				console.log('Service input:', serviceInput);
				console.log('Service input prototype:', Object.getPrototypeOf(serviceInput));
				console.log('Service input has isAdmin:', 'isAdmin' in serviceInput);

				// The critical question: is isAdmin accessible?
				const hasIsAdmin = (serviceInput as Record<string, unknown>)['isAdmin'] !== undefined;
				console.log('Can access isAdmin on serviceInput:', hasIsAdmin);
			}
		});
	});

	describe('Object.assign vs Spread comparison', () => {
		it('should show difference between Object.assign and spread', async () => {
			const schema = Type.Object({
				name: Type.String()
			});

			const malicious = JSON.parse('{"name": "test", "__proto__": {"isAdmin": true}}');
			const result = await validate(schema, malicious);

			if (result.success) {
				const data = result.data as Record<string, unknown>;

				console.log('\n=== Object.assign vs Spread ===');

				// Spread operator - SAFE
				const spreadResult: Record<string, unknown> = { ...data };
				console.log('Spread result prototype:', Object.getPrototypeOf(spreadResult));
				console.log('Spread isAdmin accessible:', (spreadResult as { isAdmin?: boolean }).isAdmin);

				// Object.assign - DANGEROUS
				const assignTarget: Record<string, unknown> = {};
				Object.assign(assignTarget, data);
				console.log('Object.assign prototype:', Object.getPrototypeOf(assignTarget));
				console.log('Object.assign isAdmin accessible:', (assignTarget as { isAdmin?: boolean }).isAdmin);

				// Bracket notation assignment - DANGEROUS
				const bracketTarget: Record<string, unknown> = {};
				for (const key of Object.keys(data)) {
					bracketTarget[key] = (data as Record<string, unknown>)[key];
				}
				console.log('Bracket assign prototype:', Object.getPrototypeOf(bracketTarget));

				// Key insight: spread is safe because it creates a NEW object with standard prototype
				// Object.assign mutates the TARGET, triggering __proto__ setter
			}
		});

		it('should verify Json.sanitize in validation layer protects ALL schemas', async () => {
			// Strict schema with additionalProperties: false
			const strictSchema = Type.Object(
				{
					name: Type.String()
				},
				{ additionalProperties: false }
			);

			// Permissive schema - would be unsafe without sanitization
			const permissiveSchema = Type.Object({
				name: Type.String()
			});

			const malicious = JSON.parse('{"name": "test", "__proto__": {"isAdmin": true}}');

			const strictResult = await validate(strictSchema, malicious);
			const permissiveResult = await validate(permissiveSchema, malicious);

			console.log('\n=== Schema Strictness Comparison ===');
			console.log('Strict schema result:', strictResult.success);
			console.log('Permissive schema result:', permissiveResult.success);

			// Both schemas succeed because Json.sanitize strips __proto__ BEFORE validation
			// This is defense-in-depth - even without additionalProperties: false,
			// dangerous keys are stripped by the validation layer
			expect(strictResult.success).toBe(true);
			expect(permissiveResult.success).toBe(true);

			// Verify __proto__ was stripped from both results
			if (strictResult.success) {
				expect(Object.prototype.hasOwnProperty.call(strictResult.data, '__proto__')).toBe(false);
			}
			if (permissiveResult.success) {
				expect(Object.prototype.hasOwnProperty.call(permissiveResult.data, '__proto__')).toBe(false);
			}
		});
	});
});
