import { Resend, type CreateEmailResponseSuccess } from 'resend';
import slugify from '@sindresorhus/slugify';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ArticleFormat } from './article';

export default async function send(
	env: Env,
	email: string,
	article: ArrayBuffer,
	url: string,
	format: ArticleFormat,
	idempotencyKey: string,
): Promise<CreateEmailResponseSuccess> {
	const resend = new Resend(env.RESEND_KEY);
	const source = new URL(url);
	const baseName = slugify(`${source.hostname}${source.pathname}`).slice(0, 120) || 'article';
	const contentType = format === 'epub' ? 'application/epub+zip' : 'application/pdf';

	const result = await resend.emails.send(
		{
			from: env.FROM_EMAIL,
			to: email,
			subject: `Your Web2Kindle ${format.toUpperCase()} is ready`,
			text: `Your webpage is ready to read on Kindle.\n\nGenerated from ${url}`,
			attachments: [{ content: Buffer.from(article), filename: `${baseName}.${format}`, contentType }],
		},
		{ idempotencyKey },
	);

	if (result.error) {
		const message = `Email delivery failed: ${result.error.message}`;
		const status = result.error.statusCode;
		if (status !== null && status >= 400 && status < 500 && ![408, 409, 429].includes(status)) {
			throw new NonRetryableError(message);
		}
		throw new Error(message);
	}

	return result.data;
}
