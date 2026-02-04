/**
 * Shared validation functions for WebSocket providers.
 *
 * These validators ensure consistent input validation across all provider
 * implementations (InProcWsProvider, RedisWsProvider, etc.).
 *
 * @module
 */

/** Maximum allowed topic name length */
export const MAX_TOPIC_LENGTH = 256;

/** UUID v4 format regex for socket ID validation */
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates a topic name for safety.
 * Uses strict allowlist to prevent injection and logging issues.
 *
 * Allowed characters: a-z, A-Z, 0-9, underscore, colon, dot, hyphen
 *
 * @param topic - The topic name to validate
 * @throws Error if topic is invalid (empty, too long, or contains invalid characters)
 *
 * @example
 * ```typescript
 * validateTopic('room:123');       // OK
 * validateTopic('user.events');    // OK
 * validateTopic('');               // throws: Topic cannot be empty
 * validateTopic('room<script>');   // throws: Topic contains invalid characters
 * ```
 */
export function validateTopic(topic: string): void {
	if (!topic || topic.length === 0) {
		throw new Error('Topic cannot be empty');
	}
	if (topic.length > MAX_TOPIC_LENGTH) {
		throw new Error(`Topic name too long (max ${MAX_TOPIC_LENGTH} characters)`);
	}
	// Strict allowlist: word chars, colons, dots, hyphens only
	if (!/^[\w:.\-]+$/.test(topic)) {
		throw new Error('Topic contains invalid characters (allowed: a-z, A-Z, 0-9, _, :, ., -)');
	}
}

/**
 * Validates a socket ID is a valid UUID v4 format.
 *
 * Socket IDs must be cryptographically random UUIDs to prevent:
 * - Socket enumeration attacks
 * - Message injection to arbitrary sockets
 *
 * @param socketId - The socket ID to validate
 * @throws Error if socketId is not a valid UUID v4
 *
 * @example
 * ```typescript
 * validateSocketId('550e8400-e29b-41d4-a716-446655440000'); // OK
 * validateSocketId('invalid');                               // throws
 * validateSocketId('');                                      // throws
 * ```
 */
export function validateSocketId(socketId: string): void {
	if (!socketId || socketId.length === 0) {
		throw new Error('Socket ID cannot be empty');
	}
	if (!UUID_V4_REGEX.test(socketId)) {
		throw new Error('Invalid socket ID format (must be UUID v4)');
	}
}
