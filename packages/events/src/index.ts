/**
 * Events Module
 *
 * Public exports for the OriJS event system.
 *
 * Provides:
 * - EventRegistry: Fluent builder for defining events
 * - EventSystem: Type-safe event emission and handling
 * - InProcessEventProvider: Local synchronous event delivery
 * - EventSubscription: Request-response pattern support
 *
 * @example
 * ```typescript
 * import {
 *   EventRegistry,
 *   createEventSystem,
 *   InProcessEventProvider,
 * } from '@orijs/events';
 *
 * // Define events
 * const Events = EventRegistry.create()
 *   .event<UserPayload>('user.created')
 *   .event<OrderPayload>('order.placed')
 *   .build();
 *
 * // Create event system
 * const events = createEventSystem(Events);
 *
 * // Register handler
 * events.onEvent<UserPayload>('user.created', async (ctx) => {
 *   ctx.log.info('User created', { id: ctx.data.id });
 * });
 *
 * // Emit event
 * events.emit('user.created', { id: 1, name: 'Alice' });
 * ```
 */

// Registry
export { EventRegistry } from './event-registry';
export type { EventRegistryBuilder, BuiltEventRegistry } from './event-registry.types';

// Provider interfaces
export { EVENT_MESSAGE_VERSION } from './event-provider.types';
export type {
	EventEmitter,
	EventLifecycle,
	EventProvider,
	EventHandlerFn,
	EventMessage,
	EmitOptions
} from './event-provider.types';

// Subscription
export { EventSubscription, createSubscription } from './event-subscription';
export type { SubscribeCallback, ErrorCallback } from './event-subscription';

// Context
export { createEventContext, createChainedMeta } from './event-context';
export type { EventContext, EventEmitFn, CreateEventContextOptions } from './event-context';

// Composable components
export { HandlerRegistry } from './handler-registry';
export type {
	IHandlerRegistry,
	HandlerRegistration as RegistryHandlerRegistration
} from './handler-registry';

export { EventDeliveryEngine, createChainedEmitFactory } from './event-delivery';
export type {
	IEventDelivery,
	EventDeliveryConfig,
	EventDeliveryLogger,
	ChainedEmitFn,
	CreateChainedEmitFn
} from './event-delivery';

// In-process provider
export { InProcessEventProvider } from './in-process-orchestrator';
export type { InProcessEventProviderOptions } from './in-process-orchestrator';

// Test provider (for unit tests with async simulation)
export { TestEventProvider } from './test-event-provider';
export type { TestEventProviderConfig } from './test-event-provider';

// Handler builder
export { EventHandlerBuilder } from './event-handler-builder';
export type {
	EventBuilder,
	EventHandler,
	EventHandlerClass,
	HandlerRegistration
} from './event-handler-builder';

// Event system factory
export { createEventSystem, createPropagationMeta } from './events';
export type { EventSystem, TypedEmitFn, CreateEventSystemOptions } from './events';

// Idempotency Helper
export { EventIdempotency } from './event-idempotency';
export type { IdempotencyResult, EventIdempotencyOptions } from './event-idempotency';
