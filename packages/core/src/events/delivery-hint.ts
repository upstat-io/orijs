import { Kind, type TSchema } from '@sinclair/typebox';

/**
 * Classifies an event definition's result schema into a transport delivery hint.
 *
 * `EventConfig.result` uses `Type.Void()` to mark a fire-and-forget event, whose
 * promise resolves once the event is queued rather than when a consumer replies.
 * Transports receive this verdict through `EmitOptions.expectsResult` because the
 * schema itself never crosses the provider boundary.
 *
 * An absent schema reports `true` so callers emitting without a definition keep
 * request-response semantics.
 */
export function expectsResultFromSchema(resultSchema: TSchema | undefined): boolean {
	return resultSchema?.[Kind] !== 'Void';
}
