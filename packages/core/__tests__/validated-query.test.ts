import { describe, test, expect } from 'bun:test';
import { RequestContext } from '../src/controllers/request-context';
import type { AppContext } from '../src/app-context';

function createMockCtx(queryString = ''): RequestContext {
	const url = queryString ? `http://localhost/test?${queryString}` : 'http://localhost/test';
	const request = new Request(url);
	const queryStart = url.indexOf('?');

	const mockApp = {} as AppContext;
	const loggerOptions = { level: 'info' as const };

	return new RequestContext(
		mockApp,
		request,
		{} as Record<string, string>,
		url,
		queryStart,
		loggerOptions
	);
}

describe('RequestContext validatedQuery', () => {
	test('should fall back to raw query when no schema validation ran', () => {
		const ctx = createMockCtx('page=2&limit=10');
		const result = ctx.validatedQuery;

		// Falls back to raw query (strings)
		expect(result).toEqual({ page: '2', limit: '10' });
	});

	test('should return decoded values after setValidatedQuery', () => {
		const ctx = createMockCtx('page=2&limit=10');

		// Simulate what validateRequest does after schema validation
		ctx.setValidatedQuery({ page: 2, limit: 10 });

		expect(ctx.validatedQuery).toEqual({ page: 2, limit: 10 });
	});

	test('should preserve null decoded value without falling back to raw query', () => {
		const ctx = createMockCtx('filter=none');

		// Schema could decode to null
		ctx.setValidatedQuery(null);

		expect(ctx.validatedQuery).toBeNull();
	});

	test('should preserve undefined decoded value without falling back to raw query', () => {
		const ctx = createMockCtx('filter=none');

		ctx.setValidatedQuery(undefined);

		expect(ctx.validatedQuery).toBeUndefined();
	});

	test('should keep raw query unchanged after setValidatedQuery', () => {
		const ctx = createMockCtx('page=2&limit=10');

		ctx.setValidatedQuery({ page: 2, limit: 10 });

		// Raw query still returns strings
		expect(ctx.query).toEqual({ page: '2', limit: '10' });
	});
});

describe('RequestContext setValidatedBody', () => {
	test('should update body after setValidatedBody', async () => {
		const url = 'http://localhost/test';
		const body = JSON.stringify({ name: 'test' });
		const request = new Request(url, {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/json' }
		});

		const mockApp = {} as AppContext;
		const loggerOptions = { level: 'info' as const };

		const ctx = new RequestContext(
			mockApp,
			request,
			{} as Record<string, string>,
			url,
			-1,
			loggerOptions
		);

		// Simulate schema validation writing back decoded body
		ctx.setValidatedBody({ name: 'test', extra: true });

		// json() should return the decoded body
		const result = await ctx.json();
		expect(result).toEqual({ name: 'test', extra: true });
	});
});

describe('RequestContext correlationId', () => {
	test('should prefer x-correlation-id over x-request-id', () => {
		const url = 'http://localhost/test';
		const request = new Request(url, {
			headers: {
				'x-correlation-id': 'corr-123',
				'x-request-id': 'req-456'
			}
		});

		const mockApp = {} as AppContext;
		const loggerOptions = { level: 'info' as const };

		const ctx = new RequestContext(
			mockApp,
			request,
			{} as Record<string, string>,
			url,
			-1,
			loggerOptions
		);

		expect(ctx.correlationId).toBe('corr-123');
	});

	test('should fall back to x-request-id when x-correlation-id is absent', () => {
		const url = 'http://localhost/test';
		const request = new Request(url, {
			headers: {
				'x-request-id': 'req-456'
			}
		});

		const mockApp = {} as AppContext;
		const loggerOptions = { level: 'info' as const };

		const ctx = new RequestContext(
			mockApp,
			request,
			{} as Record<string, string>,
			url,
			-1,
			loggerOptions
		);

		expect(ctx.correlationId).toBe('req-456');
	});
});
