import puppeteer, { type Browser } from '@cloudflare/puppeteer';
import { clickCmp } from 'puppeteer-cmp-clicker';
import { DurableObject } from 'cloudflare:workers';
import { getArticleCacheKey, isAllowedSourceUrl, type ArticleFormat } from './article';
import { createEpub, MAX_HTML_CHARS } from './epub';

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
				await clickCmp({ page });

				const renderedUrl = page.url();
				if (!isAllowedSourceUrl(renderedUrl)) throw new Error('The page redirected to a disallowed URL');

				let article: Uint8Array;
				if (format === 'epub') {
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
