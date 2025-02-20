import puppeteer from '@cloudflare/puppeteer';
import { clickCmp } from 'puppeteer-cmp-clicker';
import { DurableObject } from 'cloudflare:workers';

const ALIVE_TIME = 60 * 10; //10 mins

export class BrowserController extends DurableObject {
	env: Env;
	storage: any;
	browser: any;
	timer: number;
	constructor(ctx: any, env: Env) {
		super(ctx, env);
		this.ctx = ctx;
		this.env = env;
		this.timer = 0;
		this.browser = null;
		this.storage = this.ctx.storage;
	}
	async renderAndCache(url: string) {
		this.timer = 0; //reset timer at each run

		//reuse cached browser connection
		if (!this.browser || !this.browser.isConnected()) {
			console.log(`starting new browser instance`);
			try {
				this.browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: 60 * 10 * 1000 }); //10 mins
			} catch (e) {
				console.log(e);
			}
		}

		//render article
		const page = await this.browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });
		await clickCmp({ page });

		const pdf = await page.pdf({
			format: 'letter',
			printBackground: true,
		});
		await page.close();

		await this.env.ARTICLE_CACHE.put(url, pdf, {
			expirationTtl: 60 * 60 * 24 * 7,
		});

		this.timer = 0; //reset timer after each run

		if ((await this.storage.getAlarm()) == null) {
			console.log(`setting new alarm`);
			await this.storage.setAlarm(Date.now() + 10 * 1000);
		}
	}
	async alarm() {
		this.timer += 10;
		if (this.timer < ALIVE_TIME) {
			console.log(`alive for ${this.timer} seconds, extending`);
			await this.storage.setAlarm(Date.now() + 10 * 1000);
		} else {
			console.log(`exceeded life of ${ALIVE_TIME} seconds, exiting`);
			if (this.browser) await this.browser.close();
		}
	}
}
