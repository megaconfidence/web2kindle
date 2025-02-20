import send from './email';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

type Payload = {
	url: string;
	email: string;
};

export class Workflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Payload>, step: WorkflowStep) {
		const { url, email } = event.payload;
		const isArticleCached = await step.do('check for article in cache', async () => {
			const cache = await this.env.ARTICLE_CACHE.list({ prefix: url });
			if (cache.keys.length > 0) return true;
			return false;
		});
		if (!isArticleCached) {
			await step.do('render article and cache', async () => {
				const id = this.env.BROWSER_CONTROLLER.idFromName('rendering_browser');
				const obj = this.env.BROWSER_CONTROLLER.get(id);
				await obj.renderAndCache(url);
			});
		}
		const status = await step.do('send article via email', async () => {
			let article = await this.env.ARTICLE_CACHE.get(url, { type: 'arrayBuffer' });
			return await send(this.env, email, article!, url);
		});
	}
}
