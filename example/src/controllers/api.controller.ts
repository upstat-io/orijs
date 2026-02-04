import type { OriController, RouteBuilder, RequestContext } from '@orijs/orijs';

export class ApiController implements OriController {
	configure(r: RouteBuilder) {
		r.get('/', this.hello);
		r.get('/greet/:name', this.greet);
		r.post('/echo', this.echo);
	}

	private hello = async (_ctx: RequestContext) => {
		return Response.json({ message: 'Hello from OriJS!' });
	};

	private greet = async (ctx: RequestContext) => {
		return Response.json({ message: `Hello, ${ctx.params.name}!` });
	};

	private echo = async (ctx: RequestContext) => {
		return Response.json({ received: await ctx.json() });
	};
}
