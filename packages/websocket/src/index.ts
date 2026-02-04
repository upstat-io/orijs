/**
 * @orijs/websocket - WebSocket support for OriJS applications
 *
 * Provides WebSocket connection management with pub/sub messaging patterns.
 * Supports multiple providers for different deployment scenarios:
 * - `InProcWsProvider` - Single-instance deployments using Bun's native pub/sub
 * - `RedisWsProvider` - Multi-instance deployments with Redis (@orijs/websocket-redis)
 *
 * @packageDocumentation
 */

// Types
export type {
	BunServer,
	SocketData,
	WebSocketConnection,
	WebSocketUpgradeOptions,
	WebSocketHandlers,
	SocketEmitter,
	SocketLifecycle,
	WebSocketProvider,
	WebSocketProviderOptions,
	SocketEmitterConstructor,
	SocketCoordinatorOptions,
	SocketMessageLike
} from './types';

// Tokens
export { WebSocketProviderToken } from './types';

// Classes
export { SocketCoordinator } from './socket-coordinator';
export { InProcWsProvider, createInProcWsProvider } from './in-proc-provider';

// Message Registry (opinionated message handling)
export { MessageRegistry, createMessageRegistry } from './message-registry';
export type { ServerMessageDefinition, MessageHandler, HandleResult } from './message-registry';

// Control Messages (built-in server-side message definitions)
export { ServerMessage, JoinRoom, LeaveRoom, Heartbeat } from './control-messages';
export type { JoinRoomData, LeaveRoomData, HeartbeatData } from './control-messages';

// Validation (shared across providers)
export { validateTopic, validateSocketId, MAX_TOPIC_LENGTH, UUID_V4_REGEX } from './validation';

// Re-export options type
export type { InProcWsProviderOptions } from './in-proc-provider';
