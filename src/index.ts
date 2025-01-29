import send from './email';

// TODO:
// ✅1. Get pdf rendering working with browser rendering
// ✅2. Use email routing to deliver pdf
// ✅3. Cache pdf in kv for a week
// 4. Move implementation to workflows for async
// ✅5. Keep remote browser alive with DO
// 6. Can I use queues?

interface Body {
	url: string;
	email: string;
}

export { BrowserController } from './browser';

export default {
	async fetch(request, env): Promise<Response> {
		let { url, email } = (await request.json()) as Body;
		if (request.method !== 'POST' || !url || !email) return new Response('invalid request', { status: 400 });

		url = new URL(url).toString();

		let pdf = await env.PDF_CACHE.get(url, { type: 'arrayBuffer' });
		pdf = new Uint8Array(pdf!);

		//pdf rendering

		const id = env.BROWSER_CONTROLLER.idFromName('browser_controller');
		const obj = env.BROWSER_CONTROLLER.get(id);

		if (pdf.byteLength == 0) {
			console.log('pdf not found in cache. rendering new pdf');
			pdf = await obj.render(url);

			await env.PDF_CACHE.put(url, pdf!, {
				expirationTtl: 60 * 60 * 24 * 7,
			});
		}

		//email sending
		const status = await send(env, email, pdf!, url);
		console.log(JSON.stringify(status));

		return new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } });
	},
} satisfies ExportedHandler<Env>;
