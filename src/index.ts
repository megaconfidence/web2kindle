import { z } from 'zod';
import { ARTICLE_FORMATS, isAllowedSourceUrl } from './article';
export { Workflow } from './workflow';
export { BrowserController } from './browser';

const MAX_REQUEST_BYTES = 16 * 1024;

export const SendRequestSchema = z.object({
	url: z.string().max(4096).url().refine(isAllowedSourceUrl, 'URL must be a public HTTP or HTTPS address'),
	email: z.string().email().max(254),
	format: z.enum(ARTICLE_FORMATS).default('pdf'),
});

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		if (new URL(request.url).pathname !== '/send' || request.method !== 'POST') {
			return new Response('invalid request', { status: 400 });
		}

		let body: unknown;
		try {
			body = await readJsonBody(request);
		} catch (error) {
			if (error instanceof RequestBodyTooLargeError) {
				return new Response('Request body is too large', { status: 413 });
			}
			return new Response('Request body must be valid JSON', { status: 400 });
		}

		const { success, data, error } = SendRequestSchema.safeParse(body);

		if (!success) {
			return new Response(error.issues[0].message, { status: 400 });
		}

		const { url, email, format } = data;

		const workflow = await env.WORKFLOW.create({ params: { url, email, format } });

		return Response.json({
			id: workflow.id,
			details: await workflow.status(),
		});
	},
} satisfies ExportedHandler<Env>;

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new RequestBodyTooLargeError();
	if (!request.body) throw new SyntaxError('Missing request body');

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_REQUEST_BYTES) {
			await reader.cancel();
			throw new RequestBodyTooLargeError();
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return JSON.parse(new TextDecoder().decode(bytes));
}
