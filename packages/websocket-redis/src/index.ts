/**
 * @orijs/websocket-redis
 *
 * Redis WebSocket provider for OriJS horizontal scaling.
 * Bridges Redis pub/sub to Bun's WebSocket server for cross-instance messaging.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { createRedisWsProvider } from '@orijs/websocket-redis';
 *
 * const provider = createRedisWsProvider({
 *   connection: { host: 'localhost', port: 6379 }
 * });
 *
 * app.websocket(provider);
 * ```
 */

export {
	RedisWsProvider,
	createRedisWsProvider,
	type RedisWsProviderOptions,
	type RedisConnectionOptions
} from './redis-websocket-provider';
