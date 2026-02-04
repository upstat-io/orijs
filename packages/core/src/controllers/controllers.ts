/**
 * Controllers - HTTP request handling for OriJS
 *
 * Provides route building, request context, pipeline execution,
 * and response factories for HTTP controllers.
 *
 * @example
 * ```ts
 * import { RouteBuilder, RequestContext, ResponseFactory } from '@orijs/controllers';
 *
 * class UserController implements OriController {
 *   configure(r: RouteBuilder) {
 *     r.guard(AuthGuard);
 *     r.get('/me', this.getMe);
 *   }
 *
 *   private getMe = async (ctx: RequestContext) => {
 *     return Response.json(ctx.state.user);
 *   };
 * }
 * ```
 */

// Main classes
export { RouteBuilder } from './route-builder';
export { RequestContext, RequestContextFactory } from './request-context';
export { RequestPipeline } from './request-pipeline';
export { ResponseFactory, responseFactory } from './response';
export { OriResponse } from './ori-response';
export { RequestBoundSocketEmitter } from './request-bound-emitters';

// Types
export type { CompiledRoute, BunRequest, BunRouteHandler } from './request-pipeline';
export type { SseEvent, SseStreamOptions } from './response';
