import puppeteer from '@cloudflare/puppeteer';
import { clickCmp } from 'puppeteer-cmp-clicker';
import { DurableObject } from 'cloudflare:workers';

const KEEP_CONTROLLER_ALIVE_IN_SECONDS = 60 * 10; //10 mins

export class BrowserController extends DurableObject {
	env: Env;
	storage: any;
	browser: any;
	keptAliveInSeconds: number;
	constructor(ctx: any, env: Env) {
		super(ctx, env);
		this.ctx = ctx;
		this.env = env;
		this.browser = null;
		this.keptAliveInSeconds = 0;
		this.storage = this.ctx.storage;
	}
	async renderAndCache(url: string) {
		//reuse cached browser connection
		if (!this.browser || !this.browser.isConnected()) {
			console.log(`browser controller: starting new instance`);
			try {
				this.browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: 60 * 10 * 1000 }); //10 mins
			} catch (e) {
				console.log(`browser controller: error starting new instance\n\n${e}`);
			}
		}

		//reset keptAlive after each call
		this.keptAliveInSeconds = 0;

		//render pdf
		const page = await this.browser.newPage();
		await page.goto(url, {
			waitUntil: 'networkidle2',
		});
		await clickCmp({ page });
		const pdf = await page.pdf({
			format: 'letter',
			printBackground: true,
		});
		await page.close();

		await this.env.PDF_CACHE.put(url, pdf, {
			expirationTtl: 60 * 60 * 24 * 7,
		});

		//reset keptAlive after performing tasks
		this.keptAliveInSeconds = 0;

		//set the first alarm to keep controller alive
		let currentAlarm = await this.storage.getAlarm();
		if (currentAlarm == null) {
			console.log(`browser controller: setting alarm`);
			await this.storage.setAlarm(Date.now() + 10 * 1000);
		}
	}
	async alarm() {
		this.keptAliveInSeconds += 10;

		// extend browser controller life
		if (this.keptAliveInSeconds < KEEP_CONTROLLER_ALIVE_IN_SECONDS) {
			console.log(`browser controller: has been kept alive for ${this.keptAliveInSeconds} seconds. extending lifespan`);
			await this.storage.setAlarm(Date.now() + 10 * 1000);
		} else {
			console.log(`browser controller: exceeded life of ${KEEP_CONTROLLER_ALIVE_IN_SECONDS}s`);
			if (this.browser) {
				console.log(`browser controller: closing browser`);
				await this.browser.close();
			}
		}
	}
}
