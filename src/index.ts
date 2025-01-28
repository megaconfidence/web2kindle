import puppeteer from '@cloudflare/puppeteer';
import { clickCmp } from 'puppeteer-cmp-clicker';

// TODO:
// ✅1. Get pdf rendering working with browser rendering
// 2. Use email routing to deliver pdf
// 3. Cache pdf in kv for a week
// 4. Move implementation to workflows for async
// 5. Keep remote browser alive with DO
// 6. Can I use queues?

interface Body {
	url: string;
}
interface Env {
	BROWSER: Fetcher;
}
export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const { url } = (await request.json()) as Body;
		if (request.method !== 'POST' || !url) return new Response('invalid request', { status: 400 });
		const browser = await puppeteer.launch(env.BROWSER);
		const page = await browser.newPage();
		await page.goto(url, {
			waitUntil: 'networkidle2',
		});
		await clickCmp({ page });
		const pdfBytes = await page.pdf({
			format: 'letter',
			printBackground: true,
		});

		await browser.close();
		return new Response(pdfBytes, { headers: { 'Content-Type': 'application/pdf' } });
	},
} satisfies ExportedHandler<Env>;
