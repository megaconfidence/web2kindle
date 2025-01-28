import puppeteer from '@cloudflare/puppeteer';
import { clickCmp } from 'puppeteer-cmp-clicker';
import { Resend } from 'resend';
// TODO:
// ✅1. Get pdf rendering working with browser rendering
// ✅2. Use email routing to deliver pdf
// 3. Cache pdf in kv for a week
// 4. Move implementation to workflows for async
// 5. Keep remote browser alive with DO
// 6. Can I use queues?
interface Body {
	url: string;
	email: string;
}
interface Env {
	BROWSER: Fetcher;
	RESEND_KEY: string;
	FROM_EMAIL: string;
}

export default {
	async fetch(request, env): Promise<Response> {
		const { url, email } = (await request.json()) as Body;
		if (request.method !== 'POST' || !url || !email) return new Response('invalid request', { status: 400 });

		//pdf rendering
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

		//email sending
		const resend = new Resend(env.RESEND_KEY);
		const data = await resend.emails.send({
			from: env.FROM_EMAIL,
			to: email,
			subject: 'New Webpage Order Just Got Delivered! 🚚',
			text: `Hey there, here's your freshly baked webpage from web2kindle. Enjoy! \n\n Generated from ${url}`,
			attachments: [{ content: pdfBytes, filename: 'webpage.pdf' }],
		});
		console.log(JSON.stringify(data));

		return new Response(pdfBytes, { headers: { 'Content-Type': 'application/pdf' } });
	},
} satisfies ExportedHandler<Env>;
