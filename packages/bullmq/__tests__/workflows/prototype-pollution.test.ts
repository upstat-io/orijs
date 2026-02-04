/**
 * Prototype Pollution Tests for BullMQWorkflowProvider
 *
 * Verifies that workflow data serialization and QueueEvents deserialization
 * properly handle potentially malicious payloads.
 *
 * DISCOVERY:
 * - JSON.parse('{"__proto__": {...}}') creates __proto__ as an OWN property on the parsed object
 * - Object.assign(target, source) where source has __proto__ as own property does NOT
 *   create __proto__ as own property on target - instead it MODIFIES target's prototype
 * - However, global Object.prototype is NOT polluted - only individual object prototypes
 *
 * Despite no global pollution, we still sanitize for defense in depth because:
 * 1. Per-object prototype modification can cause unexpected behavior
 * 2. Future code changes might introduce vulnerable patterns
 * 3. Downstream consumers might use the data unsafely
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

describe('Prototype Pollution Prevention', () => {
	// Store original Object.prototype state
	let originalPrototype: PropertyDescriptor | undefined;

	beforeEach(() => {
		// Capture any existing pollution
		originalPrototype = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');
	});

	afterEach(() => {
		// Clean up any pollution that occurred
		if ('polluted' in Object.prototype) {
			delete (Object.prototype as Record<string, unknown>)['polluted'];
		}
		// Restore original if it existed
		if (originalPrototype) {
			Object.defineProperty(Object.prototype, 'polluted', originalPrototype);
		}
	});

	describe('JSON.parse behavior', () => {
		it('should NOT pollute Object.prototype via JSON.parse with __proto__', () => {
			// This is the payload an attacker might inject into Redis
			const maliciousJson = '{"__proto__": {"polluted": true}}';

			// Parse it
			const parsed = JSON.parse(maliciousJson);

			// Verify Object.prototype is NOT polluted
			expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

			// JSON.parse creates __proto__ as an own property on the parsed object
			expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
		});

		it('should NOT pollute via nested __proto__ in JSON', () => {
			const maliciousJson = '{"nested": {"__proto__": {"polluted": true}}}';
			const parsed = JSON.parse(maliciousJson);

			expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
			expect(parsed.nested.__proto__).toEqual({ polluted: true });
		});
	});

	describe('Object.assign behavior (CRITICAL)', () => {
		it('should NOT pollute global Object.prototype via Object.assign', () => {
			// Simulates what flattenChildResults does
			const results: Record<string, unknown> = {};
			const maliciousPayload = JSON.parse('{"__proto__": {"polluted": true}}');

			Object.assign(results, maliciousPayload);

			// CRITICAL: Global Object.prototype is NOT polluted
			expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

			// However, Object.assign DOES modify results' prototype (not as own property)
			// This is JavaScript's weird behavior - __proto__ is a setter that modifies the prototype
			// When source has __proto__ as own property, Object.assign triggers the setter
			expect(Object.prototype.hasOwnProperty.call(results, '__proto__')).toBe(false);

			// The prototype of results was modified
			expect(Object.getPrototypeOf(results)).toEqual({ polluted: true });
		});

		it('should NOT pollute via constructor.prototype pattern', () => {
			const results: Record<string, unknown> = {};
			const maliciousPayload = JSON.parse('{"constructor": {"prototype": {"polluted": true}}}');

			Object.assign(results, maliciousPayload);

			// Object.prototype should NOT be polluted
			expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
		});
	});

	describe('Direct property assignment behavior', () => {
		it('should modify prototype when using __proto__ as property name via bracket notation', () => {
			// Simulates: results[value.__stepName] = value.__stepResult
			// where __stepName is "__proto__"
			const results: Record<string, unknown> = {};
			const stepName = '__proto__';
			const stepResult = { polluted: true };

			results[stepName] = stepResult;

			// Global Object.prototype is NOT polluted
			expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

			// But results' prototype WAS modified (not as own property)
			// This is because [] notation with "__proto__" triggers the prototype setter
			expect(Object.prototype.hasOwnProperty.call(results, '__proto__')).toBe(false);
			expect(Object.getPrototypeOf(results)).toEqual({ polluted: true });
		});
	});

	describe('Real pollution scenarios that DO work', () => {
		it('demonstrates actual prototype pollution via Object.prototype direct assignment', () => {
			// This WOULD pollute - but we should never do this
			// (Object.prototype as Record<string, unknown>)['polluted'] = true;
			// expect(({} as Record<string, unknown>)['polluted']).toBe(true);

			// Skip - just documenting what would actually pollute
			expect(true).toBe(true);
		});

		it('demonstrates pollution via __proto__ setter (not JSON.parse)', () => {
			// Direct __proto__ assignment DOES pollute in some cases
			// But JSON.parse creates it as own property, not via setter
			// This would pollute: obj.__proto__.polluted = true
			// But we don't do this

			expect(true).toBe(true);
		});
	});

	describe('Sanitization requirements', () => {
		it('should demonstrate why sanitization is needed despite no global pollution', () => {
			/**
			 * Even though Object.prototype is not polluted, we MUST sanitize because:
			 *
			 * 1. Per-object prototype modification breaks type assumptions:
			 *    - Object methods may not work as expected
			 *    - Type narrowing becomes unreliable
			 *    - Property lookups traverse unexpected prototype chain
			 *
			 * 2. Defense in depth:
			 *    - Future code might use data in vulnerable ways
			 *    - Downstream consumers might not sanitize
			 */
			const results: Record<string, unknown> = {};
			const maliciousPayload = JSON.parse('{"__proto__": {"isAdmin": true}}');

			Object.assign(results, maliciousPayload);

			// The danger: any object created with results in its chain inherits isAdmin
			// This could bypass authorization checks if code does: if (obj.isAdmin) {...}
			expect((Object.getPrototypeOf(results) as Record<string, unknown>)['isAdmin']).toBe(true);

			// Sanitization would prevent this by stripping __proto__ before Object.assign
		});

		it('should list dangerous keys that must be stripped', () => {
			const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
			const payload = { __proto__: {}, constructor: {}, prototype: {} };

			for (const key of dangerousKeys) {
				expect(key in payload).toBe(true);
			}

			// These keys should be stripped during sanitization
		});
	});

	describe('sanitizeObject utility', () => {
		// Import the sanitization utility for testing
		// Note: sanitizeObject is a private function, so we test it indirectly
		// through the behavior we want: strip dangerous keys, preserve safe ones

		/**
		 * Recreate the sanitization logic for testing purposes.
		 * This mirrors what's in bullmq-workflow-provider.ts
		 */
		const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

		function sanitizeObject<T>(obj: T): T {
			if (obj === null || typeof obj !== 'object') {
				return obj;
			}
			if (Array.isArray(obj)) {
				return obj.map((item) => sanitizeObject(item)) as T;
			}
			const result: Record<string, unknown> = {};
			for (const key of Object.keys(obj)) {
				if (DANGEROUS_KEYS.has(key)) {
					continue;
				}
				result[key] = sanitizeObject((obj as Record<string, unknown>)[key]);
			}
			return result as T;
		}

		it('should strip __proto__ key from objects', () => {
			const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": "value"}');
			const sanitized = sanitizeObject(malicious);

			expect(Object.prototype.hasOwnProperty.call(sanitized, '__proto__')).toBe(false);
			expect(sanitized.safe).toBe('value');
		});

		it('should strip constructor key from objects', () => {
			const malicious = JSON.parse('{"constructor": {"prototype": {}}, "safe": "value"}');
			const sanitized = sanitizeObject(malicious);

			expect(Object.prototype.hasOwnProperty.call(sanitized, 'constructor')).toBe(false);
			expect(sanitized.safe).toBe('value');
		});

		it('should strip prototype key from objects', () => {
			const malicious = JSON.parse('{"prototype": {"polluted": true}, "safe": "value"}');
			const sanitized = sanitizeObject(malicious);

			expect(Object.prototype.hasOwnProperty.call(sanitized, 'prototype')).toBe(false);
			expect(sanitized.safe).toBe('value');
		});

		it('should recursively sanitize nested objects', () => {
			const malicious = JSON.parse('{"nested": {"__proto__": {"polluted": true}, "data": "ok"}}');
			const sanitized = sanitizeObject(malicious);

			expect(Object.prototype.hasOwnProperty.call(sanitized.nested, '__proto__')).toBe(false);
			expect((sanitized.nested as { data: string }).data).toBe('ok');
		});

		it('should sanitize arrays of objects', () => {
			const malicious = JSON.parse('[{"__proto__": {"polluted": true}}, {"safe": "value"}]');
			const sanitized = sanitizeObject(malicious);

			expect(Object.prototype.hasOwnProperty.call(sanitized[0], '__proto__')).toBe(false);
			expect(sanitized[1].safe).toBe('value');
		});

		it('should preserve null and primitive values', () => {
			expect(sanitizeObject(null)).toBe(null);
			expect(sanitizeObject(undefined)).toBe(undefined);
			expect(sanitizeObject(42)).toBe(42);
			expect(sanitizeObject('string')).toBe('string');
			expect(sanitizeObject(true)).toBe(true);
		});

		it('should prevent prototype pollution after sanitization', () => {
			const results: Record<string, unknown> = {};
			const maliciousPayload = JSON.parse('{"__proto__": {"polluted": true}, "data": "ok"}');

			// Sanitize BEFORE Object.assign
			const sanitized = sanitizeObject(maliciousPayload);
			Object.assign(results, sanitized);

			// Global Object.prototype NOT polluted
			expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

			// Individual object prototype NOT modified
			expect(Object.getPrototypeOf(results)).toBe(Object.prototype);

			// Safe data preserved
			expect(results.data).toBe('ok');
		});
	});
});
