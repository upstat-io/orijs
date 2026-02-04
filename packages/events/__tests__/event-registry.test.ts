/**
 * EventRegistry Unit Tests
 *
 * Tests the event registry fluent builder:
 * - Event name registration
 * - Modular .use() composition
 * - Frozen registry after build
 * - Type-safe event lookups
 */

import { describe, it, expect } from 'bun:test';
import { EventRegistry } from '../src/event-registry';
import type { EventRegistryBuilder } from '../src/event-registry.types';

// --- CREATE TESTS ---

describe('EventRegistry', () => {
	describe('create()', () => {
		it('should create an empty builder', () => {
			const builder = EventRegistry.create();
			expect(builder).toBeDefined();
			expect(typeof builder.event).toBe('function');
			expect(typeof builder.use).toBe('function');
			expect(typeof builder.build).toBe('function');
		});

		it('should build empty registry when no events added', () => {
			const registry = EventRegistry.create().build();

			expect(registry.getEventNames()).toEqual([]);
		});
	});

	// --- EVENT TESTS ---

	describe('event()', () => {
		it('should add a single event', () => {
			const registry = EventRegistry.create().event('user.created').build();

			const eventNames = registry.getEventNames();
			expect(eventNames).toContain('user.created');
			expect(eventNames.length).toBe(1);
		});

		it('should chain multiple events', () => {
			const registry = EventRegistry.create()
				.event('user.created')
				.event('order.placed')
				.event('user.deleted')
				.build();

			const eventNames = registry.getEventNames();
			expect(eventNames).toContain('user.created');
			expect(eventNames).toContain('order.placed');
			expect(eventNames).toContain('user.deleted');
			expect(eventNames.length).toBe(3);
		});

		it('should throw error when duplicate event name', () => {
			expect(() => {
				EventRegistry.create().event('test.event').event('test.event');
			}).toThrow("Event 'test.event' already defined");
		});

		it('should allow empty event name', () => {
			const registry = EventRegistry.create().event('').build();

			expect(registry.getEventNames()).toContain('');
			expect(registry.hasEvent('')).toBe(true);
		});
	});

	// --- COMPOSITION TESTS ---

	describe('use()', () => {
		it('should apply composition function to add events', () => {
			function addUserEvents<T extends string>(
				reg: EventRegistryBuilder<T>
			): EventRegistryBuilder<T | 'user.created' | 'user.deleted'> {
				return reg.event('user.created').event('user.deleted');
			}

			const registry = EventRegistry.create().use(addUserEvents).build();

			expect(registry.getEventNames()).toContain('user.created');
			expect(registry.getEventNames()).toContain('user.deleted');
		});

		it('should chain multiple .use() calls', () => {
			function addUserEvents<T extends string>(
				reg: EventRegistryBuilder<T>
			): EventRegistryBuilder<T | 'user.created'> {
				return reg.event('user.created');
			}

			function addOrderEvents<T extends string>(
				reg: EventRegistryBuilder<T>
			): EventRegistryBuilder<T | 'order.placed'> {
				return reg.event('order.placed');
			}

			const registry = EventRegistry.create().use(addUserEvents).use(addOrderEvents).build();

			expect(registry.getEventNames()).toContain('user.created');
			expect(registry.getEventNames()).toContain('order.placed');
			expect(registry.getEventNames().length).toBe(2);
		});

		it('should combine direct .event() and .use() calls', () => {
			function addAlertEvents<T extends string>(
				reg: EventRegistryBuilder<T>
			): EventRegistryBuilder<T | 'alert.triggered'> {
				return reg.event('alert.triggered');
			}

			const registry = EventRegistry.create()
				.event('user.created')
				.use(addAlertEvents)
				.event('order.placed')
				.build();

			expect(registry.getEventNames().length).toBe(3);
			expect(registry.getEventNames()).toContain('user.created');
			expect(registry.getEventNames()).toContain('alert.triggered');
			expect(registry.getEventNames()).toContain('order.placed');
		});
	});

	// --- BUILD TESTS ---

	describe('build()', () => {
		it('should return frozen registry', () => {
			const registry = EventRegistry.create().event('test.event').build();

			expect(Object.isFrozen(registry)).toBe(true);
		});

		it('should return frozen event names array', () => {
			const registry = EventRegistry.create().event('a').event('b').build();

			const names = registry.getEventNames();
			expect(Object.isFrozen(names)).toBe(true);
		});

		it('should allow builder reuse after build', () => {
			const builder = EventRegistry.create().event('event.one');

			const registry1 = builder.build();

			// Continue building
			const registry2 = builder.event('event.two').build();

			// First registry should have only one event
			expect(registry1.getEventNames().length).toBe(1);
			expect(registry1.getEventNames()).toContain('event.one');

			// Second registry should have both events
			expect(registry2.getEventNames().length).toBe(2);
			expect(registry2.getEventNames()).toContain('event.one');
			expect(registry2.getEventNames()).toContain('event.two');
		});
	});

	// --- getEventNames() TESTS ---

	describe('getEventNames()', () => {
		it('should return empty array for empty registry', () => {
			const registry = EventRegistry.create().build();
			expect(registry.getEventNames()).toEqual([]);
		});

		it('should return all registered event names', () => {
			const registry = EventRegistry.create().event('user.created').event('order.placed').build();

			const names = registry.getEventNames();
			expect(names).toContain('user.created');
			expect(names).toContain('order.placed');
			expect(names.length).toBe(2);
		});

		it('should preserve insertion order', () => {
			const registry = EventRegistry.create().event('a').event('b').event('c').build();

			expect(registry.getEventNames()).toEqual(['a', 'b', 'c']);
		});
	});

	// --- hasEvent() TESTS ---

	describe('hasEvent()', () => {
		it('should return true for existing event', () => {
			const registry = EventRegistry.create().event('user.created').build();

			expect(registry.hasEvent('user.created')).toBe(true);
		});

		it('should return false for non-existing event', () => {
			const registry = EventRegistry.create().event('user.created').build();

			expect(registry.hasEvent('nonexistent')).toBe(false);
		});

		it('should return false for empty registry', () => {
			const registry = EventRegistry.create().build();
			expect(registry.hasEvent('any.event')).toBe(false);
		});
	});

	// --- REAL-WORLD EXAMPLE TESTS ---

	describe('real-world usage', () => {
		it('should build a complete domain event registry', () => {
			// Build registry with modular composition
			function addUserEvents<T extends string>(
				reg: EventRegistryBuilder<T>
			): EventRegistryBuilder<T | 'user.registered' | 'user.verified' | 'user.deleted'> {
				return reg.event('user.registered').event('user.verified').event('user.deleted');
			}

			function addMonitorEvents<T extends string>(
				reg: EventRegistryBuilder<T>
			): EventRegistryBuilder<T | 'monitor.created' | 'monitor.status.changed' | 'monitor.deleted'> {
				return reg.event('monitor.created').event('monitor.status.changed').event('monitor.deleted');
			}

			const Events = EventRegistry.create().use(addUserEvents).use(addMonitorEvents).build();

			// Verify all events registered
			expect(Events.getEventNames().length).toBe(6);
			expect(Events.hasEvent('user.registered')).toBe(true);
			expect(Events.hasEvent('monitor.status.changed')).toBe(true);
		});
	});

	// --- TYPE SAFETY TESTS ---

	describe('type safety', () => {
		it('should provide type-safe event lookups via hasEvent', () => {
			const registry = EventRegistry.create().event('user.created').event('order.placed').build();

			// These should compile and work at runtime
			expect(registry.hasEvent('user.created')).toBe(true);
			expect(registry.hasEvent('order.placed')).toBe(true);
			expect(registry.hasEvent('unknown')).toBe(false);
		});

		it('should accumulate types through .event() chain', () => {
			const registry = EventRegistry.create().event('a').event('b').event('c').build();

			// Type should be 'a' | 'b' | 'c'
			expect(registry.hasEvent('a')).toBe(true);
			expect(registry.hasEvent('b')).toBe(true);
			expect(registry.hasEvent('c')).toBe(true);
		});

		it('should accumulate types through .use() composition', () => {
			function addEvents<T extends string>(
				reg: EventRegistryBuilder<T>
			): EventRegistryBuilder<T | 'composed.event'> {
				return reg.event('composed.event');
			}

			const registry = EventRegistry.create().event('direct.event').use(addEvents).build();

			// Both should be accessible
			expect(registry.hasEvent('direct.event')).toBe(true);
			expect(registry.hasEvent('composed.event')).toBe(true);
		});
	});
});
