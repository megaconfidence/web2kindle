// TODO:
// ✅1. Get pdf rendering working with browser rendering
// ✅2. Use email routing to deliver pdf
// ✅3. Cache pdf in kv for a week
// ✅4. Move implementation to workflows for async
// ✅5. Keep remote browser alive with DO
// 6. Can I use queues?

export { BrowserController } from './browser';
export { Workflow } from './workflow';

export default {
	async fetch(request, env): Promise<Response> {
		if (new URL(request.url).pathname !== '/send') {
			return new Response('invalid endpoint', { status: 400 });
		}
		let { url, email } = (await request.json()) as Data;

		if (request.method !== 'POST' || !url || !email) {
			return new Response('invalid request', { status: 400 });
		}

		url = new URL(url).toString(); //normalize
		let workflow = await env.WORKFLOW.create({ params: { url, email } });

		return Response.json({
			id: workflow.id,
			details: await workflow.status(),
		});
	},
} satisfies ExportedHandler<Env>;
