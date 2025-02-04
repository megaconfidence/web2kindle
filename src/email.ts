import { CreateEmailResponseSuccess, ErrorResponse, Resend } from 'resend';
import slugify from '@sindresorhus/slugify';

interface EmailStatus {
	data: CreateEmailResponseSuccess | null;
	error: ErrorResponse | null;
}

export default async function send(env: Env, email: string, pdf: ArrayBuffer, url: string): Promise<EmailStatus> {
	const resend = new Resend(env.RESEND_KEY);
	return resend.emails.send({
		from: env.FROM_EMAIL,
		to: email,
		subject: 'New Webpage Order Just Got Delivered! 🚚',
		text: `Hey there, here's your freshly baked webpage from web2kindle. Enjoy! \n\n Generated from ${url}`,
		attachments: [{ content: Buffer.from(pdf), filename: slugify(url) }],
	});
}
