/**
 * OriJS Example App
 *
 * Run with: bun run src/app.ts
 */

import { Ori } from '@orijs/orijs';
import { ApiController } from './controllers/api.controller';

Ori.create()
	.controller('/api', ApiController)
	.listen(3000, () => {
		console.log('OriJS example running at http://localhost:3000');
		console.log('Try:');
		console.log('  GET  http://localhost:3000/api');
		console.log('  GET  http://localhost:3000/api/greet/World');
		console.log('  POST http://localhost:3000/api/echo');
	});
