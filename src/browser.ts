import puppeteer, { type Browser } from '@cloudflare/puppeteer';
import { DurableObject } from 'cloudflare:workers';
import { dismissConsent } from './consent';
import { getArticleCacheKey, isAllowedSourceUrl, type ArticleFormat } from './article';
import { createEpub, MAX_DATA_IMAGE_PAYLOAD_CHARS, MAX_EMBEDDED_IMAGE_BYTES, MAX_HTML_CHARS } from './epub';
import { waitForPageImages } from './page-images';

const ALIVE_TIME = 60 * 10;
const CACHE_TTL = 60 * 60 * 24 * 7;

export class BrowserController extends DurableObject<Env> {
	private browser: Browser | null = null;
	private browserLaunch: Promise<Browser> | null = null;
	private timer = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async renderAndCache(url: string, format: ArticleFormat): Promise<void> {
		this.timer = 0;

		const browser = await this.getBrowser();
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			try {
				await page.goto(url, { waitUntil: 'networkidle2' });
				// Validate before running any page script, because a redirect may have left the allowed origin.
				if (!isAllowedSourceUrl(page.url())) throw new Error('The page redirected to a disallowed URL');

				const dismissed = await dismissConsent(page);
				await waitForPageImages(page, format === 'pdf' ? 'print' : undefined);
				// Consent platforms often only appear once the page has settled, which is after the first attempt.
				const lateDismissed = await dismissConsent(page, 1);
				console.log(JSON.stringify({ message: 'dismissed cookie banners', url, dismissed, lateDismissed }));

				const renderedUrl = page.url();
				// Consent clicks and lazy-loading can navigate, so the captured page is re-checked here.
				if (!isAllowedSourceUrl(renderedUrl)) throw new Error('The page redirected to a disallowed URL');

				let article: Uint8Array;
				if (format === 'epub') {
					await page.evaluate(`(() => {
					const parseSrcsetUrls = (value) => {
						if (!value) return [];
						const urls = [];
						let position = 0;
						while (position < value.length) {
							while (position < value.length && /[\\s,]/.test(value[position])) position += 1;
							const start = position;
							while (position < value.length && !/\\s/.test(value[position])) position += 1;
							let url = value.slice(start, position);
							if (!url) break;
							if (url.endsWith(',')) url = url.replace(/,+$/, '');
							else while (position < value.length && value[position] !== ',') position += 1;
							if (value[position] === ',') position += 1;
							if (url) urls.push(url);
						}
						return urls;
					};
					const resolveRemote = (candidate) => {
						if (!candidate || candidate.toLowerCase().startsWith('data:')) return null;
						try {
							const url = new URL(candidate, document.baseURI);
							return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
						} catch {
							return null;
						}
					};
					for (const image of document.images) {
						const source = image.currentSrc;
						if (!source) continue;
						const comma = source.indexOf(',');
						const metadata = comma > 0 && comma <= 128 ? source.slice(5, comma).toLowerCase().split(';') : [];
						const dataType = metadata[0];
						const payload = comma > 0 ? source.slice(comma + 1) : '';
						const encoded = payload.replace(/\\s/g, '');
						const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
						const decodedBytes = Math.floor((encoded.length * 3) / 4) - padding;
						const isEmbeddableData =
							['image/gif', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(dataType) &&
							metadata.includes('base64') &&
							payload.length <= ${MAX_DATA_IMAGE_PAYLOAD_CHARS} &&
							encoded.length % 4 !== 1 &&
							/^[a-z0-9+/]*={0,2}$/i.test(encoded) &&
							decodedBytes <= ${MAX_EMBEDDED_IMAGE_BYTES} &&
							image.complete &&
							image.naturalWidth > 0;
						if (isEmbeddableData) {
							const pictureSources = image.parentElement?.tagName === 'PICTURE'
								? Array.from(image.parentElement.querySelectorAll('source'))
								: [];
							const responsiveCandidates = [image.getAttribute('srcset'), image.getAttribute('data-srcset'), ...pictureSources.flatMap((pictureSource) => [pictureSource.getAttribute('srcset'), pictureSource.getAttribute('data-srcset')])]
								.flatMap(parseSrcsetUrls);
							const fallback = [
								...['src', 'data-src', 'data-original', 'data-lazy-src'].map((attribute) => image.getAttribute(attribute)),
								...responsiveCandidates,
							].map(resolveRemote).find(Boolean);
							if (fallback) image.setAttribute('data-epub-fallback-src', fallback);
							image.setAttribute('src', source);
							for (const attribute of ['srcset', 'data-srcset', 'data-src', 'data-original', 'data-lazy-src']) {
								image.removeAttribute(attribute);
							}
							for (const pictureSource of pictureSources) pictureSource.remove();
						} else if (!source.toLowerCase().startsWith('data:')) {
							image.setAttribute('data-epub-src', source);
						}
					}
					})()`);
					const htmlLength = await page.evaluate('document.documentElement.outerHTML.length');
					if (typeof htmlLength !== 'number' || htmlLength > MAX_HTML_CHARS) {
						throw new Error('The rendered page is too large to convert to EPUB');
					}
					article = await createEpub(await page.content(), renderedUrl);
				} else {
					article = await page.pdf({ format: 'letter', printBackground: true });
				}

				const cacheKey = await getArticleCacheKey(url, format);
				await this.env.ARTICLE_CACHE.put(cacheKey, article, { expirationTtl: CACHE_TTL });
			} finally {
				await page.close();
			}
		} finally {
			await context.close();
		}

		this.timer = 0;

		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + 10 * 1000);
		}
	}

	private async getBrowser(): Promise<Browser> {
		if (this.browser?.isConnected()) return this.browser;

		if (!this.browserLaunch) {
			console.log(JSON.stringify({ message: 'starting browser instance' }));
			this.browserLaunch = puppeteer.launch(this.env.BROWSER, { keep_alive: ALIVE_TIME * 1000 });
		}

		try {
			this.browser = await this.browserLaunch;
			return this.browser;
		} finally {
			this.browserLaunch = null;
		}
	}

	async alarm(): Promise<void> {
		this.timer += 10;
		if (this.timer < ALIVE_TIME) {
			await this.ctx.storage.setAlarm(Date.now() + 10 * 1000);
		} else {
			if (this.browser) {
				await this.browser.close();
				this.browser = null;
			}
		}
	}
}
