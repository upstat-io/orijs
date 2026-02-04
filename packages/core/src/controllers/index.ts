/**
 * @module controllers
 *
 * HTTP controller system for OriJS.
 *
 * Provides the building blocks for HTTP request handling:
 * - {@link RouteBuilder} - Fluent API for defining routes within controllers
 * - {@link RequestContext} - Request-scoped context passed to handlers
 * - {@link RequestPipeline} - Guards, interceptors, and validation pipeline
 * - {@link ResponseFactory} - Standardized HTTP response creation
 *
 * @example
 * ```ts
 * import { RouteBuilder, RequestContext } from '@orijs/controllers';
 *
 * class MyController implements OriController {
 *   configure(r: RouteBuilder) {
 *     r.get('/users', this.listUsers);
 *     r.post('/users', this.createUser);
 *   }
 *
 *   private listUsers = async (ctx: RequestContext) => {
 *     return Response.json({ users: [] });
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
