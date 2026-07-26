import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { SendRequestSchema } from '../src/index';
import { getArticleCacheKey } from '../src/article';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('send request validation', () => {
	it('keeps PDF as the default for older API clients', () => {
		const result = SendRequestSchema.parse({
			url: 'https://example.com/article',
			email: 'reader@kindle.com',
		});

		expect(result.format).toBe('pdf');
	});

	it('accepts EPUB explicitly', () => {
		const result = SendRequestSchema.parse({
			url: 'https://example.com/article',
			email: 'reader@kindle.com',
			format: 'epub',
		});

		expect(result.format).toBe('epub');
	});

	it('rejects unsupported URLs and formats', () => {
		expect(SendRequestSchema.safeParse({ url: 'file:///etc/passwd', email: 'reader@kindle.com', format: 'mobi' }).success).toBe(false);
		expect(SendRequestSchema.safeParse({ url: 'http://127.0.0.1/private', email: 'reader@kindle.com', format: 'epub' }).success).toBe(
			false,
		);
	});

	it('returns a useful error for invalid JSON', async () => {
		const request = new IncomingRequest('https://example.com/send', { method: 'POST', body: '{' });
		const response = await worker.fetch(request, env, createExecutionContext());

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Request body must be valid JSON');
	});

	it('rejects oversized request bodies before parsing them', async () => {
		const request = new IncomingRequest('https://example.com/send', {
			method: 'POST',
			body: JSON.stringify({ padding: 'x'.repeat(17 * 1024) }),
		});
		const response = await worker.fetch(request, env, createExecutionContext());

		expect(response.status).toBe(413);
	});

	it('validates requests in the deployed Worker runtime', async () => {
		const response = await SELF.fetch('https://example.com/send', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ url: 'not-a-url', email: 'not-an-email', format: 'epub' }),
		});

		expect(response.status).toBe(400);
	});
});

describe('article cache keys', () => {
	it('separates formats without exposing the source URL', async () => {
		const url = 'https://example.com/private/article';
		const [epubKey, pdfKey] = await Promise.all([getArticleCacheKey(url, 'epub'), getArticleCacheKey(url, 'pdf')]);

		expect(epubKey).not.toBe(pdfKey);
		expect(epubKey).not.toContain(url);
	});
});
