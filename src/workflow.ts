import send from './email';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { getArticleCacheKey, type ArticleFormat } from './article';

type Payload = {
	url: string;
	email: string;
	format: ArticleFormat;
};

export class Workflow extends WorkflowEntrypoint<Env, Payload> {
	async run(event: WorkflowEvent<Payload>, step: WorkflowStep) {
		const { url, email, format } = event.payload;
		const cacheKey = await getArticleCacheKey(url, format);
		const isArticleCached = await step.do('check for article in cache', async () => {
			const cache = await this.env.ARTICLE_CACHE.list({ prefix: cacheKey, limit: 1 });
			return cache.keys.some((key) => key.name === cacheKey);
		});
		if (!isArticleCached) {
			await step.do('render article and cache', async () => {
				const id = this.env.BROWSER_CONTROLLER.idFromName('rendering_browser');
				const obj = this.env.BROWSER_CONTROLLER.get(id);
				await obj.renderAndCache(url, format);
			});
		}
		return step.do('send article via email', async () => {
			const article = await this.env.ARTICLE_CACHE.get(cacheKey, { type: 'arrayBuffer' });
			if (!article) throw new Error('The rendered article was not found in the cache');
			return send(this.env, email, article, url, format, `web2kindle/${event.instanceId}`);
		});
	}
}
